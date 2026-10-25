// A fake ReelBolt authorization + API server for the watcher tests. One local
// origin plays every role: protected-resource metadata, authorization-server
// metadata, registration, authorize (the test plays the browser), token (code
// and refresh, with rotation and reuse detection that revokes the grant),
// revoke and the status tool call. Every credential it hands out is a made-up
// string recorded in `secrets`, so tests can prove none of them ever shows up
// in output.

import http from "node:http";
import { createHash, randomBytes } from "node:crypto";

const hex = (n = 6) => randomBytes(n).toString("hex");

export async function startFakeServer(options = {}) {
  const opts = {
    grantScope: "runs.watch",
    expiresIn: 3600,
    refreshDelayMs: 0,
    revokeStatus: 200,
    deny: false,
    ...options,
  };
  const state = {
    clients: new Map(),
    codes: new Map(),
    refresh: new Map(),
    access: new Map(),
    grants: new Map(),
    secrets: new Set(),
    counts: { register: 0, token: 0, refresh: 0, revoke: 0, toolCall: 0 },
    toolRequests: [],
    registerBodies: [],
    toolResponses: [],
    toolOverride: null,
    lastVerifier: null,
    dropNextRefreshResponse: false,
    serial: 0,
  };
  let origin = "";

  const mint = (prefix, secret = true) => {
    const value = `${prefix}-${++state.serial}-${hex()}`;
    if (secret) state.secrets.add(value);
    return value;
  };

  function issue(clientId, grantId, scope, expiresIn = opts.expiresIn) {
    const accessToken = mint("fakeaccess");
    const refreshToken = mint("fakerefresh");
    state.access.set(accessToken, { expiresAt: Date.now() + expiresIn * 1000, grantId, scope });
    state.refresh.set(refreshToken, { clientId, grantId, revoked: false });
    return { access_token: accessToken, token_type: "Bearer", expires_in: expiresIn, refresh_token: refreshToken, scope };
  }

  function revokeGrant(grantId) {
    state.grants.set(grantId, { revoked: true });
    for (const record of state.refresh.values()) if (record.grantId === grantId) record.revoked = true;
  }

  const send = (res, status, body, headers = {}) => {
    const payload = body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body);
    res.writeHead(status, { "Content-Type": "application/json", ...headers });
    res.end(payload);
  };

  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    return Buffer.concat(chunks).toString("utf8");
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const path = url.pathname;
    try {
      if (req.method === "GET" && path === "/.well-known/oauth-protected-resource") {
        return send(res, 200, {
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["assistant.tools", "assistant.admin", "runs.watch"],
          bearer_methods_supported: ["header"],
          ...(opts.protectedResource || {}),
        });
      }
      if (req.method === "GET" && path === "/.well-known/oauth-authorization-server") {
        return send(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/oauth/authorize`,
          token_endpoint: `${origin}/oauth/token`,
          registration_endpoint: `${origin}/oauth/register`,
          revocation_endpoint: `${origin}/oauth/revoke`,
          scopes_supported: ["assistant.tools", "assistant.admin", "runs.watch"],
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
          ...(opts.metadata || {}),
        });
      }
      if (req.method === "POST" && path === "/oauth/register") {
        state.counts.register++;
        const body = JSON.parse(await readBody(req));
        state.registerBodies.push(body);
        const clientId = mint("fakeclient", false);
        state.clients.set(clientId, { redirectUris: body.redirect_uris });
        return send(res, 201, { client_id: clientId, client_name: body.client_name, redirect_uris: body.redirect_uris, token_endpoint_auth_method: "none" });
      }
      if (req.method === "GET" && path === "/oauth/authorize") {
        const q = url.searchParams;
        const client = state.clients.get(q.get("client_id"));
        if (!client || !client.redirectUris.includes(q.get("redirect_uri"))) return send(res, 400, { error: "invalid_request" });
        if (q.get("response_type") !== "code" || q.get("code_challenge_method") !== "S256" || !q.get("code_challenge")) {
          return send(res, 400, { error: "invalid_request" });
        }
        const back = new URL(q.get("redirect_uri"));
        if (q.get("state")) back.searchParams.set("state", q.get("state"));
        if (opts.deny) {
          back.searchParams.set("error", "access_denied");
          return send(res, 302, undefined, { Location: back.href });
        }
        const code = mint("fakecode");
        state.codes.set(code, {
          clientId: q.get("client_id"),
          redirectUri: q.get("redirect_uri"),
          challenge: q.get("code_challenge"),
          scope: q.get("scope"),
          used: false,
        });
        back.searchParams.set("code", code);
        return send(res, 302, undefined, { Location: back.href });
      }
      if (req.method === "POST" && path === "/oauth/token") {
        state.counts.token++;
        const form = new URLSearchParams(await readBody(req));
        res.setHeader("Cache-Control", "no-store");
        const grantType = form.get("grant_type");
        if (grantType === "authorization_code") {
          const record = state.codes.get(form.get("code"));
          const verifier = form.get("code_verifier") || "";
          state.lastVerifier = verifier;
          state.secrets.add(verifier);
          const challenge = createHash("sha256").update(verifier).digest("base64url");
          if (
            !record || record.used || record.clientId !== form.get("client_id") ||
            record.redirectUri !== form.get("redirect_uri") || record.challenge !== challenge
          ) {
            return send(res, 400, { error: "invalid_grant", error_description: "The authorization code is invalid or expired." });
          }
          record.used = true;
          const grantId = mint("grant", false);
          return send(res, 200, issue(record.clientId, grantId, opts.grantScope));
        }
        if (grantType === "refresh_token") {
          state.counts.refresh++;
          if (opts.refreshDelayMs) await new Promise((r) => setTimeout(r, opts.refreshDelayMs));
          const record = state.refresh.get(form.get("refresh_token"));
          if (!record || record.clientId !== form.get("client_id")) return send(res, 400, { error: "invalid_grant" });
          if (record.revoked) {
            // Reuse of a rotated token: the whole grant dies.
            revokeGrant(record.grantId);
            return send(res, 400, { error: "invalid_grant" });
          }
          record.revoked = true;
          const body = issue(record.clientId, record.grantId, opts.refreshScope ?? opts.grantScope, opts.refreshExpiresIn ?? opts.expiresIn);
          if (state.dropNextRefreshResponse) {
            state.dropNextRefreshResponse = false;
            req.socket.destroy();
            return undefined;
          }
          return send(res, 200, body);
        }
        return send(res, 400, { error: "unsupported_grant_type" });
      }
      if (req.method === "POST" && path === "/oauth/revoke") {
        state.counts.revoke++;
        const form = new URLSearchParams(await readBody(req));
        const record = state.refresh.get(form.get("token"));
        if (opts.revokeStatus !== 200) return send(res, opts.revokeStatus, { error: "server_error" });
        if (record && record.clientId === form.get("client_id")) revokeGrant(record.grantId);
        return send(res, 200);
      }
      if (req.method === "POST" && path === "/api/v1/assistant/tool-call") {
        state.counts.toolCall++;
        const body = JSON.parse(await readBody(req));
        const bearer = (req.headers.authorization || "").replace(/^Bearer /, "");
        state.toolRequests.push({ bearer, body, contentType: req.headers["content-type"] });
        if (state.toolOverride) return send(res, state.toolOverride.status, state.toolOverride.body);
        const token = state.access.get(bearer);
        if (!token || token.expiresAt <= Date.now()) return send(res, 401, { error: "unauthorized" });
        if (body.name !== "GetExecutionStatus") return send(res, 403, { error: "mcp_token_scope" });
        const next = state.toolResponses.length > 1 ? state.toolResponses.shift() : state.toolResponses[0];
        return send(res, 200, next ?? { content: [{ type: "text", text: JSON.stringify(finished()) }] });
      }
      return send(res, 404, { error: "not_found" });
    } catch {
      if (!res.headersSent) send(res, 500, { error: "server_error" });
    }
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  return {
    origin,
    mcpUrl: `${origin}/mcp`,
    state,
    opts,
    /** Play the browser: follow the authorize URL, then hit the loopback redirect. */
    async approve(authorizeUrl, { extraStateFirst = false } = {}) {
      const authorized = await fetch(authorizeUrl, { redirect: "manual" });
      const location = authorized.headers.get("location");
      if (extraStateFirst) {
        // A request with the wrong state must be ignored; the right one still works.
        const bad = new URL(location);
        bad.searchParams.set("state", "wrong-state-value");
        const badResponse = await fetch(bad.href);
        await badResponse.text();
        const missing = new URL(location);
        missing.searchParams.delete("state");
        const missingResponse = await fetch(missing.href);
        await missingResponse.text();
        const elsewhere = new URL(location);
        elsewhere.pathname = "/other";
        const elsewhereResponse = await fetch(elsewhere.href);
        await elsewhereResponse.text();
        return { badStatus: badResponse.status, missingStatus: missingResponse.status, otherStatus: elsewhereResponse.status, final: await fetch(location).then(async (r) => (await r.text(), r.status)) };
      }
      const final = await fetch(location);
      await final.text();
      return { final: final.status };
    },
    issueDirect(scope = "runs.watch", expiresIn = opts.expiresIn) {
      const grantId = mint("grant", false);
      return issue("direct-client", grantId, scope, expiresIn);
    },
    allSecrets() {
      return [...state.secrets].filter(Boolean);
    },
    close() {
      server.closeAllConnections();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

export function finished(status = "Passed") {
  return {
    executionId: "x",
    status,
    terminal: true,
    retryAfterSeconds: 10,
    progress: { stepsTotal: 3, stepsDone: 3, currentStep: null },
    errorMessage: null,
  };
}
