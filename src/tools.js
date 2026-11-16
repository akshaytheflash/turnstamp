import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// Tools that write files, and where each keeps the path in its input.
// OpenCode uses filePath. Anything new can be added here.
const PATH_KEYS = ["filePath", "file_path", "path"];

export function toolPaths(tool, input) {
  if (!input || typeof input !== "object") {
    return [];
  }

  if (String(tool).toLowerCase() === "patch") {
    return patchPaths(input);
  }

  const found = [];
  for (const key of PATH_KEYS) {
    if (typeof input[key] === "string") {
      found.push(input[key]);
    }
  }

  if (Array.isArray(input.filePaths)) {
    for (const p of input.filePaths) {
      if (typeof p === "string") found.push(p);
    }
  }

  return [...new Set(found)];
}

// The patch tool takes freeform text with the same headers git apply uses.
export function patchPaths(input) {
  const text =
    typeof input === "string" ? input : input.patchText || input.patch || input.text || "";
  if (typeof text !== "string") {
    return [];
  }

  const out = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/);
    if (match) {
      out.push(match[1].trim());
    }
  }
  return [...new Set(out)];
}

// Only these tools can leave a file behind. Compared case sensitively against
// lowercase names, because OpenCode says write while Claude Code says Write.
const FILE_TOOLS = new Set(["write", "edit", "multiedit", "patchedit", "notebookedit", "patch"]);

export function isFileTool(tool) {
  return FILE_TOOLS.has(String(tool).toLowerCase());
}

export function readState(abs) {
  try {
    const stat = fs.statSync(abs);
    if (!stat.isFile()) {
      return stat.isDirectory() ? "dir" : "other";
    }
    return createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
  } catch {
    return "missing";
  }
}

// A shell call can write files, but we cannot know which. Record it as a call
// so the ledger shows it happened, and let the next verify attribute whatever
// moved.
export function shellCommand(input) {
  if (typeof input === "string") {
    return input;
  }
  if (input && typeof input.command === "string") {
    return input.command;
  }
  return null;
}

export function projectRoot(cwd) {
  return path.resolve(cwd || process.cwd());
}
