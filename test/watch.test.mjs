import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseSnapshot, parseWatchArgs, watch } from "../bin/lib/watch.mjs";
import { AccessDeniedError, AuthFatalError, TransientError, oneLine } from "../bin/lib/util.mjs";

const snap = (o) => {
  const { stepsDone, stepsTotal, currentStep, error, ...rest } = o;
  const real = {
    executionId: "x",
    terminal: false,
    retryAfterSeconds: 10,
    hint: "h",
    creditsCharged: 0,
    billingEnabled: false,
    outputs: [],
    ...rest,
    progress: {
      stepsTotal: stepsTotal ?? null,
      stepsDone: stepsDone ?? 0,
      currentStep: currentStep ? { stepOrder: 1, label: currentStep, stepType: "X" } : null,
    },
    errorMessage: error ?? null,
  };
  return { content: [{ type: "text", text: JSON.stringify(real) }] };
};

function harness(steps, maxMinutes = 120) {
  const out = [];
  const err = [];
  const sleeps = [];
  let t = 0;
  let i = 0;
  const calls = [];
  const deps = {
    callStatus: async (...a) => {
      calls.push(a);
      const s = steps[Math.min(i++, steps.length - 1)];
      if (s instanceof Error) throw s;
      return s;
    },
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    now: () => t,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  };
  return { out, err, sleeps, calls, run: () => watch({ executionId: "e1", projectId: "p1", maxMinutes }, deps) };
}

test("terminal at once", async () => {
  const h = harness([snap({ status: "Passed", terminal: true })]);
  assert.equal(await h.run(), 0);
  assert.deepEqual(h.out, ["finished: Passed"]);
  assert.deepEqual(h.calls[0], [{ executionId: "e1" }, { projectId: "p1" }]);
});

test("running -> running -> passed, no duplicate lines", async () => {
  const h = harness([
    snap({ status: "Running", stepsDone: 3, stepsTotal: 9, currentStep: "Render" }),
    snap({ status: "Running", stepsDone: 3, stepsTotal: 9, currentStep: "Render" }),
    snap({ status: "Running", stepsDone: 4, stepsTotal: 9, currentStep: "Mix" }),
    snap({ status: "Passed", terminal: true }),
  ]);
  assert.equal(await h.run(), 0);
  assert.deepEqual(h.out, ["running 3/9 - Render", "running 4/9 - Mix", "finished: Passed"]);
  assert.deepEqual(h.sleeps, [10000, 10000, 10000]);
});

test("failed with a long error is cut to 200 characters", async () => {
  const h = harness([snap({ status: "Failed", terminal: true, error: "x".repeat(500) })]);
  assert.equal(await h.run(), 0);
  assert.equal(h.out[0], `finished: Failed - ${"x".repeat(200)}`);
});

test("failed without an error message", async () => {
  const h = harness([snap({ status: "Failed", terminal: true })]);
  assert.equal(await h.run(), 0);
  assert.deepEqual(h.out, ["finished: Failed"]);
});

test("cancelled exits 0; an unknown terminal status is shown once, short", async () => {
  const c = harness([snap({ status: "Cancelled", terminal: true })]);
  assert.equal(await c.run(), 0);
  assert.deepEqual(c.out, ["finished: Cancelled"]);
  const u = harness([snap({ status: "Weird".repeat(30), terminal: true })]);
  assert.equal(await u.run(), 0);
  assert.equal(u.out[0], `finished: ${"Weird".repeat(30).slice(0, 40)}`);
});

