import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { runCli } from "../../bin/lib/cli.mjs";
import { writeCredentials } from "../../bin/lib/credentials.mjs";

export const BIN = fileURLToPath(new URL("../../bin/reelbolt-watch.mjs", import.meta.url));
export const GUID_A = "11111111-1111-4111-8111-111111111111";
export const GUID_B = "22222222-2222-4222-8222-222222222222";

const cleanups = [];
export function cleanupAll() {
  for (const fn of cleanups.splice(0)) {
    try {
      fn();
    } catch {
      // best effort
    }
  }
}

/** A fresh private temp directory; returns the (not yet created) credential directory inside it. */
export function newHome({ create = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "reelbolt-watch-test-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "reelbolt");
  if (create) mkdirSync(dir, { mode: 0o700 });
  return { root, dir };
}

export function makeIo(dir, overrides = {}) {
  const out = [];
  const err = [];
  const io = {
    out: (line) => {
      out.push(line);
      if (io.onOut) io.onOut(line);
    },
    err: (line) => err.push(line),
    env: { REELBOLT_WATCH_HOME: dir },
    fetch: globalThis.fetch,
    now: () => Date.now(),
    sleep: async () => {},
    ...overrides,
  };
  return { io, out, err };
}

/** Run login in-process; the callback plays the browser as soon as the authorize URL is printed. */
export async function loginInProcess(server, dir, { browser = (url) => server.approve(url), overrides = {} } = {}) {
  const { io, out, err } = makeIo(dir, overrides);
  let browserDone = Promise.resolve();
  io.onOut = (line) => {
    if (/^https?:\/\//.test(line)) browserDone = Promise.resolve(browser(line));
  };
  const code = await runCli(["login", "--server", server.mcpUrl, "--no-browser"], io);
  await browserDone;
  return { code, out, err };
}

export async function runInProcess(argv, dir, overrides = {}) {
  const { io, out, err } = makeIo(dir, overrides);
  const code = await runCli(argv, io);
  return { code, out, err };
}

/** Store a sign-in for a fake-server token pair, as login would have. */
export function seed(dir, server, { access, expiresInMs = 3_600_000, overrides = {} } = {}) {
  const tokens = server.issueDirect();
  writeCredentials(dir, {
    version: 1,
    server: server.mcpUrl,
    issuer: server.origin,
    clientId: "direct-client",
    tokenEndpoint: `${server.origin}/oauth/token`,
    revocationEndpoint: `${server.origin}/oauth/revoke`,
    refreshToken: tokens.refresh_token,
    accessToken: access ?? tokens.access_token,
    accessTokenExpiresAt: Date.now() + expiresInMs,
    scope: "runs.watch",
    ...overrides,
  });
  return tokens;
}

export function spawnCli(args, env, { input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { PATH: process.env.PATH, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input ?? "");
  });
}

export function assertNoSecrets(texts, secrets) {
  const haystack = texts.join("\n");
  for (const secret of secrets) {
    assert.ok(!haystack.includes(secret), "a credential value appeared in output");
  }
}
