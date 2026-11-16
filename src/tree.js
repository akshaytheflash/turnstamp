import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".turnstamp",
  "dist",
  "build",
  "target",
  ".venv",
  "__pycache__",
]);

export function fileHash(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Walks the directory and returns a target -> digest map. Directories are
// recorded as "dir" so an empty folder is still accounted for in the ledger.
export function hashTree(root, options = {}) {
  const prefix = options.prefix || "";
  const out = new Map();

  function walk(dir, relative) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const name of names.sort()) {
      if (SKIP_DIRS.has(name)) {
        continue;
      }

      const full = path.join(dir, name);
      const rel = relative ? `${relative}/${name}` : name;
      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }

      if (stat.isSymbolicLink()) {
        out.set(rel, `link:${fs.readlinkSync(full)}`);
        continue;
      }

      if (stat.isDirectory()) {
        out.set(rel, "dir");
        walk(full, rel);
        continue;
      }

      if (stat.isFile()) {
        out.set(rel, fileHash(full));
      }
    }
  }

  walk(root, prefix);
  return out;
}

// Compares two maps and returns what appeared, changed and disappeared. Used by
// the snapshot writer so a turn records the delta, not the whole tree twice.
export function diffTrees(before, after) {
  const added = [];
  const changed = [];
  const removed = [];

  for (const [target, hash] of after) {
    if (!before.has(target)) {
      added.push(target);
    } else if (before.get(target) !== hash) {
      changed.push(target);
    }
  }

  for (const target of before.keys()) {
    if (!after.has(target)) {
      removed.push(target);
    }
  }

  return { added, changed, removed };
}
