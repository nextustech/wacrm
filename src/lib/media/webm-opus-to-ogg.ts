/**
 * Repackage a Chrome/Edge `audio/webm;codecs=opus` recording as `audio/ogg`.
 *
 * Why this exists: `MediaRecorder` in Chromium cannot produce Ogg. It produces
 * WebM. WhatsApp (and the app's own channel rules in `channel-attachments.ts`)
 * accept `audio/ogg` and refuse `audio/webm`, so every voice note recorded in
 * Chrome was rejected *after* the user had finished speaking and thrown away.
 *
 * No re-encoding happens here and none is needed: WebM and Ogg are both just
 * containers, and the audio inside a Chromium recording is already Opus — the
 * exact codec Ogg/Opus wants. This walks the WebM (Matroska/EBML) structure,
 * lifts the Opus packets out of the SimpleBlocks, and writes them into Ogg
 * pages with the two Opus headers (OpusHead / OpusTags) RFC 7845 requires.
 *
 * Browser-only (uses no Node APIs), dependency-free, and synchronous.
 */

/* ───────────────────────────── EBML reading ───────────────────────────── */

class Reader {
  constructor(
    readonly buf: Uint8Array,
    public pos = 0,
  ) {}
  get done() {
    return this.pos >= this.buf.length;
  }
  /** Element id, kept with its length marker — ids are compared as numbers. */
  readId(): number {
    const first = this.buf[this.pos];
    if (first === undefined) throw new Error("EBML: truncated id");
    const length = 8 - Math.floor(Math.log2(first));
    if (length < 1 || length > 4) throw new Error("EBML: bad id length");
    let id = 0;
    for (let i = 0; i < length; i += 1) id = id * 256 + (this.buf[this.pos + i] ?? 0);
    this.pos += length;
    return id;
  }
  /** Element size. `null` means "unknown size" (streamed WebM uses this). */
  readSize(): number | null {
    const first = this.buf[this.pos];
    if (first === undefined) throw new Error("EBML: truncated size");
    const length = 8 - Math.floor(Math.log2(first));
    if (length < 1 || length > 8) throw new Error("EBML: bad size length");
    let value = first & ((1 << (8 - length)) - 1);
    let allOnes = value === (1 << (8 - length)) - 1;
    for (let i = 1; i < length; i += 1) {
      const byte = this.buf[this.pos + i] ?? 0;
      if (byte !== 0xff) allOnes = false;
      value = value * 256 + byte;
    }
    this.pos += length;
    return allOnes ? null : value;
  }
}

/** Matroska ids, as the integers `readId` produces (length marker included). */
const ID = {
  Segment: 0x18538067,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackNumber: 0xd7,
  CodecID: 0x86,
  Cluster: 0x1f43b675,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  CodecPrivate: 0x63a2,
} as const;

/** Elements whose children must be walked rather than skipped. */
const CONTAINERS = new Set<number>([
  ID.Segment,
  ID.Tracks,
  ID.TrackEntry,
  ID.Cluster,
  ID.BlockGroup,
]);

const uintOf = (bytes: Uint8Array): number => bytes.reduce((acc, b) => acc * 256 + b, 0);
const asciiOf = (bytes: Uint8Array): string => String.fromCharCode(...bytes).replace(/\0+$/, "");

/**
 * Every Opus packet in the file, in order, plus the track it came from.
 * A WebM SimpleBlock payload is a whole Opus packet for an audio track.
 */
export type WebmOpusTrack = {
  packets: Uint8Array[];
  /** The encoder's own OpusHead, from CodecPrivate — authoritative when present. */
  codecPrivate: Uint8Array | null;
  channels: number;
};

export function extractOpusPackets(webm: Uint8Array): Uint8Array[] {
  return extractOpusTrack(webm).packets;
}

