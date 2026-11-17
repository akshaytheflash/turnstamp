#!/usr/bin/env node
import cp from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  appendEvent,
  checkTree,
  ledgerPath,
  readLedger,
  treeDigest,
} from "../src/ledger.js";
import { diffTrees, hashTree } from "../src/tree.js";
import { initLedger, installClaudeCode, installOpencode } from "../src/install.js";

const HELP = `turnstamp - prove what your agent actually did

Usage
  turnstamp init                     create the ledger for this project
  turnstamp install [agent]          wire up OpenCode and Claude Code hooks
  turnstamp stamp [options]          manual snapshot, when no hook is installed
  turnstamp event --json '{...}'     record one agent event yourself
  turnstamp verify [--json] [--staged]
                                     check the chain and who changed what
  turnstamp log [--turn N] [--json]  read the ledger back

install takes: opencode, claude, both (default)
              and --scope user to write to your home directory

verify exits 1 when the chain is broken or a file no longer matches what an
agent recorded. --staged only judges the paths git is about to commit, so it
works as a pre-commit hook.
`;

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    } else {
      args._.push(token);
    }
  }
  return args;
}

// Rebuilds the file map as it stood at the end of a turn, by replaying the per
// file entries that belong to that turn.
function snapshotAtTurn(entries, turn) {
  const map = new Map();
  for (const entry of entries) {
    if (!entry.target || entry.turn !== turn) continue;
    if (entry.action === "delete") {
      map.delete(entry.target);
    } else {
      map.set(entry.target, entry.detail);
    }
  }
  return map;
}

function snapshotTurns(entries) {
  const turns = new Set();
  for (const entry of entries) {
    if (!entry.target && entry.action === "snapshot" && typeof entry.turn === "number") {
      turns.add(entry.turn);
    }
  }
  return [...turns].sort((a, b) => a - b);
}

function nextTurn(entries) {
  let max = -1;
  for (const entry of entries) {
    if (typeof entry.turn === "number" && entry.turn > max) {
      max = entry.turn;
    }
  }
  return max + 1;
}

function cmdInit() {
  const file = initLedger(process.cwd());
  console.log(`ready ${path.relative(process.cwd(), file)}`);
  return 0;
}

function cmdInstall(args) {
  const which = args._[0] || "both";
  const scope = args.scope === "user" ? "user" : "project";
  const cwd = process.cwd();

  if (which === "opencode" || which === "both") {
    const result = installOpencode(scope, cwd);
    console.log(`opencode plugin written to ${result.dir}`);
  }

  if (which === "claude" || which === "both") {
    const result = installClaudeCode(scope, cwd);
    console.log(`claude code hooks merged into ${result.file}`);
  }

  const file = initLedger(cwd);
  console.log(`ledger ready at ${path.relative(cwd, file)}`);
  console.log("restart the agent, or start a new session, to pick this up");
  return 0;
}

// A stamp records the files that changed since the previous snapshot, one entry
// each, then a summary entry. verify replays those entries to catch rewrites.
function cmdStamp(args) {
  const root = process.cwd();
  const file = ledgerPath(root);
  const entries = readLedger(file);
  const tool = args.tool || "manual";
  const action = args.action || "snapshot";
  const turn = args.turn ? Number(args.turn) : nextTurn(entries);

  const now = hashTree(root);
  const previousTurns = snapshotTurns(entries);
  const previous =
    previousTurns.length > 0 ? snapshotAtTurn(entries, previousTurns.at(-1)) : new Map();

  const delta = diffTrees(previous, now);
  const touched = [...new Set([...delta.added, ...delta.changed, ...delta.removed])].sort();

  for (const target of touched) {
    const detail = now.get(target) ?? "missing";
    appendEvent(file, {
      turn,
      actor: "agent",
      kind: "file",
      tool,
      action: detail === "missing" ? "delete" : "write",
      target,
      detail,
    });
  }

  const summary = appendEvent(file, {
    turn,
    actor: "agent",
    kind: "call",
    tool,
    action,
    target: null,
    detail: JSON.stringify({
      files: now.size,
      added: delta.added.length,
      changed: delta.changed.length,
      removed: delta.removed.length,
      tree: treeDigest(now),
    }),
  });

  console.log(
    `stamped turn ${turn}: ${delta.added.length} added, ${delta.changed.length} changed, ` +
      `${delta.removed.length} removed (${now.size} files, ${summary.chain.slice(0, 12)})`,
  );
  return 0;
}

