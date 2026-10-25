import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { createHash } from "node:crypto";
import { credentialPaths, readCredentials } from "../bin/lib/credentials.mjs";
import { startCallbackListener } from "../bin/lib/oauth.mjs";
import { startFakeServer } from "./helpers/fake-server.mjs";
import { assertNoSecrets, cleanupAll, loginInProcess, newHome, runInProcess } from "./helpers/harness.mjs";

after(cleanupAll);

const posix = process.platform !== "win32";

function authorizeUrlFrom(out) {
  const line = out.find((l) => /^https?:\/\//.test(l));
  assert.ok(line, "the authorize URL must be printed");
  return new URL(line);
}

test("login happy path: PKCE, loopback redirect, narrow scope, private store", async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    const result = await loginInProcess(server, dir);
    assert.equal(result.code, 0, result.err.join("\n"));

    // registration was a public loopback client
    const body = server.state.registerBodies[0];
    assert.equal(body.token_endpoint_auth_method, "none");
    assert.equal(body.client_name, "ReelBolt run watcher");
    assert.deepEqual(body.grant_types, ["authorization_code", "refresh_token"]);
    assert.match(body.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    // the authorize URL carries the right parameters and a PKCE challenge
    const url = authorizeUrlFrom(result.out);
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(url.searchParams.get("scope"), "runs.watch");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.equal(url.searchParams.get("redirect_uri"), body.redirect_uris[0]);
    assert.ok(url.searchParams.get("state").length >= 24);

    // the verifier sent to the token endpoint matches the challenge in the authorize URL
    const verifier = server.state.lastVerifier;
    assert.ok(verifier.length >= 43);
    assert.equal(createHash("sha256").update(verifier).digest("base64url"), url.searchParams.get("code_challenge"));

    // what was said, and what was stored
    assert.ok(result.out.includes("Signed in. This sign-in can only read the status of your runs."));
    assert.ok(result.out.includes(`Server: ${server.origin}`));
    const creds = readCredentials(dir);
    assert.equal(creds.scope, "runs.watch");
    assert.equal(creds.issuer, server.origin);
    assert.equal(creds.server, server.mcpUrl);
    assert.equal(creds.tokenEndpoint, `${server.origin}/oauth/token`);
    assert.ok(creds.refreshToken.startsWith("fakerefresh"));
    if (posix) {
      assert.equal(fs.statSync(credentialPaths(dir).file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    }

    // no secret reaches stdout or stderr
    assertNoSecrets([...result.out, ...result.err], server.allSecrets());
    assert.equal(fs.existsSync(credentialPaths(dir).lock), false);
  } finally {
    await server.close();
  }
});

test("a callback with the wrong or missing state, or another path, is ignored; the right one is accepted", async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    let seen;
    const result = await loginInProcess(server, dir, {
      browser: async (url) => {
        seen = await server.approve(url, { extraStateFirst: true });
      },
    });
    assert.equal(result.code, 0, result.err.join("\n"));
    assert.deepEqual(seen, { badStatus: 400, missingStatus: 400, otherStatus: 400, final: 200 });
    assert.ok(readCredentials(dir));
  } finally {
    await server.close();
  }
});

test("a callback is accepted only once, then the listener is gone", async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    let location;
    const result = await loginInProcess(server, dir, {
      browser: async (url) => {
        const authorized = await fetch(url, { redirect: "manual" });
        location = authorized.headers.get("location");
        await (await fetch(location)).text();
      },
    });
    assert.equal(result.code, 0);
    await assert.rejects(fetch(location), /fetch failed/);
  } finally {
    await server.close();
  }
});

test("the loopback listener binds 127.0.0.1 only and rejects a foreign Host header", async () => {
  const listener = await startCallbackListener();
  try {
    assert.equal(listener.address, "127.0.0.1");
    listener.expect("state-value");
    const status = await new Promise((resolve, reject) => {
      const socket = net.connect(listener.port, "127.0.0.1", () => {
        socket.write("GET /callback?code=c&state=state-value HTTP/1.1\r\nHost: evil.example\r\nConnection: close\r\n\r\n");
      });
      let data = "";
      socket.on("data", (d) => (data += d));
      socket.on("end", () => resolve(Number(data.split(" ")[1])));
      socket.on("error", reject);
    });
    assert.equal(status, 400);
  } finally {
    listener.close();
  }
});

