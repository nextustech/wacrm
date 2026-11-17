/**
 * Baileys session manager.
 *
 * One long-lived WhatsApp socket per WACRM session id. Auth credentials are
 * persisted per session under config.authDir so a worker restart reconnects
 * without a new QR scan.
 */
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Boom } from '@hapi/boom';
import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import { config } from './config.js';
import { logger } from './logger.js';
import { emit } from './webhook.js';

/** sessionId -> { sock, status, qr, qrExpiresAt, workspaceId, meta, sends } */
const sessions = new Map();

const QR_TTL_MS = 60_000;

/** Reconnect delays for a dropped socket, in ms. Caps rather than gives up. */
const RECONNECT_BACKOFF_MS = [3_000, 10_000, 30_000, 60_000, 120_000];

/** Written next to the Baileys credentials so a restart knows the tenant. */
const SESSION_META_FILE = 'wacrm-session.json';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Re-open every session that has credentials on disk.
 *
 * The sessions live in memory, so before this a worker restart (a deploy, a
 * crash, `pm2 reload`) left every connected number silently offline: the
 * credentials were still on disk, but nothing opened a socket until someone
 * pressed reconnect in the UI. Inbound messages in that window were lost.
 */
export async function restoreSessions() {
  let dirs;
  try {
    dirs = await readdir(config.authDir, { withFileTypes: true });
  } catch {
    return 0; // No auth directory yet — nothing has ever connected.
  }

  let restored = 0;
  for (const dirent of dirs) {
    if (!dirent.isDirectory() || !UUID_RE.test(dirent.name)) continue;
    const dir = path.join(config.authDir, dirent.name);
    try {
      // Without creds.json the folder is a half-finished scan, not a session.
      await readFile(path.join(dir, 'creds.json'), 'utf8');
      const meta = JSON.parse(await readFile(path.join(dir, SESSION_META_FILE), 'utf8'));
      if (!UUID_RE.test(meta?.workspace_id ?? '')) continue;
      await startSession(dirent.name, meta.workspace_id);
      restored += 1;
    } catch (err) {
      logger.warn({ sessionId: dirent.name, err: String(err) }, 'could not restore session');
    }
  }
  if (restored > 0) logger.info({ restored }, 'sessions restored from disk');
  return restored;
}

export function getSession(sessionId) {
  return sessions.get(sessionId) ?? null;
}

export function listSessions() {
  return [...sessions.entries()].map(([id, s]) => ({
    session_id: id,
    workspace_id: s.workspaceId,
    status: s.status,
    phone_number: s.meta.phone_number ?? null,
  }));
}

function authPath(sessionId) {
  // sessionId is validated as a UUID by the route layer before reaching here.
  return path.join(config.authDir, sessionId);
}

function toJid(phone) {
  const digits = String(phone).replace(/[^\d]/g, '');
  return `${digits}@s.whatsapp.net`;
}

/** Statuses that mean "a socket is already working on it, leave it alone". */
const LIVE_STATUSES = new Set(['pending', 'awaiting_scan', 'scanned', 'connected']);

