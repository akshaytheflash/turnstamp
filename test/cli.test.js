import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { appendEvent, checkTree, ledgerPath } from "../src/ledger.js";
import { hashTree } from "../src/tree.js";

const CLI = path.join(import.meta.dirname, "..", "bin", "turnstamp.js");

function tempProject(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turnstamp-cli-"));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

function run(root, ...args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      cwd: root,
      encoding: "utf8",
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: `${err.stdout || ""}${err.stderr || ""}` };
  }
}

test("init creates the ledger file", () => {
  const root = tempProject();
  const out = run(root, "init");
  assert.equal(out.code, 0);
  assert.ok(fs.existsSync(ledgerPath(root)));
});

test("stamp then verify succeeds on a clean tree", () => {
  const root = tempProject({ "src/a.js": "one" });
  assert.equal(run(root, "init").code, 0);

  const stamped = run(root, "stamp", "--turn", "1", "--tool", "claude");
  assert.match(stamped.stdout, /stamped turn 1/);

  const verified = run(root, "verify");
  assert.equal(verified.code, 0);
  assert.match(verified.stdout, /chain    intact/);
  assert.match(verified.stdout, /files    match the last stamp/);
});

test("verify fails when a stamped file is rewritten", () => {
  const root = tempProject({ "src/a.js": "one" });
  run(root, "stamp", "--turn", "1");
  fs.writeFileSync(path.join(root, "src/a.js"), "two");

  const verified = run(root, "verify");
  assert.equal(verified.code, 1);
  assert.match(verified.stdout, /src\/a\.js/);
});

test("second stamp records only the delta", () => {
  const root = tempProject({ "a.js": "1", "b.js": "1" });
  run(root, "stamp", "--turn", "1");
  fs.writeFileSync(path.join(root, "a.js"), "2");
  fs.writeFileSync(path.join(root, "c.js"), "1");

  const second = run(root, "stamp", "--turn", "2");
  assert.match(second.stdout, /1 added, 1 changed, 0 removed/);
});

test("log can be filtered to a single turn", () => {
  const root = tempProject({ "a.js": "1" });
  run(root, "stamp", "--turn", "1");
  fs.writeFileSync(path.join(root, "a.js"), "2");
  run(root, "stamp", "--turn", "2");

  const out = run(root, "log", "--turn", "1");
  assert.equal(out.code, 0);
  assert.match(out.stdout, /t1/);
  assert.doesNotMatch(out.stdout, /t2/);
});

test("event records a hook payload", () => {
  const root = tempProject();
  const out = run(root, "event", "--json", '{"turn":4,"tool":"claude","action":"bash","target":"npm test"}');
  assert.equal(out.code, 0);
  assert.match(out.stdout, /^\d+ [0-9a-f]{12}$/m);
});

test("a shell command target is not treated as a file", () => {
  const root = tempProject({ "a.js": "1" });
  const file = ledgerPath(root);
  appendEvent(file, { turn: 1, tool: "claude", action: "bash", target: "npm install", detail: "exit 0" });

  const report = checkTree(file, root);
  assert.equal(report.drift.length, 0);
});

test("event rejects bad json", () => {
  const root = tempProject();
  const out = run(root, "event", "--json", "nope");
  assert.equal(out.code, 1);
  assert.match(out.stdout, /bad json/);
});

test("a deleted file shows as missing drift", () => {
  const root = tempProject({ "keep.js": "1", "drop.js": "1" });
  const file = ledgerPath(root);
  const before = hashTree(root);
  appendEvent(file, { turn: 1, action: "write", target: "drop.js", detail: before.get("drop.js") });

  fs.unlinkSync(path.join(root, "drop.js"));
  const report = checkTree(file, root);
  assert.equal(report.drift[0].current, "missing");
});
