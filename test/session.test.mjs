import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { createAuth } from "../bin/lib/auth.mjs";
import { credentialPaths, readCredentials } from "../bin/lib/credentials.mjs";
import { startFakeServer, finished } from "./helpers/fake-server.mjs";
import {
  BIN,
  GUID_A,
  GUID_B,
  assertNoSecrets,
  cleanupAll,
  loginInProcess,
  newHome,
  runInProcess,
  seed,
  spawnCli,
} from "./helpers/harness.mjs";

after(cleanupAll);
const posix = process.platform !== "win32";

const text = (body) => ({ content: [{ type: "text", text: JSON.stringify(body) }] });

test("no arguments prints usage and exits 2; the bin is executable", () => {
  const run = spawnSync(process.execPath, [BIN], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: reelbolt-watch/);
  assert.equal(run.stdout, "");
  if (posix) assert.ok(fs.statSync(BIN).mode & 0o111, "bin is executable");
  assert.equal(fs.readFileSync(BIN, "utf8").split("\n")[0], "#!/usr/bin/env node");
  const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
});

test("bad arguments exit 2 with the reason on stderr only", async () => {
  const { dir } = newHome();
  const env = { REELBOLT_WATCH_HOME: dir };
  for (const args of [["not-a-guid"], [GUID_A, "--project", "nope"], [GUID_A, "--max-minutes", "-3"], ["--wat"], ["status", "extra"]]) {
    const result = await spawnCli(args, env);
    assert.equal(result.code, 2, args.join(" "));
    assert.equal(result.stdout, "");
  }
});

test("not signed in: one stdout line and exit 3", async () => {
  const { dir } = newHome();
  const result = await spawnCli([GUID_A, "--project", GUID_B], { REELBOLT_WATCH_HOME: dir });
  assert.equal(result.code, 3);
  assert.equal(result.stdout.trim(), "not signed in: run reelbolt-watch login --server <your ReelBolt MCP URL>");
});

test("a credential file with loose permissions ends the watch with a clear stdout line, exit 3", { skip: !posix }, async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    seed(dir, server);
    fs.chmodSync(credentialPaths(dir).file, 0o644);
    const result = await spawnCli([GUID_A, "--project", GUID_B], { REELBOLT_WATCH_HOME: dir });
    assert.equal(result.code, 3);
    assert.match(result.stdout, /^sign-in unusable: .*chmod 600/);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.equal(server.state.counts.toolCall, 0);
    assertNoSecrets([result.stdout, result.stderr], server.allSecrets());
  } finally {
    await server.close();
  }
});

test("a run watched from login to the end, with the exact request the API expects", async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    const login = await loginInProcess(server, dir);
    assert.equal(login.code, 0);
    const result = await spawnCli([GUID_A, "--project", GUID_B], { REELBOLT_WATCH_HOME: dir });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "finished: Passed\n");
    const request = server.state.toolRequests.at(-1);
    assert.deepEqual(request.body, { name: "GetExecutionStatus", arguments: { executionId: GUID_A }, context: { projectId: GUID_B } });
    assert.equal(request.contentType, "application/json");
    assert.ok(request.bearer.startsWith("fakeaccess"));
    assertNoSecrets([result.stdout, result.stderr, ...login.out, ...login.err], server.allSecrets());
  } finally {
    await server.close();
  }
});

test("without a project the watcher refuses before any request", async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    seed(dir, server);
    const result = await spawnCli([GUID_A], { REELBOLT_WATCH_HOME: dir });
    assert.equal(result.code, 2);
    assert.equal(server.state.toolRequests.length, 0);
  } finally {
    await server.close();
  }
});

test("a 401 refreshes once, retries, and stores the rotated refresh token", async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    const before = seed(dir, server, { access: "fakeaccess-not-known-to-server" });
    const result = await runInProcess([GUID_A, "--project", GUID_B], dir);
    assert.equal(result.code, 0, result.err.join("\n"));
    assert.deepEqual(result.out, ["finished: Passed"]);
    assert.equal(server.state.counts.refresh, 1);
    assert.equal(server.state.counts.toolCall, 2);
    const creds = readCredentials(dir);
    assert.notEqual(creds.refreshToken, before.refresh_token);
    assert.equal(server.state.toolRequests[1].bearer, creds.accessToken);
    assertNoSecrets([...result.out, ...result.err], server.allSecrets());
  } finally {
    await server.close();
  }
});