test("untrusted text is stripped of control characters and flattened to one line", async () => {
  const hostile = "line one\nline two\u001b[31mred\u001b[0m\r‮evil\u0007 tail";
  const h = harness([snap({ status: "Failed", terminal: true, error: hostile })]);
  assert.equal(await h.run(), 0);
  assert.equal(h.out.length, 1);
  assert.doesNotMatch(h.out[0], /[\u0000-\u001f\u007f-\u009f‮]/);
  assert.match(h.out[0], /^finished: Failed - line one line two/);

  const step = harness([snap({ status: "Running", stepsDone: 1, stepsTotal: 2, currentStep: "a\nb\u001bc".repeat(40) }), snap({ status: "Passed", terminal: true })]);
  await step.run();
  assert.equal(step.out[0].split("\n").length, 1);
  assert.ok(step.out[0].length <= "running 1/2 - ".length + 80);

  assert.equal(oneLine("a\tb\u0000c", 10), "a b c");
});

test("a lost-contact streak: transient errors recover, five in a row give up", async () => {
  const h = harness([new TransientError("down"), new TransientError("down"), snap({ status: "Passed", terminal: true })]);
  assert.equal(await h.run(), 0);
  assert.deepEqual(h.out, ["finished: Passed"]);
  assert.deepEqual(h.sleeps, [5000, 10000]);

  const bad = harness([new Error("down")]);
  assert.equal(await bad.run(), 1);
  assert.deepEqual(bad.out, ["lost contact with ReelBolt"]);
  assert.deepEqual(bad.sleeps, [5000, 10000, 20000, 40000]);
});

test("unexpected error text never reaches stderr unless it was written for people", async () => {
  const h = harness([new Error("Bearer fakeaccess-leak-1 in a message")]);
  await h.run();
  assert.ok(!h.err.join("\n").includes("fakeaccess-leak-1"));
});

test("an unexpected answer shape warns once on stderr", async () => {
  const h = harness([{ content: [{ type: "text", text: "hello" }] }]);
  assert.equal(await h.run(), 1);
  assert.equal(h.err.filter((l) => l === "unexpected answer").length, 1);
});

test("sleep is clamped to 5..60 seconds", async () => {
  const h = harness([
    snap({ status: "Running", retryAfterSeconds: 1 }),
    snap({ status: "Running", retryAfterSeconds: 500 }),
    snap({ status: "Passed", terminal: true }),
  ]);
  await h.run();
  assert.deepEqual(h.sleeps, [5000, 60000]);
});

test("--max-minutes ends the watch with a line and exit 1", async () => {
  const h = harness([snap({ status: "Running", retryAfterSeconds: 60 })], 2);
  assert.equal(await h.run(), 1);
  assert.equal(h.out.at(-1), "still running after 2 minutes");
});

test("a sign-in problem prints its one line and exits 3", async () => {
  const h = harness([new AuthFatalError("sign-in expired: run reelbolt-watch login --server https://reelbolt.ai")]);
  assert.equal(await h.run(), 3);
  assert.deepEqual(h.out, ["sign-in expired: run reelbolt-watch login --server https://reelbolt.ai"]);
});

test("a refused read says so on stdout and exits 1", async () => {
  const h = harness([new AccessDeniedError()]);
  assert.equal(await h.run(), 1);
  assert.deepEqual(h.out, ["cannot read this run: access denied"]);
});

const G1 = "11111111-1111-4111-8111-111111111111";
const G2 = "22222222-2222-4222-8222-222222222222";

test("argument parsing", () => {
  assert.deepEqual(parseWatchArgs([G1, "--project", G2, "--max-minutes", "5"]).opts, { executionId: G1, projectId: G2, maxMinutes: 5 });
  assert.deepEqual(parseWatchArgs([G1, "--project", G2]).opts, { executionId: G1, projectId: G2, maxMinutes: 120 });
  assert.match(parseWatchArgs([G1]).error, /--project/);
  for (const bad of [[], [G1, "--bogus"], [G1, "--max-minutes", "x"], [G1, "--max-minutes", "0"], [G1, G2], [G1, "--project"]]) {
    assert.ok(parseWatchArgs(bad).error, JSON.stringify(bad));
  }
});

