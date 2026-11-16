#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

import { appendEvent, ledgerPath } from "../src/ledger.js";
import { normalizeTarget } from "../src/events.js";
import { isFileTool, readState, shellCommand, toolPaths } from "../src/tools.js";

// Claude Code hook.
//
// Reads the event JSON on stdin and appends one entry. It runs inline on every
// tool call, so it does no tree walking and makes no network calls.
//
// Register it for PreToolUse and PostToolUse on the file tools, and for Bash so
// shell commands show up too.

async function readStdin() {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function rootOf(payload) {
  return path.resolve(payload.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

function pendingFile(root, call) {
  const safe = String(call).replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(root, ".turnstamp", "pending", `${safe}.json`);
}

// The before state has to survive until the after hook runs, and that is a
// separate process, so it goes to a small side file.
function writePending(root, call, states) {
  if (!call) return;
  const file = pendingFile(root, call);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(states), "utf8");
}

function readPending(root, call) {
  if (!call) return [];
  try {
    return JSON.parse(fs.readFileSync(pendingFile(root, call), "utf8"));
  } catch {
    return [];
  }
}

function clearPending(root, call) {
  if (!call) return;
  try {
    fs.unlinkSync(pendingFile(root, call));
  } catch {
    // Already gone.
  }
}

function fileStates(root, tool, input) {
  return toolPaths(tool, input)
    .map((p) => normalizeTarget(root, p))
    .filter(Boolean)
    .map((target) => ({ target, before: readState(path.join(root, target)) }));
}

function onBefore(root, file, fields) {
  const { tool, session, call, input } = fields;

  if (isFileTool(tool)) {
    const states = fileStates(root, tool, input);
    appendEvent(file, {
      actor: "claude-code",
      kind: "call",
      session,
      call,
      tool,
      action: "call",
      detail: JSON.stringify({ phase: "before", files: states.map((s) => s.target) }),
    });
    writePending(root, call, states);
    return;
  }

  const command = tool === "Bash" || tool === "PowerShell" ? shellCommand(input) : null;
  appendEvent(file, {
    actor: "claude-code",
    kind: "call",
    session,
    call,
    tool,
    action: command ? "shell" : "call",
    target: command,
    detail: JSON.stringify({ phase: "before" }),
  });
}

function onAfter(root, file, fields) {
  const { tool, session, call, input, failed } = fields;

  if (!isFileTool(tool)) {
    appendEvent(file, {
      actor: "claude-code",
      kind: "call",
      session,
      call,
      tool,
      action: failed ? "failed" : "done",
      detail: null,
    });
    return;
  }

  const held = readPending(root, call);
  const states = held.length ? held : fileStates(root, tool, input);

  for (const item of states) {
    if (!item.target) continue;
    const after = readState(path.join(root, item.target));
    appendEvent(file, {
      actor: "claude-code",
      kind: "file",
      session,
      call,
      tool,
      action: after === "missing" ? "delete" : "write",
      target: item.target,
      before: item.before ?? null,
      detail: after,
    });
  }

  clearPending(root, call);
}

function main(payload) {
  const root = rootOf(payload);
  const file = ledgerPath(root);
  const fields = {
    tool: String(payload.tool_name || "unknown"),
    session: String(payload.session_id || ""),
    call: String(payload.tool_use_id || ""),
    input: payload.tool_input || {},
    failed: payload.hook_event_name === "PostToolUseFailure",
  };

  switch (payload.hook_event_name) {
    case "PreToolUse":
      onBefore(root, file, fields);
      break;
    case "PostToolUse":
    case "PostToolUseFailure":
      onAfter(root, file, fields);
      break;
    default:
      break;
  }
}

const raw = await readStdin();
if (raw.trim()) {
  try {
    main(JSON.parse(raw));
  } catch (err) {
    // A hook must never break the session. Exit 0 with no output is a no-op.
    process.stderr.write(`turnstamp hook: ${err.message}\n`);
  }
}
process.exit(0);