test("an access token near expiry is refreshed before the first call", async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    seed(dir, server, { expiresInMs: 20_000 });
    const result = await runInProcess([GUID_A, "--project", GUID_B], dir);
    assert.equal(result.code, 0);
    assert.equal(server.state.counts.refresh, 1);
    assert.equal(server.state.counts.toolCall, 1);
  } finally {
    await server.close();
  }
});

test("a 401 that survives a refresh ends with the sign-in line, exit 3", async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    seed(dir, server);
    server.state.toolOverride = { status: 401, body: { error: "unauthorized" } };
    const result = await runInProcess([GUID_A, "--project", GUID_B], dir);
    assert.equal(result.code, 3);
    assert.deepEqual(result.out, [`sign-in expired: run reelbolt-watch login --server ${server.origin}`]);
  } finally {
    await server.close();
  }
});

test("a token the server no longer honours for this call (403 mcp_token_scope) ends with the sign-in line, exit 3", async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    seed(dir, server);
    server.state.toolOverride = { status: 403, body: { error: "mcp_token_scope", message: "details that must not be echoed fakeaccess-x" } };
    const result = await runInProcess([GUID_A, "--project", GUID_B], dir);
    assert.equal(result.code, 3);
    assert.deepEqual(result.out, [`sign-in expired: run reelbolt-watch login --server ${server.origin}`]);
    assert.deepEqual(result.err, []);
  } finally {
    await server.close();
  }
});

test("any other 403 is reported as access denied, exit 1, without echoing the body", async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    seed(dir, server);
    server.state.toolOverride = { status: 403, body: { error: "forbidden", message: "secret detail" } };
    const result = await runInProcess([GUID_A, "--project", GUID_B], dir);
    assert.equal(result.code, 1);
    assert.deepEqual(result.out, ["cannot read this run: access denied"]);
    assert.ok(!result.err.join("").includes("secret detail"));
  } finally {
    await server.close();
  }
});

test("a revoked grant (refresh says invalid_grant) ends with the sign-in line, exit 3", async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    seed(dir, server, { access: "fakeaccess-expired", expiresInMs: -1000 });
    // Drop the refresh token server-side, as logout elsewhere or a reuse would.
    for (const record of server.state.refresh.values()) record.revoked = true;
    const result = await runInProcess([GUID_A, "--project", GUID_B], dir);
    assert.equal(result.code, 3);
    assert.deepEqual(result.out, [`sign-in expired: run reelbolt-watch login --server ${server.origin}`]);
  } finally {
    await server.close();
  }
});

test("a refresh whose answer was lost: the next try finds the old token spent and ends with the sign-in line, exit 3", async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    const original = seed(dir, server, { expiresInMs: -1000 });
    server.state.dropNextRefreshResponse = true;
    const sleeps = [];
    const result = await runInProcess([GUID_A, "--project", GUID_B], dir, { sleep: async (ms) => void sleeps.push(ms) });
    assert.equal(result.code, 3);
    assert.deepEqual(result.out, [`sign-in expired: run reelbolt-watch login --server ${server.origin}`]);
    assert.equal(server.state.counts.refresh, 2);
    assert.deepEqual(sleeps, [5000], "one transient failure, then the fatal one");
    assert.equal(readCredentials(dir).refreshToken, original.refresh_token, "the old token is never replaced by a guess");
    assertNoSecrets([...result.out, ...result.err], server.allSecrets());
  } finally {
    await server.close();
  }
});

test("two watchers racing on an expired token perform exactly one refresh and both succeed", async () => {
  const server = await startFakeServer({ refreshDelayMs: 400 });
  const { dir } = newHome();
  try {
    seed(dir, server, { expiresInMs: -1000 });
    const env = { REELBOLT_WATCH_HOME: dir };
    const [a, b] = await Promise.all([spawnCli([GUID_A, "--project", GUID_B], env), spawnCli([GUID_B, "--project", GUID_A], env)]);
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.equal(b.code, 0, b.stdout + b.stderr);
    assert.equal(a.stdout, "finished: Passed\n");
    assert.equal(b.stdout, "finished: Passed\n");
    assert.equal(server.state.counts.refresh, 1);
    const bearers = new Set(server.state.toolRequests.map((r) => r.bearer));
    assert.equal(bearers.size, 1, "both used the one refreshed token");
    assert.equal([...bearers][0], readCredentials(dir).accessToken);
    assert.equal(fs.existsSync(credentialPaths(dir).lock), false);
    assertNoSecrets([a.stdout, a.stderr, b.stdout, b.stderr], server.allSecrets());
  } finally {
    await server.close();
  }
});