export async function startSession(sessionId, workspaceId, { reconnect = false } = {}) {
  const existing = sessions.get(sessionId);
  // `reconnect` is the internal retry path. Without it this guard also
  // swallowed the retry — a dropped socket is left at 'connecting', which is
  // not 'disconnected' or 'error', so the scheduled restart returned here and
  // the session stayed dead until someone restarted the worker by hand.
  if (!reconnect && existing && LIVE_STATUSES.has(existing.status)) {
    return { worker_session_id: sessionId };
  }

  const dir = authPath(sessionId);
  await mkdir(dir, { recursive: true });
  // Baileys persists the credentials but not which workspace they belong to,
  // and the worker needs that to address webhooks after a restart.
  await writeFile(
    path.join(dir, SESSION_META_FILE),
    JSON.stringify({ workspace_id: workspaceId }),
  ).catch(() => {});

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  // Reuse the entry across reconnects so the idempotency records survive;
  // dropping them would let a retried send deliver the message twice.
  const entry = existing ?? {
    sends: new Map(), // client_message_id -> { message_id, status, at }
  };
  Object.assign(entry, {
    sock: null,
    status: 'pending',
    qr: null,
    qrExpiresAt: null,
    workspaceId,
    meta: entry.meta ?? {},
    closing: false,
  });

  // Detach the previous socket before replacing it, or its listeners keep
  // firing against this entry and events arrive twice.
  if (existing?.sock) {
    try {
      existing.sock.ev.removeAllListeners?.();
      existing.sock.end?.(undefined);
    } catch {
      /* already gone */
    }
  }
  sessions.set(sessionId, entry);

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    browser: ['WACRM', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  entry.sock = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      entry.qr = qr;
      entry.status = 'awaiting_scan';
      entry.qrExpiresAt = new Date(Date.now() + QR_TTL_MS).toISOString();
      emit(sessionId, workspaceId, 'session.qr_updated', { qr_expires_at: entry.qrExpiresAt });
    }

    if (connection === 'connecting' && entry.status === 'awaiting_scan' && !qr) {
      entry.status = 'scanned';
      entry.qr = null;
      emit(sessionId, workspaceId, 'session.scanned', {});
    }

    if (connection === 'open') {
      entry.status = 'connected';
      entry.qr = null;
      entry.qrExpiresAt = null;
      entry.retries = 0;
      entry.error = null;
      entry.meta = {
        phone_number: sock.user?.id ? `+${sock.user.id.split(':')[0]}` : null,
        display_name: sock.user?.name ?? null,
        device_platform: 'whatsapp-web',
      };
      emit(sessionId, workspaceId, 'session.connected', entry.meta);
      logger.info({ sessionId }, 'session connected');
    }

    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      const loggedOut = code === DisconnectReason.loggedOut;

      if (entry.closing || loggedOut) {
        entry.status = 'disconnected';
        emit(sessionId, workspaceId, 'session.disconnected', {
          reason: loggedOut ? 'logged_out' : 'revoked',
        });
        sessions.delete(sessionId);
        if (loggedOut) rm(dir, { recursive: true, force: true }).catch(() => {});
        return;
      }

      // Transient drop — Baileys needs a fresh socket, reconnect with backoff.
      entry.status = 'connecting';
      entry.retries = (entry.retries ?? 0) + 1;
      const delay = RECONNECT_BACKOFF_MS[
        Math.min(entry.retries - 1, RECONNECT_BACKOFF_MS.length - 1)
      ];
      logger.warn({ sessionId, code, attempt: entry.retries, delay }, 'connection closed, reconnecting');
      setTimeout(() => {
        // Nothing to do if the session was revoked while we were waiting.
        if (sessions.get(sessionId) !== entry || entry.closing) return;
        startSession(sessionId, workspaceId, { reconnect: true }).catch((err) => {
          entry.status = 'error';
          entry.error = String(err);
          emit(sessionId, workspaceId, 'session.error', { error: String(err) });
        });
      }, delay).unref?.();
    }
  });

  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const m = msg.message ?? {};
      const text =
        m.conversation ??
        m.extendedTextMessage?.text ??
        m.imageMessage?.caption ??
        m.videoMessage?.caption ??
        null;
      let msgType = 'text';
      if (m.imageMessage) msgType = 'image';
      else if (m.videoMessage) msgType = 'video';
      else if (m.audioMessage) msgType = 'audio';
      else if (m.documentMessage) msgType = 'document';
      const contextInfo = m.extendedTextMessage?.contextInfo
        ?? m.imageMessage?.contextInfo
        ?? m.videoMessage?.contextInfo
        ?? m.audioMessage?.contextInfo
        ?? m.documentMessage?.contextInfo;

      emit(sessionId, workspaceId, 'message.received', {
        from: `+${(msg.key.remoteJid || '').split('@')[0]}`,
        type: msgType,
        text,
        media_url: null,
        waba_message_id: msg.key.id,
        message_id: msg.key.id,
        context_message_id: contextInfo?.stanzaId ?? null,
        timestamp: Number(msg.messageTimestamp || Math.floor(Date.now() / 1000)),
      });
    }
  });

  sock.ev.on('messages.update', (updates) => {
    const map = { 1: 'sent', 2: 'sent', 3: 'delivered', 4: 'read', 5: 'read', 0: 'failed' };
    for (const u of updates) {
      const status = map[u.update?.status];
      if (!status) continue;
      emit(sessionId, workspaceId, 'message.status', {
        waba_message_id: u.key?.id,
        message_id: u.key?.id,
        status,
        error: null,
      });
    }
  });

  return { worker_session_id: sessionId };
}

export function readQr(sessionId) {
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  const expired = entry.qrExpiresAt && Date.parse(entry.qrExpiresAt) < Date.now();
  return {
    qr: expired ? null : entry.qr,
    status: entry.status,
    phone_number: entry.meta.phone_number ?? null,
    display_name: entry.meta.display_name ?? null,
    device_platform: entry.meta.device_platform ?? null,
    error: entry.error ?? null,
  };
}

export async function revokeSession(sessionId) {
  const entry = sessions.get(sessionId);
  if (entry) {
    entry.closing = true;
    try {
      await entry.sock?.logout();
    } catch {
      try {
        entry.sock?.end?.(undefined);
      } catch {
        /* socket already gone */
      }
    }
    sessions.delete(sessionId);
  }
  await rm(authPath(sessionId), { recursive: true, force: true }).catch(() => {});
  return { ok: true };
}

/** Idempotent send — repeats of the same client_message_id never resend. */
export async function sendMessage(sessionId, payload) {
  const entry = sessions.get(sessionId);
  if (!entry || entry.status !== 'connected') {
    const err = new Error('Session not connected');
    err.status = 409;
    throw err;
  }

  const key = payload.client_message_id;
  const prior = entry.sends.get(key);
  if (prior) return { message_id: prior.message_id, status: prior.status };

  const jid = toJid(payload.to);
  let content;
  switch (payload.type) {
    case 'image':
      content = { image: { url: payload.media_url }, caption: payload.caption ?? undefined };
      break;
    case 'video':
      content = { video: { url: payload.media_url }, caption: payload.caption ?? undefined };
      break;
    case 'audio':
      content = { audio: { url: payload.media_url }, mimetype: 'audio/mp4' };
      break;
    case 'document':
      content = {
        document: { url: payload.media_url },
        fileName: payload.caption || 'document',
      };
      break;
    default:
      content = { text: payload.text ?? '' };
  }

  const sent = await entry.sock.sendMessage(jid, content);
  const result = { message_id: sent?.key?.id ?? key, status: 'queued', at: Date.now() };
  entry.sends.set(key, result);

  // Prune the dedupe map beyond the retention window.
  for (const [k, v] of entry.sends) {
    if (Date.now() - v.at > config.dedupeTtlMs) entry.sends.delete(k);
  }

  return { message_id: result.message_id, status: result.status };
}
