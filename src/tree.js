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

const IGNORE_FILE = ".turnstampignore";

function sha256(input) {
  return createHash("sha256").update(input).digest("hex");
}

// .turnstampignore is gitignore-shaped on purpose: blank lines and lines
// starting with # are ignored, a trailing slash means a directory, and a
// pattern with no slash in it matches that name at any depth.
export function readIgnoreRules(root) {
  const file = path.join(root, IGNORE_FILE);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((pattern) => {
      const dirOnly = pattern.endsWith("/");
      const body = dirOnly ? pattern.slice(0, -1) : pattern;
      const anchored = body.includes("/");
      return {
        raw: pattern,
        dirOnly,
        anchored,
        test: globToRegExp(body),
      };
    });
}

// A small glob: ** crosses directories, * stays inside one, ? is one character.
function globToRegExp(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if (".+^$()[]{}|\\".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

function isIgnored(rel, isDir, rules) {
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    if (rule.anchored) {
      if (rule.test.test(rel)) return true;
      continue;
    }
    // unanchored: any path segment may match
    const parts = rel.split("/");
    for (let i = 0; i < parts.length; i += 1) {
      const tail = parts.slice(i).join("/");
      if (rule.test.test(tail)) return true;
    }
  }
  return false;
}

export function fileHash(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// Walks the directory and returns a target -> digest map. Directories are
// recorded as "dir" so an empty folder is still accounted for in the ledger.
// Everything named in .turnstampignore is skipped, and so are the built-in
// heavy directories, so a ledger never fills up with node_modules.
export function hashTree(root, options = {}) {
  const prefix = options.prefix || "";
  const rules = readIgnoreRules(root);
  const out = new Map();
  let inspected = 0;
  let skipped = 0;

  function walk(dir, relative) {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }

    for (const name of names.sort()) {
      const full = path.join(dir, name);
      const rel = relative ? `${relative}/${name}` : name;

      if (SKIP_DIRS.has(name) || name === IGNORE_FILE) {
        continue;
      }

      let stat;
      try {
        stat = fs.lstatSync(full);
      } catch {
        continue;
      }

      inspected += 1;

      if (isIgnored(rel, stat.isDirectory(), rules)) {
        skipped += 1;
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
  Object.defineProperty(out, "inspected", { value: inspected, enumerable: false });
  Object.defineProperty(out, "skipped", { value: skipped, enumerable: false });
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
