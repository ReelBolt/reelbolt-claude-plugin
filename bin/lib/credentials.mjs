// The credential store: one private JSON file plus a lock file next to it.
//
// Rules this module enforces and never relaxes:
//   * the directory is 0700 and the file is 0600, owned by the current user;
//   * the file is replaced atomically (temp file created exclusively with mode
//     0600, fsync, rename), so it is never readable by anyone else, not even
//     for an instant;
//   * a file that is a symlink, group/other accessible, owned by someone else,
//     or malformed is refused with an instruction. Nothing is "fixed" silently;
//   * nothing here ever prints or throws a token.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { parseTrustedUrl, sameOrigin, WatcherError, TransientError } from "./util.mjs";

export const CREDENTIAL_FILE = "watch-credentials.json";
export const LOCK_FILE = "watch-credentials.lock";
export const REQUIRED_SCOPE = "runs.watch";

const MAX_FILE_BYTES = 64 * 1024;
const IS_WINDOWS = process.platform === "win32";

/** The stored sign-in cannot be used as it is; the message says what to do. */
export class CredentialError extends WatcherError {
  constructor(message) {
    super(message);
    this.name = "CredentialError";
  }
}

export function credentialDir(env = process.env) {
  if (env.REELBOLT_WATCH_HOME) return path.resolve(env.REELBOLT_WATCH_HOME);
  if (process.platform === "win32") {
    const base = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(base, "reelbolt");
  }
  const base = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(os.homedir(), ".config");
  return path.join(base, "reelbolt");
}

export function credentialPaths(dir) {
  return { file: path.join(dir, CREDENTIAL_FILE), lock: path.join(dir, LOCK_FILE) };
}

function modeText(stat) {
  return (stat.mode & 0o777).toString(8).padStart(3, "0");
}

function requirePrivate(stat, target, what, fix) {
  if (IS_WINDOWS) return;
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new CredentialError(`${what} ${target} is not owned by you. Remove it and sign in again.`);
  }
  if (stat.mode & 0o077) {
    throw new CredentialError(
      `${what} ${target} can be accessed by other users (mode ${modeText(stat)}). Run: ${fix} ${target}`
    );
  }
}

function lstatOrNull(target) {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new CredentialError(`cannot inspect ${target} (${error.code || "error"})`);
  }
}

function checkDirectory(dir, stat) {
  if (stat.isSymbolicLink()) {
    throw new CredentialError(`the credential directory ${dir} is a symbolic link. Remove it and sign in again.`);
  }
  if (!stat.isDirectory()) throw new CredentialError(`${dir} is not a directory. Remove it and sign in again.`);
  requirePrivate(stat, dir, "the credential directory", "chmod 700");
}

/** Make sure the directory exists, is private and is ours. Creates it 0700 when missing. */
export function ensureDirectory(dir) {
  const existing = lstatOrNull(dir);
  if (existing) {
    checkDirectory(dir, existing);
    return;
  }
  try {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw new CredentialError(`cannot create ${dir} (${error.code || "error"})`);
  }
  // mkdir's mode is masked by the umask; make it exact.
  if (!IS_WINDOWS) fs.chmodSync(dir, 0o700);
  const created = lstatOrNull(dir);
  if (!created) throw new CredentialError(`cannot create ${dir}`);
  checkDirectory(dir, created);
}

function text(value, field, { max = 4096, allowEmpty = false } = {}) {
  if (typeof value !== "string" || value.length > max || (!allowEmpty && value.length === 0)) {
    throw new CredentialError(`the stored sign-in is damaged (bad ${field}). Run logout, then login again.`);
  }
  return value;
}

function checkedUrl(value, field) {
  try {
    return parseTrustedUrl(text(value, field), field);
  } catch (error) {
    if (error instanceof CredentialError) throw error;
    throw new CredentialError(`the stored sign-in is damaged (bad ${field}). Run logout, then login again.`);
  }
}

/** Validate and normalise a credential record. Unknown fields are dropped. */
export function validateCredentials(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new CredentialError("the stored sign-in is damaged. Run logout, then login again.");
  }
  if (raw.version !== 1) throw new CredentialError("the stored sign-in has an unknown version. Run logout, then login again.");
  const server = checkedUrl(raw.server, "server");
  const issuer = checkedUrl(raw.issuer, "issuer");
  if (issuer.pathname !== "/" || issuer.search) {
    throw new CredentialError("the stored sign-in is damaged (bad issuer). Run logout, then login again.");
  }
  const tokenEndpoint = checkedUrl(raw.tokenEndpoint, "tokenEndpoint");
  const revocationEndpoint = checkedUrl(raw.revocationEndpoint, "revocationEndpoint");
  if (!sameOrigin(issuer.href, tokenEndpoint.href) || !sameOrigin(issuer.href, revocationEndpoint.href)) {
    throw new CredentialError("the stored sign-in points at a different host than its issuer. Run logout, then login again.");
  }
  const expires = raw.accessTokenExpiresAt;
  if (typeof expires !== "number" || !Number.isFinite(expires) || expires < 0) {
    throw new CredentialError("the stored sign-in is damaged (bad accessTokenExpiresAt). Run logout, then login again.");
  }
  if (raw.scope !== REQUIRED_SCOPE) {
    throw new CredentialError("the stored sign-in has an unexpected scope. Run logout, then login again.");
  }
  return {
    version: 1,
    server: server.href,
    issuer: issuer.origin,
    clientId: text(raw.clientId, "clientId", { max: 512 }),
    tokenEndpoint: tokenEndpoint.href,
    revocationEndpoint: revocationEndpoint.href,
    refreshToken: text(raw.refreshToken, "refreshToken", { max: 4096 }),
    accessToken: text(raw.accessToken, "accessToken", { max: 8192, allowEmpty: true }),
    accessTokenExpiresAt: expires,
    scope: REQUIRED_SCOPE,
  };
}

