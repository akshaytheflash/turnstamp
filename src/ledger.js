import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const GENESIS = "0".repeat(64);
export const SCHEMA = 1;

// Every entry hashes the previous one, so changing anything in the middle breaks
// every hash after it. The canonical form is built by hand instead of relying on
// JSON.stringify, because object key order is not something we want to trust.
// The chain value is excluded on purpose: it is computed from everything else,
// so including it would make the hash depend on itself.
const FIELDS = [
  "schema",
  "seq",
  "at",
  "turn",
  "tool",
  "action",
  "target",
  "detail",
  "prev",
];

export function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

// One digest for a whole file map. Sorting first means the answer never depends
// on the order the filesystem happened to hand names back in.
export function treeDigest(map) {
  const parts = [...map.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, hash]) => `${name}:${hash}`);
  return sha256(parts.join("\n"));
}

export function canonical(entry) {
  const ordered = {};
  for (const key of FIELDS) {
    const value = entry[key];
    ordered[key] = value === undefined ? null : value;
  }
  return JSON.stringify(ordered);
}

export function chainHash(entry) {
  return sha256(canonical(entry));
}

// An entry is complete once it has a chain value. Everything else is data.
export function stamp(entry) {
  const next = { ...entry };
  next.schema = SCHEMA;
  next.chain = chainHash(next);
  return next;
}

export function ledgerPath(cwd = process.cwd()) {
  return path.join(cwd, ".turnstamp", "ledger.jsonl");
}

export function readLedger(file) {
  if (!fs.existsSync(file)) {
    return [];
  }
  const raw = fs.readFileSync(file, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  return lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (err) {
      throw new Error(`line ${index + 1} is not valid JSON: ${err.message}`);
    }
  });
}

export function writeLedger(file, entries) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = entries.map((entry) => JSON.stringify(entry)).join("\n");
  fs.writeFileSync(file, entries.length ? body + "\n" : "", "utf8");
}

export function lastHash(entries) {
  if (entries.length === 0) {
    return GENESIS;
  }
  return entries[entries.length - 1].chain;
}

// Appends one event. Called by the CLI and by wrappers around agent hooks.
export function appendEvent(file, event) {
  const entries = readLedger(file);
  const seq = entries.length + 1;
  const entry = stamp({
    schema: SCHEMA,
    seq,
    at: event.at || new Date().toISOString(),
    turn: event.turn ?? null,
    tool: event.tool || "unknown",
    action: event.action || "event",
    target: event.target ?? null,
    detail: event.detail ?? null,
    prev: lastHash(entries),
  });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf8");
  return entry;
}

// Recomputes every hash and checks that each entry points at the one before it.
// Returns a report instead of throwing, so callers can print all the damage at once.
export function verifyEntries(entries) {
  const problems = [];
  let prev = GENESIS;

  entries.forEach((entry, index) => {
    const where = `entry ${index + 1}`;

    if (entry.seq !== index + 1) {
      problems.push({
        at: where,
        kind: "sequence",
        message: `expected seq ${index + 1}, found ${entry.seq}`,
      });
    }

    if (entry.prev !== prev) {
      problems.push({
        at: where,
        kind: "link",
        message: `does not point at the entry before it`,
      });
    }

    const expected = chainHash(entry);
    if (entry.chain !== expected) {
      problems.push({
        at: where,
        kind: "digest",
        message: `content changed after it was stamped`,
      });
    }

    prev = entry.chain;
  });

  return {
    ok: problems.length === 0,
    count: entries.length,
    head: prev,
    problems,
  };
}

// Reads the ledger off disk and decides whether the working tree still matches
// what the last stamps said it looked like.
export function checkTree(file, root = process.cwd()) {
  const entries = readLedger(file);
  const report = verifyEntries(entries);

  const lastByTarget = new Map();
  for (const entry of entries) {
    // Only write and delete describe a file's content. Other events can carry a
    // target too, like a shell command, and those are not files on disk.
    if (!entry.target || (entry.action !== "write" && entry.action !== "delete")) {
      continue;
    }
    lastByTarget.set(entry.target, entry);
  }

  const drift = [];
  for (const [target, entry] of lastByTarget) {
    const abs = path.join(root, target);
    let current = null;

    try {
      const stat = fs.statSync(abs);
      if (stat.isFile()) {
        current = sha256(fs.readFileSync(abs));
      } else if (stat.isDirectory()) {
        current = "dir";
      }
    } catch {
      current = "missing";
    }

    if (current !== entry.detail) {
      drift.push({
        target,
        stamped: entry.detail,
        current,
        at: entry.at,
      });
    }
  }

  return { ...report, drift };
}
