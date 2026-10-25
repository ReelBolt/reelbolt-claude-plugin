// Command-line front end. Every command returns the process exit code.

import { createAuth, createStatusClient, loadCredentials } from "./auth.mjs";
import { credentialDir } from "./credentials.mjs";
import { login, logout, status } from "./login.mjs";
import { parseWatchArgs, watch } from "./watch.mjs";
import { AuthFatalError, WatcherError, oneLine } from "./util.mjs";

export const USAGE = [
  "usage: reelbolt-watch <command>",
  "",
  "  login --server <ReelBolt MCP URL> [--no-browser]   sign in (opens your browser)",
  "  logout                                            revoke the sign-in and delete it from this computer",
  "  status                                            show whether you are signed in",
  "  <executionId> --project <projectId> [--max-minutes N]",
  "                                                    print a line each time a run changes, until it ends",
  "",
  "exit codes: 0 finished, 1 problem or time limit, 2 bad arguments, 3 sign in needed",
].join("\n");

export function defaultIo() {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    env: process.env,
    fetch: globalThis.fetch,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

function parseLoginArgs(argv) {
  let server;
  let openInBrowser = true;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--no-browser") openInBrowser = false;
    else if (a === "--server") server = argv[++i];
    else if (a.startsWith("--server=")) server = a.slice("--server=".length);
    else return { error: `unexpected argument ${oneLine(a, 40)}` };
  }
  if (!server) return { error: "login needs --server <ReelBolt MCP URL>" };
  return { server, openInBrowser };
}

async function runWatch(argv, io, dir) {
  const parsed = parseWatchArgs(argv);
  if (parsed.error) {
    io.err(`${parsed.error}\n${USAGE}`);
    return 2;
  }
  try {
    // Fail fast, before the first poll, so a Monitor sees why it ended.
    loadCredentials(dir);
    const auth = createAuth({ dir, fetchImpl: io.fetch, now: io.now, lockOptions: io.lockOptions });
    const client = createStatusClient({ auth, fetchImpl: io.fetch });
    return await watch(parsed.opts, {
      callStatus: (args, context) => client.callStatus(args, context),
      out: io.out,
      err: io.err,
      now: io.now,
      sleep: io.sleep,
    });
  } catch (error) {
    if (error instanceof AuthFatalError) {
      io.out(error.line);
      return 3;
    }
    throw error;
  }
}

export async function runCli(argv, io = defaultIo()) {
  const [command, ...rest] = argv;
  if (!command) {
    io.err(USAGE);
    return 2;
  }
  if (command === "-h" || command === "--help" || command === "help") {
    io.out(USAGE);
    return 0;
  }
  const dir = credentialDir(io.env);
  try {
    switch (command) {
      case "login": {
        const parsed = parseLoginArgs(rest);
        if (parsed.error) {
          io.err(`${parsed.error}\n${USAGE}`);
          return 2;
        }
        return await login(parsed, { dir, io });
      }
      case "logout":
        if (rest.length) {
          io.err(USAGE);
          return 2;
        }
        return await logout({ dir, io });
      case "status":
        if (rest.length) {
          io.err(USAGE);
          return 2;
        }
        return status({ dir, io });
      case "watch":
        return await runWatch(rest, io, dir);
      default:
        if (command.startsWith("-")) {
          io.err(USAGE);
          return 2;
        }
        return await runWatch(argv, io, dir);
    }
  } catch (error) {
    // Only messages written for people reach here; anything else is reduced to a name.
    io.err(error instanceof WatcherError ? oneLine(error.message, 400) : `unexpected failure (${oneLine(error && error.name, 40)})`);
    return 1;
  }
}
