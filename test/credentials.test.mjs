import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CredentialError,
  LockTimeoutError,
  credentialDir,
  credentialPaths,
  deleteCredentials,
  readCredentials,
  withLock,
  writeCredentials,
} from "../bin/lib/credentials.mjs";
import { cleanupAll, newHome } from "./helpers/harness.mjs";

after(cleanupAll);

const posix = process.platform !== "win32";
const record = () => ({
  version: 1,
  server: "https://reelbolt.ai/mcp",
  issuer: "https://reelbolt.ai",
  clientId: "client-1",
  tokenEndpoint: "https://reelbolt.ai/oauth/token",
  revocationEndpoint: "https://reelbolt.ai/oauth/revoke",
  refreshToken: "fakerefresh-test-1",
  accessToken: "fakeaccess-test-1",
  accessTokenExpiresAt: Date.now() + 3_600_000,
  scope: "runs.watch",
});

test("directory resolution: explicit home, XDG, default", () => {
  assert.equal(credentialDir({ REELBOLT_WATCH_HOME: "/x/y" }), path.resolve("/x/y"));
  if (posix) {
    assert.equal(credentialDir({ XDG_CONFIG_HOME: "/cfg" }), path.join("/cfg", "reelbolt"));
    assert.match(credentialDir({}), /\.config[\\/]reelbolt$/);
  }
});

test("round trip, unknown fields dropped", { skip: !posix }, () => {
  const { dir } = newHome();
  writeCredentials(dir, { ...record(), extra: "ignored" });
  const read = readCredentials(dir);
  assert.deepEqual(read, record_with(read));
  assert.equal(Object.hasOwn(read, "extra"), false);
  const onDisk = JSON.parse(fs.readFileSync(credentialPaths(dir).file, "utf8"));
  assert.equal(Object.hasOwn(onDisk, "extra"), false);
});

function record_with(read) {
  return { ...record(), accessTokenExpiresAt: read.accessTokenExpiresAt };
}

test("directory is created 0700 and the file 0600", { skip: !posix }, () => {
  const { dir } = newHome();
  writeCredentials(dir, record());
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(credentialPaths(dir).file).mode & 0o777, 0o600);
});

test("the file is private from its first instant, even with umask 0", { skip: !posix }, () => {
  const { dir } = newHome();
  const previous = process.umask(0);
  try {
    let tempMode = null;
    writeCredentials(dir, record(), {
      afterCreate: (temp) => {
        tempMode = fs.statSync(temp).mode & 0o777;
      },
    });
    assert.equal(tempMode, 0o600);
    assert.equal(fs.statSync(credentialPaths(dir).file).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  } finally {
    process.umask(previous);
  }
});

test("a failed write leaves the old file and no temp file behind", { skip: !posix }, () => {
  const { dir } = newHome();
  writeCredentials(dir, record());
  assert.throws(
    () =>
      writeCredentials(dir, { ...record(), refreshToken: "fakerefresh-test-2" }, {
        afterCreate: () => {
          throw new Error("boom");
        },
      }),
    CredentialError
  );
  assert.equal(readCredentials(dir).refreshToken, "fakerefresh-test-1");
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.endsWith(".tmp")), []);
});

test("a missing file or directory is 'not signed in', not an error", () => {
  const { dir } = newHome();
  assert.equal(readCredentials(dir), null);
  const made = newHome({ create: true });
  assert.equal(readCredentials(made.dir), null);
});

test("a group/other readable file is refused with an instruction, not silently fixed", { skip: !posix }, () => {
  const { dir } = newHome();
  writeCredentials(dir, record());
  const { file } = credentialPaths(dir);
  fs.chmodSync(file, 0o644);
  assert.throws(() => readCredentials(dir), (e) => e instanceof CredentialError && /chmod 600/.test(e.message) && !/fakerefresh/.test(e.message));
  assert.equal(fs.statSync(file).mode & 0o777, 0o644, "the mode must not be changed behind the user's back");
  fs.chmodSync(file, 0o640);
  assert.throws(() => readCredentials(dir), CredentialError);
  fs.chmodSync(file, 0o604);
  assert.throws(() => readCredentials(dir), CredentialError);
});

test("a loose directory is refused", { skip: !posix }, () => {
  const { dir } = newHome();
  writeCredentials(dir, record());
  fs.chmodSync(dir, 0o755);
  assert.throws(() => readCredentials(dir), (e) => e instanceof CredentialError && /chmod 700/.test(e.message));
  assert.throws(() => writeCredentials(dir, record()), CredentialError);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o755);
});

test("a symlinked credential file is refused", { skip: !posix }, () => {
  const { dir, root } = newHome();
  writeCredentials(dir, record());
  const { file } = credentialPaths(dir);
  const real = path.join(root, "real.json");
  fs.renameSync(file, real);
  fs.symlinkSync(real, file);
  assert.throws(() => readCredentials(dir), (e) => e instanceof CredentialError && /symbolic link/.test(e.message));
});

