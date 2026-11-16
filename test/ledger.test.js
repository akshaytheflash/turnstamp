import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  GENESIS,
  appendEvent,
  canonical,
  chainHash,
  checkTree,
  ledgerPath,
  readLedger,
  sha256,
  stamp,
  treeDigest,
  verifyEntries,
} from "../src/ledger.js";
import { diffTrees, hashTree } from "../src/tree.js";

function tempProject(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turnstamp-"));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

test("first entry links back to the genesis hash", () => {
  const root = tempProject({ "a.txt": "hello" });
  const file = ledgerPath(root);
  const entry = appendEvent(file, { tool: "claude", action: "write", target: "a.txt" });

  assert.equal(entry.seq, 1);
  assert.equal(entry.prev, GENESIS);
  assert.equal(entry.chain, chainHash(entry));
});

test("each entry points at the one before it", () => {
  const root = tempProject();
  const file = ledgerPath(root);

  const first = appendEvent(file, { tool: "claude", action: "read", target: "a.txt" });
  const second = appendEvent(file, { tool: "claude", action: "read", target: "b.txt" });

  assert.equal(second.prev, first.chain);
  assert.equal(second.seq, 2);
});

test("canonical form ignores key order", () => {
  const a = { seq: 1, tool: "x", action: "y", target: null, detail: null, prev: GENESIS, at: "t" };
  const b = { at: "t", prev: GENESIS, detail: null, target: null, action: "y", tool: "x", seq: 1 };

  assert.equal(canonical(a), canonical(b));
  assert.equal(chainHash(a), chainHash(b));
});

test("verify passes on an untouched ledger", () => {
  const root = tempProject();
  const file = ledgerPath(root);
  appendEvent(file, { tool: "claude", action: "read", target: "a.txt" });
  appendEvent(file, { tool: "claude", action: "read", target: "b.txt" });

  const report = verifyEntries(readLedger(file));
  assert.equal(report.ok, true);
  assert.equal(report.count, 2);
});

test("editing an entry's content is caught by the digest", () => {
  const root = tempProject();
  const file = ledgerPath(root);
  appendEvent(file, { tool: "claude", action: "write", target: "secret.env" });

  const entries = readLedger(file);
  entries[0].target = "harmless.txt";
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const report = verifyEntries(readLedger(file));
  assert.equal(report.ok, false);
  assert.equal(report.problems[0].kind, "digest");
});

test("re-hashing a tampered entry still breaks the next link", () => {
  const root = tempProject();
  const file = ledgerPath(root);
  appendEvent(file, { tool: "claude", action: "write", target: "one.txt" });
  appendEvent(file, { tool: "claude", action: "write", target: "two.txt" });

  const entries = readLedger(file);

  // A careful attacker fixes the digest too, the way a forger would.
  entries[0].target = "rewritten.txt";
  entries[0] = stamp(entries[0]);
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

  const report = verifyEntries(readLedger(file));
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((p) => p.kind === "link"));
});

test("deleting an entry in the middle is caught", () => {
  const root = tempProject();
  const file = ledgerPath(root);
  appendEvent(file, { tool: "a", action: "read", target: "1" });
  appendEvent(file, { tool: "a", action: "read", target: "2" });
  appendEvent(file, { tool: "a", action: "read", target: "3" });

  const entries = readLedger(file);
  fs.writeFileSync(file, [entries[0], entries[2]].map((e) => JSON.stringify(e)).join("\n") + "\n");

  const report = verifyEntries(readLedger(file));
  assert.equal(report.ok, false);
  assert.ok(report.problems.some((p) => p.kind === "sequence"));
});

test("empty ledger verifies cleanly", () => {
  const report = verifyEntries([]);
  assert.equal(report.ok, true);
  assert.equal(report.head, GENESIS);
  assert.equal(report.count, 0);
});

test("checkTree reports a file changed after it was stamped", () => {
  const root = tempProject({ "app.js": "console.log(1)" });
  const file = ledgerPath(root);

  const before = hashTree(root);
  appendEvent(file, { tool: "claude", action: "write", target: "app.js", detail: before.get("app.js") });

  let report = checkTree(file, root);
  assert.equal(report.drift.length, 0);

  fs.writeFileSync(path.join(root, "app.js"), "console.log(2)");
  report = checkTree(file, root);

  assert.equal(report.ok, true, "chain itself is still intact");
  assert.equal(report.drift.length, 1);
  assert.equal(report.drift[0].target, "app.js");
});

test("checkTree reports a stamped file that was deleted", () => {
  const root = tempProject({ "gone.txt": "bye" });
  const file = ledgerPath(root);
  const before = hashTree(root);
  appendEvent(file, { tool: "claude", action: "write", target: "gone.txt", detail: before.get("gone.txt") });

  fs.unlinkSync(path.join(root, "gone.txt"));
  const report = checkTree(file, root);

  assert.equal(report.drift.length, 1);
  assert.equal(report.drift[0].current, "missing");
});

test("hashTree skips node_modules, .git and the ledger itself", () => {
  const root = tempProject({
    "src/a.js": "a",
    "node_modules/dep/index.js": "noise",
    ".git/HEAD": "ref",
    ".turnstamp/ledger.jsonl": "{}",
  });

  const map = hashTree(root);
  assert.ok(map.has("src/a.js"));
  assert.equal(map.has("node_modules"), false);
  assert.equal(map.has(".git"), false);
  assert.equal(map.has(".turnstamp"), false);
});

test("diffTrees names what was added, changed and removed", () => {
  const before = new Map([
    ["keep.js", "aaa"],
    ["edit.js", "bbb"],
    ["drop.js", "ccc"],
  ]);
  const after = new Map([
    ["keep.js", "aaa"],
    ["edit.js", "zzz"],
    ["new.js", "ddd"],
  ]);

  const delta = diffTrees(before, after);
  assert.deepEqual(delta.added, ["new.js"]);
  assert.deepEqual(delta.changed, ["edit.js"]);
  assert.deepEqual(delta.removed, ["drop.js"]);
});

test("treeDigest does not depend on map insertion order", () => {
  const a = new Map([["x", "1"], ["y", "2"]]);
  const b = new Map([["y", "2"], ["x", "1"]]);
  assert.equal(treeDigest(a), treeDigest(b));
});

test("sha256 matches a known value", () => {
  assert.equal(sha256("turnstamp"), "d2724ede7d2464550aed75a2327f552961b612cd04b4229d308e6595c0f6f936");
  assert.equal(sha256("turnstamp"), sha256(Buffer.from("turnstamp", "utf8")));
});
