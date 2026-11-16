import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { appendEvent, checkTree, ledgerPath, readLedger, verifyEntries } from "../src/ledger.js";
import { createTracker } from "../src/opencode-plugin.js";
import { isFileTool, patchPaths, toolPaths } from "../src/tools.js";

const HOOK = path.join(import.meta.dirname, "..", "hooks", "claude-code.js");

function tempProject(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turnstamp-attr-"));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

// Runs the Claude Code hook the way Claude Code does: JSON on stdin.
function runHook(root, payload) {
  execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ cwd: root, ...payload }),
    encoding: "utf8",
  });
}

function claudeWrite(root, file, call) {
  const abs = path.join(root, file);
  const base = {
    session_id: "ses_test",
    cwd: root,
    tool_name: "Write",
    tool_use_id: call,
    tool_input: { file_path: abs },
  };
  runHook(root, { ...base, hook_event_name: "PreToolUse" });
}

function claudeDone(root, file, call) {
  const abs = path.join(root, file);
  const base = {
    session_id: "ses_test",
    cwd: root,
    tool_name: "Write",
    tool_use_id: call,
    tool_input: { file_path: abs },
  };
  runHook(root, { ...base, hook_event_name: "PostToolUse" });
}

test("claude hook records a write as an agent file event", () => {
  const root = tempProject();
  claudeWrite(root, "app.js", "t1");
  fs.writeFileSync(path.join(root, "app.js"), "console.log(1)");
  claudeDone(root, "app.js", "t1");

  const entries = readLedger(ledgerPath(root));
  const file = entries.find((e) => e.kind === "file");

  assert.ok(file, "expected a file entry");
  assert.equal(file.actor, "claude-code");
  assert.equal(file.target, "app.js");
  assert.equal(file.tool, "Write");
  assert.equal(file.before, "missing", "the file did not exist before the call");
  assert.equal(verifyEntries(entries).ok, true);
});

test("a file the agent wrote is reported as clean", () => {
  const root = tempProject();
  claudeWrite(root, "app.js", "t1");
  fs.writeFileSync(path.join(root, "app.js"), "one");
  claudeDone(root, "app.js", "t1");

  const report = checkTree(ledgerPath(root), root);
  assert.equal(report.ok, true);
  assert.equal(report.drift.length, 0);
});

test("a human rewrite after the agent is reported, with the agent named", () => {
  const root = tempProject();
  claudeWrite(root, "app.js", "t1");
  fs.writeFileSync(path.join(root, "app.js"), "agent wrote this");
  claudeDone(root, "app.js", "t1");

  fs.writeFileSync(path.join(root, "app.js"), "a human changed this");

  const report = checkTree(ledgerPath(root), root);
  assert.equal(report.drift.length, 1);
  assert.equal(report.drift[0].target, "app.js");
  assert.equal(report.drift[0].state, "human");
  assert.equal(report.drift[0].tool, "Write");
  assert.equal(report.ok, true, "the chain itself was not touched");
});

test("opencode tracker pairs before and after", () => {
  const root = tempProject();
  const tracker = createTracker({ root, actor: "opencode" });
  const input = { filePath: path.join(root, "lib/user.js") };

  tracker.before({ tool: "write", sessionID: "ses_1", id: "call_1", input });
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "lib", "user.js"), "export const a = 1");
  tracker.after({ tool: "write", sessionID: "ses_1", id: "call_1", input, status: "completed", result: {} });

  const entries = readLedger(ledgerPath(root));
  const file = entries.find((e) => e.kind === "file");

  assert.equal(file.actor, "opencode");
  assert.equal(file.target, "lib/user.js");
  assert.equal(file.before, "missing");
  assert.match(file.detail, /^[0-9a-f]{64}$/);
  assert.equal(verifyEntries(entries).ok, true);
});

test("an opencode edit records both sides of the change", () => {
  const root = tempProject({ "src/a.js": "before" });
  const tracker = createTracker({ root, actor: "opencode" });
  const input = { filePath: path.join(root, "src/a.js") };

  tracker.before({ tool: "edit", sessionID: "ses_1", id: "call_2", input });
  fs.writeFileSync(path.join(root, "src/a.js"), "after");
  tracker.after({ tool: "edit", sessionID: "ses_1", id: "call_2", input, status: "completed", result: {} });

  const file = readLedger(ledgerPath(root)).find((e) => e.kind === "file");
  assert.notEqual(file.before, file.detail);
  assert.equal(file.before.length, 64);
});

test("a shell call is recorded but claims no file", () => {
  const root = tempProject({ "a.js": "1" });
  const tracker = createTracker({ root, actor: "opencode" });
  tracker.before({ tool: "shell", sessionID: "s", id: "c1", input: { command: "npm test" } });
  tracker.after({ tool: "shell", sessionID: "s", id: "c1", input: { command: "npm test" }, status: "completed", result: {} });

  const entries = readLedger(ledgerPath(root));
  assert.ok(entries.some((e) => e.action === "shell" && e.target === "npm test"));
  assert.equal(entries.filter((e) => e.kind === "file").length, 0);

  // The tree was never claimed, so nothing is reported as drift either.
  assert.equal(checkTree(ledgerPath(root), root).drift.length, 0);
});

test("isFileTool accepts both naming styles", () => {
  assert.equal(isFileTool("Write"), true);
  assert.equal(isFileTool("write"), true);
  assert.equal(isFileTool("Edit"), true);
  assert.equal(isFileTool("edit"), true);
  assert.equal(isFileTool("MultiEdit"), true);
  assert.equal(isFileTool("NotebookEdit"), true);
  assert.equal(isFileTool("patch"), true);
  assert.equal(isFileTool("Bash"), false);
  assert.equal(isFileTool("shell"), false);
});

test("patch paths are read out of the patch body", () => {
  const body = [
    "*** Begin Patch",
    "*** Update File: src/a.js",
    "@@",
    "-old",
    "+new",
    "*** Add File: src/b.js",
    "+line",
    "*** End Patch",
  ].join("\n");

  assert.deepEqual(patchPaths({ patchText: body }), ["src/a.js", "src/b.js"]);
});

test("toolPaths reads filePath and file_path", () => {
  assert.deepEqual(toolPaths("write", { filePath: "/repo/a.js" }), ["/repo/a.js"]);
  assert.deepEqual(toolPaths("Write", { file_path: "/repo/b.js" }), ["/repo/b.js"]);
});

test("a failed tool call is recorded and does not claim a file", () => {
  const root = tempProject({ "a.js": "1" });
  const tracker = createTracker({ root, actor: "opencode" });
  const input = { filePath: path.join(root, "a.js") };

  tracker.before({ tool: "write", sessionID: "s", id: "c9", input });
  tracker.after({ tool: "write", sessionID: "s", id: "c9", input, status: "error", error: { message: "denied" } });

  const entries = readLedger(ledgerPath(root));
  const file = entries.find((e) => e.kind === "file");
  // The file was not written, so its hash still matches the old content.
  assert.equal(file.detail, file.before);
});

test("entries from a human actor are labelled as such", () => {
  const root = tempProject({ "notes.md": "hi" });
  const file = ledgerPath(root);
  appendEvent(file, {
    actor: "human",
    kind: "file",
    tool: "editor",
    action: "write",
    target: "notes.md",
    detail: "0123",
  });

  const [entry] = readLedger(file);
  assert.equal(entry.actor, "human");
  assert.equal(verifyEntries(readLedger(file)).ok, true);
});