test("concurrent refreshes inside one process also collapse to one request", async () => {
  const server = await startFakeServer({ refreshDelayMs: 150 });
  const { dir } = newHome();
  try {
    seed(dir, server, { expiresInMs: -1000 });
    const auth = createAuth({ dir });
    const results = await Promise.all([auth.current(), auth.current(), auth.current()]);
    assert.equal(server.state.counts.refresh, 1);
    assert.equal(new Set(results.map((r) => r.accessToken)).size, 1);
    assert.equal(results[0].accessToken, readCredentials(dir).accessToken);
  } finally {
    await server.close();
  }
});

test("the refreshed sign-in is stored before the lock is released", async () => {
  const server = await startFakeServer({ refreshDelayMs: 200 });
  const { dir } = newHome();
  try {
    const original = seed(dir, server, { expiresInMs: -1000 });
    const first = createAuth({ dir }).current();
    await new Promise((r) => setTimeout(r, 50));
    // While the first holds the lock mid-refresh, a second must wait and then see the new file.
    const second = await createAuth({ dir }).current();
    const firstDone = await first;
    assert.equal(second.accessToken, firstDone.accessToken);
    assert.notEqual(readCredentials(dir).refreshToken, original.refresh_token);
    assert.equal(server.state.counts.refresh, 1);
  } finally {
    await server.close();
  }
});

test("a refresh that returns a wider scope is not stored and ends with the sign-in line", async () => {
  const server = await startFakeServer({ refreshScope: "assistant.tools" });
  const { dir } = newHome();
  try {
    const original = seed(dir, server, { expiresInMs: -1000 });
    const result = await runInProcess([GUID_A, "--project", GUID_B], dir);
    assert.equal(result.code, 3);
    assert.equal(readCredentials(dir).refreshToken, original.refresh_token);
  } finally {
    await server.close();
  }
});

test("tokens only go to the stored origin and redirects are refused", async () => {
  const server = await startFakeServer();
  const other = await startFakeServer();
  const { dir } = newHome();
  try {
    seed(dir, server);
    let redirectOption;
    const fetchSpy = async (url, init) => {
      redirectOption = init.redirect;
      assert.ok(String(url).startsWith(server.origin), "calls go to the stored origin");
      return globalThis.fetch(url, init);
    };
    const result = await runInProcess([GUID_A, "--project", GUID_B], dir, { fetch: fetchSpy });
    assert.equal(result.code, 0);
    assert.equal(redirectOption, "error");
    assert.equal(other.state.counts.toolCall, 0);

    // A server that tries to bounce the call elsewhere is treated as a failure, not followed.
    server.state.toolOverride = null;
    const bouncing = async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ERR_REDIRECT" } });
    };
    const bounced = await runInProcess([GUID_A, "--project", GUID_B], dir, { fetch: bouncing });
    assert.equal(bounced.code, 1);
    assert.deepEqual(bounced.out, ["lost contact with ReelBolt"]);
    assert.equal(other.state.counts.toolCall, 0);
  } finally {
    await server.close();
    await other.close();
  }
});

test("an edited credential file pointing the token endpoint at another host is refused", { skip: !posix }, async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    seed(dir, server);
    const { file } = credentialPaths(dir);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    doc.tokenEndpoint = "https://evil.example/oauth/token";
    fs.writeFileSync(file, JSON.stringify(doc), { mode: 0o600 });
    const result = await runInProcess([GUID_A, "--project", GUID_B], dir);
    assert.equal(result.code, 3);
    assert.match(result.out[0], /^sign-in unusable:/);
    assert.equal(server.state.counts.toolCall, 0);
  } finally {
    await server.close();
  }
});

test("watching survives transient server errors", async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    seed(dir, server);
    server.state.toolOverride = { status: 503, body: { error: "busy" } };
    const sleeps = [];
    const flipped = runInProcess([GUID_A, "--project", GUID_B, "--max-minutes", "5"], dir, {
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 2) server.state.toolOverride = null;
      },
    });
    const result = await flipped;
    assert.equal(result.code, 0);
    assert.deepEqual(sleeps, [5000, 10000]);
    assert.deepEqual(result.out, ["finished: Passed"]);
  } finally {
    await server.close();
  }
});