test("a declined sign-in says so, stores nothing and exits 1", async () => {
  const server = await startFakeServer({ deny: true });
  const { dir } = newHome();
  try {
    const result = await loginInProcess(server, dir);
    assert.equal(result.code, 1);
    assert.match(result.err.join("\n"), /declined/);
    assert.equal(readCredentials(dir), null);
    assert.equal(server.state.counts.token, 0);
  } finally {
    await server.close();
  }
});

test("a server that grants a wider scope gets it revoked, and nothing is stored", async () => {
  const server = await startFakeServer({ grantScope: "assistant.tools" });
  const { dir } = newHome();
  try {
    const result = await loginInProcess(server, dir);
    assert.equal(result.code, 1);
    assert.match(result.err.join("\n"), /more access/);
    assert.match(result.err.join("\n"), /revoked/);
    assert.equal(server.state.counts.revoke, 1);
    assert.equal(readCredentials(dir), null);
    // the revoked grant cannot be refreshed any more
    const [refreshToken] = [...server.state.refresh.keys()];
    assert.equal(server.state.refresh.get(refreshToken).revoked, true);
    assertNoSecrets([...result.out, ...result.err], server.allSecrets());
  } finally {
    await server.close();
  }
});

test("a scope that adds to runs.watch is also refused", async () => {
  const server = await startFakeServer({ grantScope: "runs.watch assistant.tools" });
  const { dir } = newHome();
  try {
    const result = await loginInProcess(server, dir);
    assert.equal(result.code, 1);
    assert.equal(server.state.counts.revoke, 1);
    assert.equal(readCredentials(dir), null);
  } finally {
    await server.close();
  }
});

test("a wider grant is still not stored when revocation fails, and the failure is reported", async () => {
  const server = await startFakeServer({ grantScope: "assistant.tools", revokeStatus: 500 });
  const { dir } = newHome();
  try {
    const result = await loginInProcess(server, dir);
    assert.equal(result.code, 1);
    assert.match(result.err.join("\n"), /could not be asked to revoke/);
    assert.equal(readCredentials(dir), null);
  } finally {
    await server.close();
  }
});

test("an authorization server on another host is refused before anything is registered", async () => {
  const server = await startFakeServer({ protectedResource: { authorization_servers: ["https://evil.example"] } });
  const { dir } = newHome();
  try {
    const result = await runInProcess(["login", "--server", server.mcpUrl, "--no-browser"], dir);
    assert.equal(result.code, 1);
    assert.match(result.err.join("\n"), /different host/);
    assert.equal(server.state.counts.register, 0);
    assert.equal(readCredentials(dir), null);
  } finally {
    await server.close();
  }
});

test("every endpoint must be on the issuer's origin", async () => {
  for (const field of ["token_endpoint", "revocation_endpoint", "registration_endpoint", "authorization_endpoint"]) {
    const server = await startFakeServer({ metadata: { [field]: "https://evil.example/x" } });
    const { dir } = newHome();
    try {
      const result = await runInProcess(["login", "--server", server.mcpUrl, "--no-browser"], dir);
      assert.equal(result.code, 1, field);
      assert.match(result.err.join("\n"), /different host/, field);
      assert.equal(server.state.counts.register, 0, field);
    } finally {
      await server.close();
    }
  }
});