export function extractOpusTrack(webm: Uint8Array): WebmOpusTrack {
  const r = new Reader(webm);
  const packets: Uint8Array[] = [];
  let opusTrack: number | null = null;
  const found: { head: Uint8Array | null } = { head: null };
  let currentTrack: number | null = null;
  let currentCodec: string | null = null;
  let currentPrivate: Uint8Array | null = null;

  const walk = (end: number) => {
    while (r.pos < end && !r.done) {
      const id = r.readId();
      const size = r.readSize();
      // Unknown-size elements (live WebM) run to the end of their parent.
      const stop = size === null ? end : Math.min(end, r.pos + size);

      if (CONTAINERS.has(id)) {
        if (id === ID.TrackEntry) {
          currentTrack = null;
          currentCodec = null;
          currentPrivate = null;
        }
        walk(stop);
        if (id === ID.TrackEntry && currentCodec?.startsWith("A_OPUS") && currentTrack !== null) {
          opusTrack = currentTrack;
          found.head = currentPrivate;
        }
        r.pos = stop;
        continue;
      }

      const body = webm.subarray(r.pos, stop);
      if (id === ID.TrackNumber) currentTrack = uintOf(body);
      else if (id === ID.CodecID) currentCodec = asciiOf(body);
      // CodecPrivate holds the encoder own OpusHead: correct channel count,
      // pre-skip and input sample rate. Guessing those produces a file that
      // plays but reports the wrong length, or none at all.
      else if (id === ID.CodecPrivate) currentPrivate = body.slice();
      else if (id === ID.SimpleBlock || id === ID.Block) {
        // SimpleBlock: track number (vint) + 2-byte timecode + 1 flag byte.
        const sub = new Reader(body);
        const track = sub.readSize();
        const header = sub.pos + 3;
        if (header <= body.length && (opusTrack === null || track === opusTrack)) {
          const payload = body.subarray(header);
          if (payload.length > 0) packets.push(payload);
        }
      }
      r.pos = stop;
    }
  };

  walk(webm.length);
  // Assigned inside the recursive walk, which the compiler's flow analysis
  // cannot follow — read it back through the declared type.
  const head = found.head;
  // OpusHead layout: byte 9 is the channel count.
  const channels = head && head.length > 9 ? head[9] || 1 : 1;
  return { packets, codecPrivate: head, channels };
}

/* ───────────────────────────── Ogg writing ────────────────────────────── */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let r = i << 24;
    for (let j = 0; j < 8; j += 1)
      r = r & 0x80000000 ? ((r << 1) ^ 0x04c11db7) >>> 0 : (r << 1) >>> 0;
    table[i] = r >>> 0;
  }
  return table;
})();

/** Ogg's CRC-32: polynomial 0x04c11db7, no reflection, zero initial value. */
function oggCrc(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc >>> 0;
}

type Page = { packets: Uint8Array[]; granule: number; headerType: number; sequence: number };

function buildPage({ packets, granule, headerType, sequence }: Page, serial: number): Uint8Array {
  const segments: number[] = [];
  for (const packet of packets) {
    let remaining = packet.length;
    while (remaining >= 255) {
      segments.push(255);
      remaining -= 255;
    }
    segments.push(remaining);
  }
  if (segments.length > 255) throw new Error("Ogg: too many segments for one page");

  const body = packets.reduce((n, p) => n + p.length, 0);
  const page = new Uint8Array(27 + segments.length + body);
  const view = new DataView(page.buffer);

  page.set([0x4f, 0x67, 0x67, 0x53], 0); // "OggS"
  page[4] = 0; // stream structure version
  page[5] = headerType; // 0x02 first page, 0x04 last page
  // Granule position is 64-bit little-endian; Opus counts 48 kHz samples.
  view.setUint32(6, granule >>> 0, true);
  view.setUint32(10, Math.floor(granule / 0x100000000), true);
  view.setUint32(14, serial, true);
  view.setUint32(18, sequence, true);
  view.setUint32(22, 0, true); // CRC placeholder — filled in below
  page[26] = segments.length;
  page.set(segments, 27);

  let offset = 27 + segments.length;
  for (const packet of packets) {
    page.set(packet, offset);
    offset += packet.length;
  }

  view.setUint32(22, oggCrc(page), true);
  return page;
}

