// The OAuth 2.1 pieces the watcher needs: discovery, dynamic registration of a
// loopback public client, PKCE, the one-shot loopback listener, and the token,
// refresh and revoke calls. Nothing here prints; callers decide what to show.

import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import {
  AuthFatalError,
  TransientError,
  WatcherError,
  oauthErrorCode,
  parseTrustedUrl,
  sameOrigin,
} from "./util.mjs";
import { FORM_HEADERS, formBody, request } from "./http.mjs";
import { REQUIRED_SCOPE } from "./credentials.mjs";

export const CLIENT_NAME = "ReelBolt run watcher";
export const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

const JSON_HEADERS = { Accept: "application/json" };

export function scopeIsExactlyRunsWatch(scope) {
  if (typeof scope !== "string") return false;
  const parts = scope.split(/\s+/).filter(Boolean);
  return parts.length === 1 && parts[0] === REQUIRED_SCOPE;
}

// -------------------------------------------------------------- discovery --

function endpoint(metadata, field, issuer) {
  const value = metadata[field];
  if (typeof value !== "string") throw new WatcherError(`the sign-in server does not publish ${field}`);
  const url = parseTrustedUrl(value, field);
  if (!sameOrigin(url.href, issuer)) {
    throw new WatcherError(`the sign-in server points ${field} at a different host; refusing to continue`);
  }
  return url.href;
}

/**
 * Find the authorization server of a ReelBolt MCP address and read its
 * endpoints. The authorization server and every endpoint must live on the same
 * origin as the address the person typed.
 */
export async function discover(serverText, fetchImpl) {
  const server = parseTrustedUrl(serverText, "--server");
  const origin = server.origin;

  const resource = await request(fetchImpl, `${origin}/.well-known/oauth-protected-resource`, { headers: JSON_HEADERS });
  if (resource.status !== 200 || !resource.json) {
    throw new WatcherError(`could not read the ReelBolt sign-in details from ${origin} (HTTP ${resource.status})`);
  }
  const servers = resource.json.authorization_servers;
  if (!Array.isArray(servers) || typeof servers[0] !== "string") {
    throw new WatcherError("the server did not name a sign-in server");
  }
  const authorization = parseTrustedUrl(servers[0], "the sign-in server");
  if (authorization.origin !== origin || authorization.pathname !== "/" || authorization.search) {
    throw new WatcherError("the server names a sign-in server on a different host; refusing to continue");
  }
  const issuer = authorization.origin;

  const meta = await request(fetchImpl, `${issuer}/.well-known/oauth-authorization-server`, { headers: JSON_HEADERS });
  if (meta.status !== 200 || !meta.json) {
    throw new WatcherError(`could not read the sign-in server's settings (HTTP ${meta.status})`);
  }
  const advertised = typeof meta.json.issuer === "string" ? meta.json.issuer.replace(/\/+$/, "") : "";
  if (advertised !== issuer) {
    throw new WatcherError("the sign-in server's settings name a different issuer; refusing to continue");
  }
  const scopes = Array.isArray(meta.json.scopes_supported) ? meta.json.scopes_supported : [];
  if (!scopes.includes(REQUIRED_SCOPE)) {
    throw new WatcherError("this ReelBolt server is too old for the run watcher (it does not offer the runs.watch sign-in)");
  }
  const methods = meta.json.code_challenge_methods_supported;
  if (Array.isArray(methods) && !methods.includes("S256")) {
    throw new WatcherError("the sign-in server does not support PKCE S256");
  }
  return {
    server: server.href,
    issuer,
    authorizationEndpoint: endpoint(meta.json, "authorization_endpoint", issuer),
    tokenEndpoint: endpoint(meta.json, "token_endpoint", issuer),
    revocationEndpoint: endpoint(meta.json, "revocation_endpoint", issuer),
    registrationEndpoint: endpoint(meta.json, "registration_endpoint", issuer),
  };
}

export async function registerClient(registrationEndpoint, redirectUri, fetchImpl) {
  const response = await request(fetchImpl, registrationEndpoint, {
    method: "POST",
    headers: { ...JSON_HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: REQUIRED_SCOPE,
    }),
  });
  if (response.status !== 201 && response.status !== 200) {
    throw new WatcherError(`could not register with the sign-in server (HTTP ${response.status}, ${oauthErrorCode(response.json)})`);
  }
  const clientId = response.json && response.json.client_id;
  if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 512) {
    throw new WatcherError("the sign-in server's registration answer was not understood");
  }
  return clientId;
}

// ------------------------------------------------------------------- PKCE --

export function generatePkce() {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function randomState() {
  return randomBytes(24).toString("base64url");
}

export function buildAuthorizeUrl(authorizationEndpoint, { clientId, redirectUri, state, challenge }) {
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", REQUIRED_SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.href;
}

// ----------------------------------------------------- loopback listener --

function digest(value) {
  return createHash("sha256").update(value).digest();
}

function statesMatch(received, expected) {
  return timingSafeEqual(digest(received), digest(expected));
}

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  "X-Content-Type-Options": "nosniff",
};

function page(message) {
  return `<!doctype html><meta charset="utf-8"><title>ReelBolt</title><style>body{font:16px system-ui;margin:3rem auto;max-width:28rem;padding:0 1rem}</style><p>${message}</p>`;
}

/**
 * A one-shot HTTP listener on 127.0.0.1 (never any other interface). It
 * accepts exactly one valid callback for /callback with the expected state;
 * every other request gets a 400 and the wait goes on.
 */
