// Keeps an access token fresh and talks to the status endpoint with it.
//
// The server rotates refresh tokens and treats a reused one as theft (it
// revokes the whole sign-in), so two watchers must never refresh the same
// token. Every refresh therefore happens under the credential lock, re-reads
// the file once the lock is held, and stores the new refresh token before the
// lock is released.

import {
  CredentialError,
  readCredentials,
  writeCredentials,
  withLock,
} from "./credentials.mjs";
import { refreshTokens } from "./oauth.mjs";
import { request } from "./http.mjs";
import {
  AccessDeniedError,
  AuthFatalError,
  TransientError,
  oneLine,
} from "./util.mjs";

export const REFRESH_MARGIN_MS = 60_000;
const STATUS_PATH = "/api/v1/assistant/tool-call";

export function signInAgainLine(origin) {
  return `sign-in expired: run reelbolt-watch login --server ${origin}`;
}

export const NOT_SIGNED_IN_LINE = "not signed in: run reelbolt-watch login --server <your ReelBolt MCP URL>";

/** Read the stored sign-in, turning "missing" and "unusable" into the lines a Monitor shows. */
export function loadCredentials(dir) {
  let creds;
  try {
    creds = readCredentials(dir);
  } catch (error) {
    if (error instanceof CredentialError) {
      throw new AuthFatalError(`sign-in unusable: ${oneLine(error.message, 300)}`);
    }
    throw error;
  }
  if (!creds) throw new AuthFatalError(NOT_SIGNED_IN_LINE);
  return creds;
}

export function createAuth({ dir, fetchImpl = fetch, now = () => Date.now(), lockOptions = {} }) {
  function stillFresh(creds) {
    return creds.accessToken !== "" && creds.accessTokenExpiresAt - now() > REFRESH_MARGIN_MS;
  }

  /**
   * Refresh under the lock unless another process already did. `seen` is the
   * access token the caller was using; if the file now holds a different,
   * still-valid one, that is somebody else's refresh and it is used as is.
   */
  async function refresh(seen) {
    try {
      return await withLock(
        dir,
        async () => {
          const current = loadCredentials(dir);
          if (current.accessToken !== seen && stillFresh(current)) return current;
          const tokens = await refreshTokens({
            tokenEndpoint: current.tokenEndpoint,
            clientId: current.clientId,
            refreshToken: current.refreshToken,
            fetchImpl,
            now: now(),
            signInAgainLine: signInAgainLine(current.issuer),
          });
          const next = {
            ...current,
            refreshToken: tokens.refreshToken,
            accessToken: tokens.accessToken,
            accessTokenExpiresAt: tokens.accessTokenExpiresAt,
          };
          writeCredentials(dir, next);
          return next;
        },
        lockOptions
      );
    } catch (error) {
      if (error instanceof CredentialError) {
        throw new AuthFatalError(`sign-in unusable: ${oneLine(error.message, 300)}`);
      }
      throw error;
    }
  }

  /** The sign-in with an access token good for at least a minute. */
  async function current() {
    const creds = loadCredentials(dir);
    if (stillFresh(creds)) return creds;
    return refresh(creds.accessToken);
  }

  return { current, refresh };
}

/**
 * The status reader: POST the one tool call the watcher is allowed to make.
 * A 401 refreshes once and retries; a refused scope or a dead refresh ends in
 * AuthFatalError (exit 3).
 */
export function createStatusClient({ auth, fetchImpl = fetch }) {
  async function post(creds, payload) {
    return request(fetchImpl, `${creds.issuer}${STATUS_PATH}`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${creds.accessToken}`,
      },
      body: JSON.stringify(payload),
    });
  }

  return {
    async callStatus(args, context) {
      const payload = { name: "GetExecutionStatus", arguments: args };
      if (context) payload.context = context;

      let creds = await auth.current();
      let response = await post(creds, payload);
      if (response.status === 401) {
        creds = await auth.refresh(creds.accessToken);
        response = await post(creds, payload);
        if (response.status === 401) throw new AuthFatalError(signInAgainLine(creds.issuer));
      }
      if (response.status === 403) {
        if (response.json && response.json.error === "mcp_token_scope") {
          throw new AuthFatalError(signInAgainLine(creds.issuer));
        }
        throw new AccessDeniedError();
      }
      if (response.status < 200 || response.status >= 300) {
        throw new TransientError(`HTTP ${response.status}`);
      }
      const content = response.json && Array.isArray(response.json.content) ? response.json.content : [];
      return { content };
    },
  };
}
