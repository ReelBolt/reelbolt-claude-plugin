// The watch loop: follow one workflow execution and print a line when it
// changes. Built for a Claude Code Monitor, where every stdout line becomes one
// notification, so stdout carries only short plain lines. Diagnostics go to
// stderr. Behaviour matches the ReelBolt MCP package's own watcher.
//
// Exit codes: 0 finished, 1 problem or time limit, 2 bad arguments,
// 3 sign-in missing or expired.

import { AccessDeniedError, AuthFatalError, WatcherError, isGuid, oneLine } from "./util.mjs";

const MAX_CONSECUTIVE_FAILURES = 5;
const MIN_SLEEP_S = 5;
const MAX_SLEEP_S = 60;
export const DEFAULT_MAX_MINUTES = 120;

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Parse the MCP text content defensively; null when the shape is not recognised. */
export function parseSnapshot(content) {
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const text = part.text;
    if (typeof text !== "string") continue;
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      continue;
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) continue;
    const o = json;
    if (typeof o.status !== "string" || typeof o.terminal !== "boolean") continue;
    // Real shape: progress{stepsTotal,stepsDone,currentStep{label}}, errorMessage.
    // The flat spellings are tolerated too; they are harmless.
    const p = o.progress && typeof o.progress === "object" ? o.progress : o;
    const cur = p.currentStep ?? o.currentStep;
    const label =
      typeof cur === "string"
        ? cur
        : cur && typeof cur === "object" && typeof cur.label === "string"
          ? cur.label
          : null;
    const err = typeof o.errorMessage === "string" && o.errorMessage ? o.errorMessage : o.error;
    return {
      status: o.status,
      terminal: o.terminal,
      stepsTotal: num(p.stepsTotal ?? o.stepsTotal),
      stepsDone: num(p.stepsDone ?? o.stepsDone),
      currentStep: label ? label : null,
      error: typeof err === "string" && err ? err : null,
      retryAfterSeconds: num(o.retryAfterSeconds),
    };
  }
  return null;
}

/**
 * The server answers HTTP 200 with {"error": "..."} when it cannot show the run (unknown run,
 * missing or unreachable project). Returns that message, or null for any other shape.
 */
export function parseRefusal(content) {
  for (const part of content) {
    if (!part || typeof part !== "object" || typeof part.text !== "string") continue;
    let json;
    try {
      json = JSON.parse(part.text);
    } catch {
      continue;
    }
    if (json && typeof json === "object" && !Array.isArray(json) && typeof json.status !== "string" && typeof json.error === "string" && json.error) {
      return json.error;
    }
  }
  return null;
}

function progressLine(s) {
  let line = oneLine(s.status, 40).toLowerCase();
  if (s.stepsTotal !== null && s.stepsDone !== null) line += ` ${s.stepsDone}/${s.stepsTotal}`;
  if (s.currentStep) line += ` - ${oneLine(s.currentStep, 80)}`;
  return line;
}

function terminalLine(s) {
  const status = s.status.toLowerCase();
  if (status.startsWith("pass") || status.startsWith("succe") || status.startsWith("complet")) {
    return "finished: Passed";
  }
  if (status.startsWith("cancel")) return "finished: Cancelled";
  if (status.startsWith("fail")) {
    return s.error ? `finished: Failed - ${oneLine(s.error, 200)}` : "finished: Failed";
  }
  return `finished: ${oneLine(s.status, 40)}`;
}

function failureText(error) {
  if (error instanceof WatcherError) return oneLine(error.message, 200);
  return oneLine(error && error.name ? error.name : "unexpected failure", 80);
}

/**
 * deps: { callStatus(args, context) -> {content}, out(line), err(line), now(), sleep(ms) }
 * Returns the process exit code.
 */
export async function watch(opts, deps) {
  const deadline = deps.now() + opts.maxMinutes * 60_000;
  const args = { executionId: opts.executionId };
  const context = opts.projectId ? { projectId: opts.projectId } : undefined;
  let lastKey = null;
  let failures = 0;
  let warnedShape = false;

  for (;;) {
    let sleepS = MIN_SLEEP_S;
    let failed = false;
    try {
      const res = await deps.callStatus(args, context);
      const snap = parseSnapshot(res.content);
      const refusal = snap ? null : parseRefusal(res.content);
      if (refusal) {
        // Retrying cannot change this answer.
        deps.out(`cannot read this run: ${oneLine(refusal, 200)}`);
        return 1;
      }
      if (!snap) {
        failed = true;
        if (!warnedShape) {
          warnedShape = true;
          deps.err("unexpected answer");
        }
      } else {
        failures = 0;
        if (snap.terminal) {
          deps.out(terminalLine(snap));
          return 0;
        }
        const key = `${snap.status}|${snap.stepsDone}|${snap.currentStep}`;
        if (key !== lastKey) {
          lastKey = key;
          deps.out(progressLine(snap));
        }
        sleepS = snap.retryAfterSeconds ?? MIN_SLEEP_S;
      }
    } catch (error) {
      if (error instanceof AuthFatalError) {
        deps.out(error.line);
        return 3;
      }
      if (error instanceof AccessDeniedError) {
        deps.out("cannot read this run: access denied");
        return 1;
      }
      failed = true;
      deps.err(`transient error: ${failureText(error)}`);
    }

    if (failed) {
      failures += 1;
      if (failures >= MAX_CONSECUTIVE_FAILURES) {
        deps.out("lost contact with ReelBolt");
        return 1;
      }
      // Exponential backoff on failures: 5, 10, 20, 40 s (capped).
      sleepS = Math.min(MAX_SLEEP_S, MIN_SLEEP_S * 2 ** (failures - 1));
    }

    sleepS = Math.min(MAX_SLEEP_S, Math.max(MIN_SLEEP_S, sleepS));
    if (deps.now() + sleepS * 1000 > deadline) {
      deps.out(`still running after ${opts.maxMinutes} minutes`);
      return 1;
    }
    await deps.sleep(sleepS * 1000);
  }
}

/** Returns { opts } or { error }. Ids must be GUIDs: nothing else is ever sent to the server. */
export function parseWatchArgs(argv) {
  let executionId;
  let projectId;
  let maxMinutes = DEFAULT_MAX_MINUTES;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--project") {
      projectId = argv[++i];
      if (!projectId) return { error: "--project needs a value" };
    } else if (a === "--max-minutes") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) return { error: "--max-minutes needs a positive number" };
      maxMinutes = n;
    } else if (a.startsWith("--") || executionId !== undefined) {
      return { error: `unexpected argument ${oneLine(a, 40)}` };
    } else {
      executionId = a;
    }
  }
  if (!executionId) return { error: "an execution id is required" };
  if (!isGuid(executionId)) return { error: "the execution id must be a GUID" };
  // The sign-in is not tied to a project the way a chat is, so the run's project is always needed.
  if (projectId === undefined) return { error: "--project <projectId> is required" };
  if (!isGuid(projectId)) return { error: "the project id must be a GUID" };
  return { opts: { executionId, projectId, maxMinutes } };
}
