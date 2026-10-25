#!/usr/bin/env node
// reelbolt-watch: sign in to ReelBolt with a read-only "runs.watch" sign-in and
// follow a workflow run, printing one short line per change. Built for a Claude
// Code Monitor. Needs Node 22 or newer and nothing else.
import { runCli } from "./lib/cli.mjs";

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  process.stderr.write("reelbolt-watch needs Node 22 or newer\n");
  process.exit(1);
}

const code = await runCli(process.argv.slice(2));
// Let buffered output drain before exiting, then do not wait on idle sockets.
process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