export async function startCallbackListener() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  let expectedState = null;
  let done = false;
  let settle;
  const outcome = new Promise((resolve) => {
    settle = resolve;
  });

  server.on("request", (req, res) => {
    const reject = () => {
      res.writeHead(400, PAGE_HEADERS);
      res.end(page("This address is not the ReelBolt sign-in callback."));
    };
    if (done || req.method !== "GET" || req.headers.host !== `127.0.0.1:${port}` || expectedState === null) {
      reject();
      return;
    }
    let url;
    try {
      url = new URL(req.url || "/", "http://127.0.0.1");
    } catch {
      reject();
      return;
    }
    const states = url.searchParams.getAll("state");
    if (url.pathname !== "/callback" || states.length !== 1 || !statesMatch(states[0], expectedState)) {
      reject();
      return;
    }
    const errorCode = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (errorCode === null && (code === null || code.length === 0 || code.length > 2048)) {
      reject();
      return;
    }
    done = true;
    const result =
      errorCode !== null
        ? { error: /^[a-z_]{1,40}$/.test(errorCode) ? errorCode : "unknown" }
        : { code };
    res.writeHead(200, PAGE_HEADERS);
    res.once("finish", () => settle(result));
    res.end(page(result.error ? "Sign-in cancelled. You can close this tab." : "Signed in. You can close this tab and return to Claude Code."));
  });

  return {
    redirectUri,
    port,
    address: server.address().address,
    expect(state) {
      expectedState = state;
    },
    /** Resolves { code } or { error }; rejects on timeout. */
    wait(timeoutMs = CALLBACK_TIMEOUT_MS) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new WatcherError("timed out waiting for the browser sign-in (5 minutes)")), timeoutMs);
        outcome.then((value) => {
          clearTimeout(timer);
          resolve(value);
        });
      });
    },
    close() {
      server.close();
      if (typeof server.closeAllConnections === "function") server.closeAllConnections();
    },
  };
}

/** Best-effort browser launch: one argv entry, never a shell. */
export function openBrowser(url, run = execFile) {
  let command;
  let args;
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "rundll32";
    args = ["url.dll,FileProtocolHandler", url];
  } else {
    command = "xdg-open";
    args = [url];
  }
  try {
    run(command, args, { windowsHide: true, timeout: 10_000 }, () => {});
  } catch {
    // The URL was printed; the person can open it by hand.
  }
}

// --------------------------------------------------------------- tokens ---

function parseTokenResponse(json, now) {
  const accessToken = json && json.access_token;
  const refreshToken = json && json.refresh_token;
  const expiresIn = json && json.expires_in;
  const tokenType = json && json.token_type;
  if (
    typeof accessToken !== "string" || accessToken.length === 0 || accessToken.length > 8192 ||
    typeof refreshToken !== "string" || refreshToken.length === 0 || refreshToken.length > 4096 ||
    typeof expiresIn !== "number" || !Number.isFinite(expiresIn) || expiresIn <= 0 ||
    typeof tokenType !== "string" || tokenType.toLowerCase() !== "bearer"
  ) {
    throw new WatcherError("the sign-in server's token answer was not understood");
  }
  return {
    accessToken,
    refreshToken,
    accessTokenExpiresAt: now + Math.floor(expiresIn * 1000),
    scope: typeof json.scope === "string" ? json.scope : "",
  };
}

/** Exchange the authorization code. Returns the tokens and the scope exactly as granted. */
export async function exchangeCode({ tokenEndpoint, clientId, code, verifier, redirectUri, fetchImpl, now }) {
  const response = await request(fetchImpl, tokenEndpoint, {
    method: "POST",
    headers: FORM_HEADERS,
    body: formBody({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      client_id: clientId,
    }),
  });
  if (response.status !== 200) {
    throw new WatcherError(`the sign-in server refused the sign-in (HTTP ${response.status}, ${oauthErrorCode(response.json)})`);
  }
  return parseTokenResponse(response.json, now);
}

/**
 * Use a refresh token. invalid_grant (the grant is gone, or the token was
 * already used) is final: the person has to sign in again.
 */
export async function refreshTokens({ tokenEndpoint, clientId, refreshToken, fetchImpl, now, signInAgainLine }) {
  const response = await request(fetchImpl, tokenEndpoint, {
    method: "POST",
    headers: FORM_HEADERS,
    body: formBody({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId }),
  });
  if (response.status === 200) {
    const tokens = parseTokenResponse(response.json, now);
    if (!scopeIsExactlyRunsWatch(tokens.scope)) throw new AuthFatalError(signInAgainLine);
    return tokens;
  }
  const code = oauthErrorCode(response.json);
  if ((response.status === 400 || response.status === 401) && ["invalid_grant", "invalid_client", "unauthorized_client"].includes(code)) {
    throw new AuthFatalError(signInAgainLine);
  }
  throw new TransientError(`the sign-in server answered HTTP ${response.status}`);
}

/** Revoke a refresh token (RFC 7009). Resolves true when the server answered 200. */
export async function revokeToken({ revocationEndpoint, clientId, refreshToken, fetchImpl }) {
  try {
    const response = await request(fetchImpl, revocationEndpoint, {
      method: "POST",
      headers: FORM_HEADERS,
      body: formBody({ token: refreshToken, token_type_hint: "refresh_token", client_id: clientId }),
    });
    return response.status === 200;
  } catch {
    return false;
  }
}
