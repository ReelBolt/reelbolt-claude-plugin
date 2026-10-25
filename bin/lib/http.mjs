import { TransientError, describeNetworkError } from "./util.mjs";

const MAX_BODY_BYTES = 1 << 20;
export const DEFAULT_TIMEOUT_MS = 15_000;

async function readCapped(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new TransientError("response too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * One HTTP call. Redirects are refused outright (a token must never follow a
 * redirect to another host), the body is size-capped, and a failure carries
 * only a short code: never the URL query, a header or the response body.
 *
 * Resolves to { status, text, json } where json is the parsed body or null.
 */
export async function request(fetchImpl, url, { method = "GET", headers = {}, body, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let response;
  let text;
  try {
    response = await fetchImpl(url, {
      method,
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await readCapped(response);
  } catch (error) {
    if (error instanceof TransientError) throw error;
    throw new TransientError(describeNetworkError(error));
  }
  let json = null;
  try {
    const parsed = JSON.parse(text);
    json = parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    json = null;
  }
  return { status: response.status, text, json };
}

export function formBody(fields) {
  return new URLSearchParams(fields).toString();
}

export const FORM_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
};