/** Returns the stored sign-in, or null when there is none. Throws CredentialError when it is unusable. */
export function readCredentials(dir) {
  const dirStat = lstatOrNull(dir);
  if (!dirStat) return null;
  checkDirectory(dir, dirStat);

  const { file } = credentialPaths(dir);
  const fileStat = lstatOrNull(file);
  if (!fileStat) return null;
  if (fileStat.isSymbolicLink()) {
    throw new CredentialError(`${file} is a symbolic link. Remove it and sign in again.`);
  }
  if (!fileStat.isFile()) throw new CredentialError(`${file} is not a regular file. Remove it and sign in again.`);

  let fd;
  let content;
  try {
    // O_NOFOLLOW closes the gap between the lstat above and this open.
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) throw new CredentialError(`${file} is not a regular file. Remove it and sign in again.`);
    requirePrivate(stat, file, "the credential file", "chmod 600");
    if (stat.size > MAX_FILE_BYTES) throw new CredentialError(`${file} is too large to be a sign-in. Remove it and sign in again.`);
    content = fs.readFileSync(fd, "utf8");
  } catch (error) {
    if (error instanceof CredentialError) throw error;
    throw new CredentialError(`cannot read ${file} (${error.code || "error"}). Remove it and sign in again.`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new CredentialError(`${file} is not valid JSON. Run logout, then login again.`);
  }
  return validateCredentials(parsed);
}

/**
 * Atomically replace the stored sign-in. `hooks.afterCreate(tempPath)` runs
 * right after the temp file exists, before any secret is written (tests use it
 * to prove the file is private from its first instant).
 */
export function writeCredentials(dir, credentials, hooks = {}) {
  const clean = validateCredentials(credentials);
  ensureDirectory(dir);
  const { file } = credentialPaths(dir);
  const temp = path.join(dir, `.${CREDENTIAL_FILE}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  let fd;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    if (hooks.afterCreate) hooks.afterCreate(temp);
    fs.writeSync(fd, `${JSON.stringify(clean, null, 2)}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
    }
    try {
      fs.unlinkSync(temp);
    } catch {
      // never created, or already renamed
    }
    if (error instanceof WatcherError) throw error;
    throw new CredentialError(`cannot save the sign-in (${error.code || "error"})`);
  }
  if (!IS_WINDOWS) {
    try {
      const dirFd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // best effort: the rename itself already succeeded
    }
  }
}

/** Delete the credential file whatever state it is in. Returns whether something was removed. */
export function deleteCredentials(dir) {
  const { file } = credentialPaths(dir);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw new CredentialError(`cannot remove ${file} (${error.code || "error"})`);
  }
}

// ---------------------------------------------------------------- locking --

export class LockTimeoutError extends TransientError {
  constructor() {
    super("another ReelBolt watcher is refreshing the sign-in; try again");
    this.name = "LockTimeoutError";
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function readLockInfo(lockPath) {
  let raw;
  let stat;
  try {
    stat = fs.statSync(lockPath);
    raw = fs.readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
  let info = null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Number.isInteger(parsed.pid) && typeof parsed.t === "number") info = parsed;
  } catch {
    // A lock being written (or damaged) has no content yet; age decides.
  }
  return { raw, info, mtimeMs: stat.mtimeMs };
}

/**
 * Remove a lock that is old or whose owner is gone. The lock is first renamed
 * away (atomic: only one contender wins) and its content re-checked, so a lock
 * another process created a moment ago is put back instead of being deleted.
 */
function breakStaleLock(lockPath, staleMs) {
  const seen = readLockInfo(lockPath);
  if (!seen) return;
  const born = seen.info ? seen.info.t : seen.mtimeMs;
  const stale = Date.now() - born > staleMs || (seen.info !== null && !pidAlive(seen.info.pid));
  if (!stale) return;
  const parked = `${lockPath}.stale.${randomBytes(4).toString("hex")}`;
  try {
    fs.renameSync(lockPath, parked);
  } catch {
    return;
  }
  let parkedRaw = null;
  try {
    parkedRaw = fs.readFileSync(parked, "utf8");
  } catch {
    // unreadable: treat as the stale one
  }
  if (parkedRaw === seen.raw || parkedRaw === null) {
    fs.rmSync(parked, { force: true });
    return;
  }
  try {
    fs.linkSync(parked, lockPath); // put the live lock back; fails if a newer one exists
  } catch {
    // another lock already took its place
  }
  fs.rmSync(parked, { force: true });
}

/**
 * Run `fn` while holding the exclusive credential lock. The lock records the
 * owner's pid and time, goes stale after `staleMs` or when the owner is dead,
 * and is released in `finally` only if it is still ours.
 */
export async function withLock(
  dir,
  fn,
  { waitMs = 15_000, staleMs = 30_000, pollMs = 100, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}
) {
  ensureDirectory(dir);
  const { lock } = credentialPaths(dir);
  const nonce = randomBytes(8).toString("hex");
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      try {
        fs.writeSync(fd, JSON.stringify({ pid: process.pid, t: Date.now(), nonce }));
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw new CredentialError(`cannot take the sign-in lock (${error.code || "error"})`);
      breakStaleLock(lock, staleMs);
      if (Date.now() >= deadline) throw new LockTimeoutError();
      await sleep(pollMs + Math.floor(Math.random() * pollMs));
    }
  }
  try {
    return await fn();
  } finally {
    const mine = readLockInfo(lock);
    if (mine && mine.info && mine.info.nonce === nonce) fs.rmSync(lock, { force: true });
  }
}
