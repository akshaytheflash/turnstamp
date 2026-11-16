#!/usr/bin/env node
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

const HELP = `turnstamp - prove what your agent actually did

Usage
  turnstamp init                     create the ledger for this project
  turnstamp stamp [options]          record the current state of the tree
  turnstamp event --json '{...}'     record one agent event (for hooks)
  turnstamp verify [--json]          check the chain and the files on disk
  turnstamp log [--turn N] [--json]  read the ledger back

Options for stamp
  --turn N         which agent turn this belongs to, defaults to the next one
  --tool NAME      tool name, defaults to manual
  --action NAME    action name, defaults to snapshot

verify exits 1 when the chain is broken or a stamped file changed on disk.
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
  const file = ledgerPath(process.cwd());
  if (fs.existsSync(file)) {
    console.log("ledger already exists");
    return 0;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "", "utf8");
  console.log(`created ${path.relative(process.cwd(), file)}`);
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
      tool,
      action: detail === "missing" ? "delete" : "write",
      target,
      detail,
    });
  }

  const summary = appendEvent(file, {
    turn,
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

function cmdVerify(args) {
  const root = process.cwd();
  const file = ledgerPath(root);
  const report = checkTree(file, root);
  const ok = report.ok && report.drift.length === 0;

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
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

  if (report.drift.length === 0) {
    console.log("files    match the last stamp");
  } else {
    console.log("files    changed after they were stamped");
    for (const item of report.drift) {
      console.log(`  ${item.target}: stamped ${short(item.stamped)}, now ${short(item.current)}`);
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
  const args = parseArgs(rest);

  if (!command || command === "help" || args.help) {
    console.log(HELP);
    return 0;
  }

  switch (command) {
    case "init":
      return cmdInit();
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
