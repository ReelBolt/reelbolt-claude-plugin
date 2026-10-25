// login, logout and status.

import {
  CredentialError,
  REQUIRED_SCOPE,
  credentialPaths,
  deleteCredentials,
  ensureDirectory,
  readCredentials,
  withLock,
  writeCredentials,
} from "./credentials.mjs";
import {
  buildAuthorizeUrl,
  CALLBACK_TIMEOUT_MS,
  discover,
  exchangeCode,
  generatePkce,
  openBrowser,
  randomState,
  registerClient,
  revokeToken,
  scopeIsExactlyRunsWatch,
  startCallbackListener,
} from "./oauth.mjs";
import { oneLine } from "./util.mjs";

export const SIGNED_IN_LINE = "Signed in. This sign-in can only read the status of your runs.";

/** Returns the process exit code. io: { out, err, fetch, now, openBrowser?, callbackTimeoutMs? } */
export async function login({ server, openInBrowser }, { dir, io }) {
  const fetchImpl = io.fetch;
  const found = await discover(server, fetchImpl);

  const listener = await startCallbackListener();
  try {
    const clientId = await registerClient(found.registrationEndpoint, listener.redirectUri, fetchImpl);
    const { verifier, challenge } = generatePkce();
    const state = randomState();
    listener.expect(state);

    const authorizeUrl = buildAuthorizeUrl(found.authorizationEndpoint, {
      clientId,
      redirectUri: listener.redirectUri,
      state,
      challenge,
    });
    io.out("Open this address in your browser to sign in to ReelBolt:");
    io.out(authorizeUrl);
    if (openInBrowser) (io.openBrowser || openBrowser)(authorizeUrl);
    io.out("Waiting for you to approve in the browser (up to 5 minutes)...");

    const outcome = await listener.wait(io.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS);
    listener.close();

    if (outcome.error) {
      if (outcome.error === "access_denied") {
        io.err("Sign-in was declined in the browser. Nothing was stored.");
      } else {
        io.err(`The server refused the sign-in (${outcome.error}). Nothing was stored.`);
      }
      return 1;
    }

    const tokens = await exchangeCode({
      tokenEndpoint: found.tokenEndpoint,
      clientId,
      code: outcome.code,
      verifier,
      redirectUri: listener.redirectUri,
      fetchImpl,
      now: io.now(),
    });

    if (!scopeIsExactlyRunsWatch(tokens.scope)) {
      // A sign-in wider than asked for is never kept: revoke it and store nothing.
      const revoked = await revokeToken({
        revocationEndpoint: found.revocationEndpoint,
        clientId,
        refreshToken: tokens.refreshToken,
        fetchImpl,
      });
      io.err(
        "The server granted more access than the run watcher asked for. " +
          (revoked ? "The sign-in was revoked and nothing was stored." : "Nothing was stored, but the server could not be asked to revoke it.")
      );
      return 1;
    }

    ensureDirectory(dir);
    await withLock(dir, async () => {
      writeCredentials(dir, {
        version: 1,
        server: found.server,
        issuer: found.issuer,
        clientId,
        tokenEndpoint: found.tokenEndpoint,
        revocationEndpoint: found.revocationEndpoint,
        refreshToken: tokens.refreshToken,
        accessToken: tokens.accessToken,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        scope: REQUIRED_SCOPE,
      });
    });
    io.out(SIGNED_IN_LINE);
    io.out(`Server: ${found.issuer}`);
    return 0;
  } finally {
    listener.close();
  }
}

export async function logout({ dir, io }) {
  const { file } = credentialPaths(dir);
  let creds = null;
  let unusable = null;
  try {
    creds = readCredentials(dir);
  } catch (error) {
    if (!(error instanceof CredentialError)) throw error;
    unusable = error;
  }

  if (!creds && !unusable) {
    io.out("Not signed in; nothing to remove.");
    return 0;
  }

  if (creds) {
    const revoked = await revokeToken({
      revocationEndpoint: creds.revocationEndpoint,
      clientId: creds.clientId,
      refreshToken: creds.refreshToken,
      fetchImpl: io.fetch,
    });
    if (!revoked) {
      io.err("Could not reach the server to revoke the sign-in. It was removed from this computer only.");
    }
  } else {
    io.err(`The stored sign-in could not be read (${oneLine(unusable.message, 200)}). It was removed without revoking it on the server.`);
  }

  try {
    deleteCredentials(dir);
  } catch (error) {
    io.err(oneLine(error.message, 300));
    return 1;
  }
  io.out(`Signed out. Removed ${file}`);
  return 0;
}

export function status({ dir, io }) {
  let creds;
  try {
    creds = readCredentials(dir);
  } catch (error) {
    if (error instanceof CredentialError) {
      io.out(`not signed in (the stored sign-in is unusable): ${oneLine(error.message, 300)}`);
      return 1;
    }
    throw error;
  }
  if (!creds) {
    io.out("not signed in");
    return 1;
  }
  io.out("signed in");
  io.out(`server: ${creds.issuer}`);
  io.out(`scope: ${creds.scope}`);
  const remaining = creds.accessTokenExpiresAt - io.now();
  io.out(
    remaining > 0
      ? `access token expires: ${new Date(creds.accessTokenExpiresAt).toISOString()}`
      : "access token expired; it is refreshed automatically on next use"
  );
  return 0;
}
