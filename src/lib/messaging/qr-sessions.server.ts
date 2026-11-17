/**
 * Server-only helpers for the QR WhatsApp login worker.
 *
 * Kept out of *.functions.ts so those files stay thin server-function
 * wrappers (module scope there must only hold imports + declarations).
 *
 * This module used to carry its own `callWorker` that sent the bearer token
 * and nothing else. The worker rejects any request without
 * `X-WACRM-Timestamp` and `X-WACRM-Signature`, so every QR operation the UI
 * performed answered 401 — while `/health`, the one unauthenticated route,
 * kept reporting the worker as reachable. There is now a single signed client.
 */
export { callWorker, WorkerAPI, type WorkerCallResult } from "./qr-worker.server";