function short(value) {
  if (typeof value !== "string") return String(value);
  return value.length > 16 ? `${value.slice(0, 16)}...` : value;
}

// --staged limits the human-drift check to the paths git is about to commit.
// A broken chain is always fatal: that is the ledger itself, not the work.
function stagedTargets(root) {
  try {
    const { execFileSync } = cp;
    const raw = execFileSync("git", ["diff", "--cached", "--name-only", "-z"], {
      cwd: root,
      encoding: "utf8",
    });
    return new Set(raw.split("\0").filter(Boolean));
  } catch {
    return null;
  }
}

function cmdVerify(args) {
  const root = process.cwd();
  const file = ledgerPath(root);
  const report = checkTree(file, root);
  let drift = report.drift;

  if (args.staged) {
    const staged = stagedTargets(root);
    if (staged === null) {
      console.error("turnstamp: --staged needs git in this project");
      return 1;
    }
    drift = drift.filter((item) => staged.has(item.target));
  }

  const ok = report.ok && drift.length === 0;

  if (args.json) {
    console.log(JSON.stringify(args.staged ? { ...report, drift } : report, null, 2));
    return ok ? 0 : 1;
  }

  console.log(`ledger   ${path.relative(root, file)}`);
  console.log(`entries  ${report.count}`);
  console.log(`head     ${report.head.slice(0, 16)}`);

  if (report.ok) {
    console.log("chain    intact");
  } else {
    console.log("chain    BROKEN");
    for (const problem of report.problems) {
      console.log(`  ${problem.at}: ${problem.kind} - ${problem.message}`);
    }
  }

  const scope = args.staged ? " (staged only)" : "";
  if (drift.length === 0) {
    console.log(`files    every file matches what the agent recorded${scope}`);
  } else {
    console.log(`files    changed with no agent call behind them${scope}`);
    for (const item of drift) {
      const by = item.tool ? `last written by ${item.tool}` : "never seen by an agent";
      console.log(`  ${item.target}: ${by}, now ${short(item.current)}`);
    }
  }

  return ok ? 0 : 1;
}

function cmdLog(args) {
  const entries = readLedger(ledgerPath(process.cwd()));
  const filtered =
    args.turn !== undefined
      ? entries.filter((entry) => String(entry.turn) === String(args.turn))
      : entries;

  if (args.json) {
    console.log(JSON.stringify(filtered, null, 2));
    return 0;
  }

  if (filtered.length === 0) {
    console.log("nothing recorded yet");
    return 0;
  }

  for (const entry of filtered) {
    const when = entry.at.slice(11, 19);
    const turn = entry.turn === null ? "-" : String(entry.turn);
    console.log(
      `${when}  t${turn}  ${entry.tool}/${entry.action}  ${entry.target || "(turn)"}  ${entry.chain.slice(0, 10)}`,
    );
  }
  return 0;
}

function cmdEvent(args) {
  if (!args.json || args.json === true) {
    console.error("event needs --json '{...}'");
    return 1;
  }

  let payload;
  try {
    payload = JSON.parse(String(args.json));
  } catch (err) {
    console.error(`bad json: ${err.message}`);
    return 1;
  }

  const entry = appendEvent(ledgerPath(process.cwd()), payload);
  console.log(`${entry.seq} ${entry.chain.slice(0, 12)}`);
  return 0;
}

function main(argv) {
  const [command, ...rest] = argv;

  // --help can appear anywhere, and parseArgs would swallow it into args.
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(HELP);
    return 0;
  }

  const args = parseArgs(rest);

  if (!command || command === "help") {
    console.log(HELP);
    return 0;
  }

  switch (command) {
    case "init":
      return cmdInit();
    case "install":
      return cmdInstall(args);
    case "stamp":
      return cmdStamp(args);
    case "event":
      return cmdEvent(args);
    case "verify":
      return cmdVerify(args);
    case "log":
      return cmdLog(args);
    default:
      console.error(`unknown command: ${command}`);
      return 1;
  }
}

process.exitCode = main(process.argv.slice(2));
