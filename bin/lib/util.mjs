// Small shared helpers: validation, text hygiene, and the error types the
// watcher uses to tell "retry" from "stop and tell the user".

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isGuid(value) {
  return typeof value === "string" && GUID.test(value);
}

// Control characters, line/paragraph separators and invisible direction marks.
// Anything that came from the network and ends up on a line a person reads
// goes through oneLine() first.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;

/** Collapse untrusted text to one printable line of at most `max` characters. */
export function oneLine(value, max) {
  const flat = String(value).replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  const chars = [...flat];
  return chars.length > max ? chars.slice(0, max).join("").trimEnd() : flat;
}

export function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * Parse an address the watcher may talk to: https, or http only for the local
 * machine. No credentials in the URL, no fragment. Returns a URL or throws.
 */
export function parseTrustedUrl(text, label) {
  let url;
  try {
    url = new URL(String(text));
  } catch {
    throw new WatcherError(`${label} is not a valid address`);
  }
  const secure = url.protocol === "https:";
  const localPlain = url.protocol === "http:" && isLoopbackHost(url.hostname);
  if (!secure && !localPlain) {
    throw new WatcherError(`${label} must use https (plain http is only allowed for localhost)`);
  }
  if (url.username || url.password) throw new WatcherError(`${label} must not contain credentials`);
  if (url.hash) throw new WatcherError(`${label} must not contain a fragment`);
  return url;
}

export function sameOrigin(a, b) {
  return new URL(a).origin === new URL(b).origin;
}

/** A short, secret-free description of a failed network call. */
export function describeNetworkError(error) {
  if (error && (error.name === "TimeoutError" || error.name === "AbortError")) return "timed out";
  const code = error && error.cause && typeof error.cause.code === "string" ? error.cause.code : null;
  if (code && /^[A-Z0-9_]{3,40}$/.test(code)) return code;
  return "network error";
}

/** The OAuth `error` code from a response body, only if it has the standard shape. */
export function oauthErrorCode(json) {
  const code = json && typeof json === "object" ? json.error : undefined;
  return typeof code === "string" && /^[a-z_]{1,40}$/.test(code) ? code : "unknown";
}

/** A problem with a message that is safe to show (it never carries a body, token or URL query). */
export class WatcherError extends Error {
  constructor(message) {
    super(message);
    this.name = "WatcherError";
  }
}

/** A failure that may succeed on retry (network, 5xx, a busy lock). */
export class TransientError extends WatcherError {
  constructor(message) {
    super(message);
    this.name = "TransientError";
  }
}

/**
 * The watcher cannot continue without the person signing in again. `line` is
 * the one stdout line a Monitor shows when the process ends (exit code 3).
 */
export class AuthFatalError extends WatcherError {
  constructor(line) {
    super(line);
    this.name = "AuthFatalError";
    this.line = line;
  }
}

/** The server refused to show this run to this sign-in (a 403 that is not a scope problem). */
export class AccessDeniedError extends WatcherError {
  constructor() {
    super("access denied");
    this.name = "AccessDeniedError";
  }
}