function opusHead(channels: number, preSkip: number, sampleRate: number): Uint8Array {
  const head = new Uint8Array(19);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // "OpusHead"
  head[8] = 1; // version
  head[9] = channels;
  new DataView(head.buffer).setUint16(10, preSkip, true);
  new DataView(head.buffer).setUint32(12, sampleRate, true);
  new DataView(head.buffer).setUint16(16, 0, true); // output gain
  head[18] = 0; // channel mapping family 0
  return head;
}

function opusTags(): Uint8Array {
  const vendor = new TextEncoder().encode("WACRM");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73], 0); // "OpusTags"
  const view = new DataView(tags.buffer);
  view.setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  view.setUint32(12 + vendor.length, 0, true); // zero user comments
  return tags;
}

/**
 * Samples (at 48 kHz) in one Opus packet, read from its TOC byte — RFC 6716.
 * Needed for the granule positions, which is what players use for duration
 * and seeking; a file with wrong granules shows as 0:00 even though it plays.
 */
export function opusPacketSamples(packet: Uint8Array): number {
  const toc = packet[0];
  if (toc === undefined) return 960;
  const config = toc >> 3;
  let frameMs: number;
  if (config < 12) frameMs = [10, 20, 40, 60][config % 4]!;
  else if (config < 16) frameMs = [10, 20][config % 2]!;
  else frameMs = [2.5, 5, 10, 20][config % 4]!;

  const code = toc & 0b11;
  let frames: number;
  if (code === 0) frames = 1;
  else if (code === 1 || code === 2) frames = 2;
  else frames = (packet[1] ?? 1) & 0b00111111 || 1;

  return Math.round(frameMs * 48 * frames);
}

/* ────────────────────────────── entry point ───────────────────────────── */

export type RemuxResult = { blob: Blob; packets: number; durationMs: number };

/**
 * Rewrap a WebM/Opus recording as Ogg/Opus. Returns `null` when the input is
 * not WebM-with-Opus, so callers can fall back to sending the original file.
 */
export function webmOpusToOgg(webm: Uint8Array, channels = 1): RemuxResult | null {
  let track: WebmOpusTrack;
  try {
    track = extractOpusTrack(webm);
  } catch {
    return null;
  }
  const packets = track.packets;
  if (packets.length === 0) return null;

  // Prefer the encoder's own header from CodecPrivate: it carries the real
  // channel count and pre-skip, and players subtract the pre-skip to work out
  // the duration. A guessed header is what makes a file report 0:00.
  const head =
    track.codecPrivate && track.codecPrivate.length >= 19
      ? track.codecPrivate
      : opusHead(track.channels || channels, 3840, 48000);

  const serial = (Math.random() * 0xffffffff) >>> 0;
  const pages: Uint8Array[] = [];
  let sequence = 0;

  // RFC 7845: the two headers each get their own page, granule 0.
  pages.push(
    buildPage(
      {
        packets: [head],
        granule: 0,
        headerType: 0x02,
        sequence: sequence++,
      },
      serial,
    ),
  );
  pages.push(
    buildPage(
      { packets: [opusTags()], granule: 0, headerType: 0x00, sequence: sequence++ },
      serial,
    ),
  );

  let granule = 0;
  // Up to 50 packets a page keeps the segment table inside its 255-byte limit
  // for ordinary 20 ms speech packets while staying efficient.
  const PER_PAGE = 50;
  for (let i = 0; i < packets.length; i += PER_PAGE) {
    const slice = packets.slice(i, i + PER_PAGE);
    for (const packet of slice) granule += opusPacketSamples(packet);
    const last = i + PER_PAGE >= packets.length;
    pages.push(
      buildPage(
        { packets: slice, granule, headerType: last ? 0x04 : 0x00, sequence: sequence++ },
        serial,
      ),
    );
  }

  const total = pages.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const page of pages) {
    out.set(page, offset);
    offset += page.length;
  }

  return {
    blob: new Blob([out], { type: "audio/ogg" }),
    packets: packets.length,
    durationMs: Math.round((granule / 48000) * 1000),
  };
}