test("a running run prints a line per change and stops on the terminal state", async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    seed(dir, server);
    const step = (done, label) => text({ status: "Running", terminal: false, retryAfterSeconds: 5, progress: { stepsTotal: 3, stepsDone: done, currentStep: { label } } });
    server.state.toolResponses.push(step(0, "Plan"), step(0, "Plan"), step(1, "Render"), text(finished()));
    const result = await runInProcess([GUID_A, "--project", GUID_B], dir);
    assert.equal(result.code, 0);
    assert.deepEqual(result.out, ["running 0/3 - Plan", "running 1/3 - Render", "finished: Passed"]);
  } finally {
    await server.close();
  }
});

test("status: signed in shows no secret and exits 0; not signed in exits 1", async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    const none = await runInProcess(["status"], dir);
    assert.equal(none.code, 1);
    assert.deepEqual(none.out, ["not signed in"]);

    const login = await loginInProcess(server, dir);
    assert.equal(login.code, 0);
    const result = await runInProcess(["status"], dir);
    assert.equal(result.code, 0);
    assert.equal(result.out[0], "signed in");
    assert.ok(result.out.includes(`server: ${server.origin}`));
    assert.ok(result.out.includes("scope: runs.watch"));
    assert.ok(result.out.some((l) => l.startsWith("access token expires: ")));
    assertNoSecrets([...result.out, ...result.err], server.allSecrets());

    if (posix) {
      fs.chmodSync(credentialPaths(dir).file, 0o644);
      const loose = await runInProcess(["status"], dir);
      assert.equal(loose.code, 1);
      assertNoSecrets(loose.out, server.allSecrets());
    }
  } finally {
    await server.close();
  }
});

test("logout revokes on the server, deletes the file, and the sign-in is dead afterwards", async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    await loginInProcess(server, dir);
    const creds = readCredentials(dir);
    const result = await runInProcess(["logout"], dir);
    assert.equal(result.code, 0);
    assert.equal(server.state.counts.revoke, 1);
    assert.equal(fs.existsSync(credentialPaths(dir).file), false);
    assert.equal(server.state.refresh.get(creds.refreshToken).revoked, true);
    assertNoSecrets([...result.out, ...result.err], server.allSecrets());
    const again = await runInProcess(["logout"], dir);
    assert.equal(again.code, 0);
    assert.equal(server.state.counts.revoke, 1, "nothing stored, nothing to revoke");
  } finally {
    await server.close();
  }
});

test("logout still deletes the file when the server cannot be reached or refuses, and says so", async () => {
  const server = await startFakeServer({ revokeStatus: 500 });
  const { dir } = newHome();
  try {
    seed(dir, server);
    const result = await runInProcess(["logout"], dir);
    assert.equal(result.code, 0);
    assert.match(result.err.join("\n"), /Could not reach the server to revoke/);
    assert.equal(fs.existsSync(credentialPaths(dir).file), false);

    seed(dir, server);
    const unreachable = await runInProcess(["logout"], dir, {
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    assert.equal(unreachable.code, 0);
    assert.equal(fs.existsSync(credentialPaths(dir).file), false);
  } finally {
    await server.close();
  }
});

test("logout removes a file that can no longer be read, without trusting it", { skip: !posix }, async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    seed(dir, server);
    fs.chmodSync(credentialPaths(dir).file, 0o666);
    const result = await runInProcess(["logout"], dir);
    assert.equal(result.code, 0);
    assert.equal(server.state.counts.revoke, 0, "an untrusted file is never used to call the server");
    assert.equal(fs.existsSync(credentialPaths(dir).file), false);
  } finally {
    await server.close();
  }
});

test("secrets stay out of output across a whole session (login, watch, refresh, status, logout)", async () => {
  const server = await startFakeServer({ expiresIn: 3600 });
  const { dir } = newHome();
  try {
    const all = [];
    const collect = (r) => all.push(...(r.out || []), ...(r.err || []), r.stdout || "", r.stderr || "");
    collect(await loginInProcess(server, dir));
    collect(await spawnCli([GUID_A, "--project", GUID_B], { REELBOLT_WATCH_HOME: dir }));
    const creds = readCredentials(dir);
    seed(dir, server, { access: "fakeaccess-stale-one" });
    collect(await runInProcess([GUID_A, "--project", GUID_B], dir));
    collect(await runInProcess(["status"], dir));
    collect(await runInProcess(["logout"], dir));
    assert.ok(creds.refreshToken);
    assertNoSecrets(all, server.allSecrets());
    // and nothing leaked a process.env dump or the credential JSON
    assert.ok(!all.join("\n").includes('"refreshToken"'));
  } finally {
    await server.close();
  }
});