test("metadata that names a different issuer, or no runs.watch scope, is refused", async () => {
  const wrongIssuer = await startFakeServer({ metadata: { issuer: "https://evil.example" } });
  const old = await startFakeServer({ metadata: { scopes_supported: ["assistant.tools", "assistant.admin"] } });
  const { dir } = newHome();
  try {
    const first = await runInProcess(["login", "--server", wrongIssuer.mcpUrl, "--no-browser"], dir);
    assert.equal(first.code, 1);
    assert.match(first.err.join("\n"), /different issuer/);
    const second = await runInProcess(["login", "--server", old.mcpUrl, "--no-browser"], dir);
    assert.equal(second.code, 1);
    assert.match(second.err.join("\n"), /too old/);
  } finally {
    await wrongIssuer.close();
    await old.close();
  }
});

test("--server must be https, or http only for the local machine; nothing is requested otherwise", async () => {
  const { dir } = newHome();
  const calls = [];
  const fetch = async (url) => {
    calls.push(String(url));
    throw new Error("must not be called");
  };
  for (const bad of ["http://reelbolt.example/mcp", "ftp://reelbolt.ai/mcp", "not a url", "https://user:pw@reelbolt.ai/mcp", "https://reelbolt.ai/mcp#frag"]) {
    const result = await runInProcess(["login", "--server", bad, "--no-browser"], dir, { fetch });
    assert.equal(result.code, 1, bad);
    assert.ok(!result.err.join("\n").includes("pw"), "credentials in the URL are never echoed");
  }
  assert.deepEqual(calls, []);
});

test("login without --server is a usage error", async () => {
  const { dir } = newHome();
  const result = await runInProcess(["login"], dir);
  assert.equal(result.code, 2);
  const unknown = await runInProcess(["login", "--server", "https://reelbolt.ai/mcp", "--bogus"], dir);
  assert.equal(unknown.code, 2);
});

test("waiting for the browser times out cleanly and closes the listener", async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    const result = await loginInProcess(server, dir, { browser: async () => {}, overrides: { callbackTimeoutMs: 150 } });
    assert.equal(result.code, 1);
    assert.match(result.err.join("\n"), /timed out/);
    assert.equal(readCredentials(dir), null);
    const url = authorizeUrlFrom(result.out);
    const port = new URL(url.searchParams.get("redirect_uri")).port;
    await assert.rejects(fetch(`http://127.0.0.1:${port}/callback`), /fetch failed/);
  } finally {
    await server.close();
  }
});

test("the browser is launched with the URL as one argument and --no-browser skips it", async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    const launched = [];
    const { io, out, err } = (await import("./helpers/harness.mjs")).makeIo(dir, {
      openBrowser: (url) => launched.push(url),
    });
    io.onOut = (line) => {
      if (/^https?:\/\//.test(line)) server.approve(line);
    };
    const { runCli } = await import("../bin/lib/cli.mjs");
    assert.equal(await runCli(["login", "--server", server.mcpUrl], io), 0, err.join("\n"));
    assert.equal(launched.length, 1);
    assert.equal(launched[0], out.find((l) => /^https?:\/\//.test(l)));

    const skipped = [];
    const second = (await import("./helpers/harness.mjs")).makeIo(dir, { openBrowser: (url) => skipped.push(url) });
    second.io.onOut = (line) => {
      if (/^https?:\/\//.test(line)) server.approve(line);
    };
    assert.equal(await runCli(["login", "--server", server.mcpUrl, "--no-browser"], second.io), 0);
    assert.deepEqual(skipped, []);
  } finally {
    await server.close();
  }
});

test("a token endpoint failure prints the status and OAuth code, never a body", async () => {
  const server = await startFakeServer();
  const { dir } = newHome();
  try {
    const result = await loginInProcess(server, dir, {
      browser: async (url) => {
        // Burn the code first so the exchange fails with invalid_grant.
        const authorized = await fetch(url, { redirect: "manual" });
        const location = new URL(authorized.headers.get("location"));
        for (const record of server.state.codes.values()) record.used = true;
        await (await fetch(location)).text();
      },
    });
    assert.equal(result.code, 1);
    assert.match(result.err.join("\n"), /HTTP 400, invalid_grant/);
    assert.equal(readCredentials(dir), null);
    assertNoSecrets([...result.out, ...result.err], server.allSecrets());
  } finally {
    await server.close();
  }
});