test("an error answer from the server ends the watch at once, without retries", async () => {
  const refusal = { content: [{ type: "text", text: JSON.stringify({ error: "Execution not found.", hint: "Check the id." }) }] };
  const h = harness([refusal]);
  assert.equal(await h.run(), 1);
  assert.deepEqual(h.out, ["cannot read this run: Execution not found."]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.sleeps.length, 0);
});

test("ids that are not GUIDs are rejected before any request", () => {
  for (const id of ["abc", "../etc/passwd", `${G1}/extra`, `${G1}\n`, "1111111111114111811111111111111", "{" + G1 + "}", `${G1}?x=1`]) {
    assert.match(parseWatchArgs([id]).error, /GUID/, id);
    assert.match(parseWatchArgs([G1, "--project", id]).error, /GUID/, id);
  }
});

// ---- parseSnapshot agrees with the ReelBolt MCP package's own watcher ----

const wrap = (value) => [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }];
const SAMPLES = [
  wrap({ status: "Running", terminal: false, progress: { stepsTotal: 9, stepsDone: 3, currentStep: { stepOrder: 1, label: "Render", stepType: "X" } }, errorMessage: null, retryAfterSeconds: 12 }),
  wrap({ status: "Passed", terminal: true, progress: { stepsTotal: 3, stepsDone: 3, currentStep: null }, errorMessage: null }),
  wrap({ status: "Failed", terminal: true, progress: { stepsTotal: 3, stepsDone: 1, currentStep: null }, errorMessage: "Render crashed" }),
  wrap({ status: "Running", terminal: false, stepsTotal: 4, stepsDone: 2, currentStep: "Mix", retryAfterSeconds: 7 }),
  wrap({ status: "Running", terminal: false, error: "flat error spelling" }),
  wrap({ status: "Running", terminal: false, progress: { stepsTotal: "3", stepsDone: null } }),
  wrap({ status: "Running" }),
  wrap({ terminal: true }),
  wrap([1, 2, 3]),
  wrap("hello"),
  wrap("null"),
  [{ type: "image" }, null, 7, ...wrap({ status: "Cancelled", terminal: true })],
  [],
];

const EXPECTED = [
  { status: "Running", terminal: false, stepsTotal: 9, stepsDone: 3, currentStep: "Render", error: null, retryAfterSeconds: 12 },
  { status: "Passed", terminal: true, stepsTotal: 3, stepsDone: 3, currentStep: null, error: null, retryAfterSeconds: null },
  { status: "Failed", terminal: true, stepsTotal: 3, stepsDone: 1, currentStep: null, error: "Render crashed", retryAfterSeconds: null },
  { status: "Running", terminal: false, stepsTotal: 4, stepsDone: 2, currentStep: "Mix", error: null, retryAfterSeconds: 7 },
  { status: "Running", terminal: false, stepsTotal: null, stepsDone: null, currentStep: null, error: "flat error spelling", retryAfterSeconds: null },
  { status: "Running", terminal: false, stepsTotal: null, stepsDone: null, currentStep: null, error: null, retryAfterSeconds: null },
  null,
  null,
  null,
  null,
  null,
  { status: "Cancelled", terminal: true, stepsTotal: null, stepsDone: null, currentStep: null, error: null, retryAfterSeconds: null },
  null,
];

test("parseSnapshot gives the documented result for every sample", () => {
  SAMPLES.forEach((sample, i) => assert.deepEqual(parseSnapshot(sample), EXPECTED[i], `sample ${i}`));
});

// Only present when the source repository's MCP package has been built; the
// published plugin has no such file, and the inline fixtures above are the check.
const mcpWatch = fileURLToPath(new URL("../../../mcp/dist/watch.js", import.meta.url));
test("parseSnapshot matches the MCP package's own parser when it is built", { skip: !existsSync(mcpWatch) }, async () => {
  const theirs = await import(pathToFileURL(mcpWatch).href);
  SAMPLES.forEach((sample, i) => assert.deepEqual(parseSnapshot(sample), theirs.parseSnapshot(sample), `sample ${i}`));
});