test("a symlinked credential directory is refused", { skip: !posix }, () => {
  const { dir, root } = newHome();
  writeCredentials(dir, record());
  const link = path.join(root, "link");
  fs.symlinkSync(dir, link);
  assert.throws(() => readCredentials(link), (e) => e instanceof CredentialError && /symbolic link/.test(e.message));
});

test("malformed, wrong-version, wrong-type and cross-origin records are refused without echoing the content", { skip: !posix }, () => {
  const { dir } = newHome();
  const { file } = credentialPaths(dir);
  const put = (text) => {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, text, { mode: 0o600 });
  };
  const bad = [
    "not json at all fakerefresh-secret",
    "[]",
    JSON.stringify({ ...record(), version: 2 }),
    JSON.stringify({ ...record(), refreshToken: "" }),
    JSON.stringify({ ...record(), accessTokenExpiresAt: "soon" }),
    JSON.stringify({ ...record(), scope: "assistant.tools" }),
    JSON.stringify({ ...record(), scope: "runs.watch assistant.tools" }),
    JSON.stringify({ ...record(), tokenEndpoint: "https://evil.example/oauth/token" }),
    JSON.stringify({ ...record(), revocationEndpoint: "https://evil.example/oauth/revoke" }),
    JSON.stringify({ ...record(), issuer: "http://reelbolt.ai" }),
    JSON.stringify({ ...record(), issuer: "https://reelbolt.ai/with/path" }),
    JSON.stringify({ ...record(), server: "ftp://reelbolt.ai/mcp" }),
  ];
  for (const text of bad) {
    put(text);
    assert.throws(
      () => readCredentials(dir),
      (e) => e instanceof CredentialError && !/fakerefresh|fakeaccess/.test(e.message),
      text.slice(0, 40)
    );
  }
});

test("deleteCredentials removes the file, and is quiet when there is none", { skip: !posix }, () => {
  const { dir } = newHome();
  assert.equal(deleteCredentials(dir), false);
  writeCredentials(dir, record());
  assert.equal(deleteCredentials(dir), true);
  assert.equal(readCredentials(dir), null);
});

test("the lock is exclusive and released afterwards", { skip: !posix }, async () => {
  const { dir } = newHome();
  const order = [];
  const first = withLock(dir, async () => {
    order.push("a-start");
    await new Promise((r) => setTimeout(r, 150));
    order.push("a-end");
  });
  await new Promise((r) => setTimeout(r, 30));
  const second = withLock(dir, async () => {
    order.push("b");
  }, { pollMs: 20 });
  await Promise.all([first, second]);
  assert.deepEqual(order, ["a-start", "a-end", "b"]);
  assert.equal(fs.existsSync(credentialPaths(dir).lock), false);
});

test("the lock is released when the work throws", { skip: !posix }, async () => {
  const { dir } = newHome();
  await assert.rejects(withLock(dir, async () => { throw new Error("x"); }), /x/);
  assert.equal(fs.existsSync(credentialPaths(dir).lock), false);
});

test("waiting for a held lock is bounded", { skip: !posix }, async () => {
  const { dir } = newHome();
  const held = withLock(dir, () => new Promise((r) => setTimeout(r, 400)));
  await new Promise((r) => setTimeout(r, 30));
  await assert.rejects(withLock(dir, async () => {}, { waitMs: 100, pollMs: 20 }), LockTimeoutError);
  await held;
});

test("a lock whose owner is dead is taken over", { skip: !posix }, async () => {
  const { dir } = newHome({ create: true });
  const { lock } = credentialPaths(dir);
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, t: Date.now(), nonce: "n" }), { mode: 0o600 });
  let ran = false;
  await withLock(dir, async () => { ran = true; }, { waitMs: 500, pollMs: 10 });
  assert.equal(ran, true);
});

test("a lock older than the stale limit is taken over even if the pid looks alive", { skip: !posix }, async () => {
  const { dir } = newHome({ create: true });
  const { lock } = credentialPaths(dir);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, t: Date.now() - 60_000, nonce: "n" }), { mode: 0o600 });
  let ran = false;
  await withLock(dir, async () => { ran = true; }, { waitMs: 500, pollMs: 10, staleMs: 30_000 });
  assert.equal(ran, true);
});

test("a fresh lock from a live process is not taken over", { skip: !posix }, async () => {
  const { dir } = newHome({ create: true });
  const { lock } = credentialPaths(dir);
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, t: Date.now(), nonce: "n" }), { mode: 0o600 });
  await assert.rejects(withLock(dir, async () => {}, { waitMs: 80, pollMs: 10 }), LockTimeoutError);
  assert.equal(fs.existsSync(lock), true);
});

test("releasing never deletes a lock somebody else now owns", { skip: !posix }, async () => {
  const { dir } = newHome();
  const { lock } = credentialPaths(dir);
  await withLock(dir, async () => {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, t: Date.now(), nonce: "someone-else" }), { mode: 0o600 });
  });
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).nonce, "someone-else");
});
