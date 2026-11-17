import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { hashTree, readIgnoreRules } from "../src/tree.js";

function project(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "turnstamp-ignore-"));
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return root;
}

test("nothing ignored means everything is hashed", () => {
  const root = project({ "a.js": "a", "src/b.js": "b" });
  const tree = hashTree(root);
  assert.ok(tree.has("a.js"));
  assert.ok(tree.has("src/b.js"));
  assert.equal(tree.size, 3); // includes the src dir
});

test("a name with no slash matches at any depth", () => {
  const root = project({ ".turnstampignore": "*.lock\n", "a.lock": "x", "deep/b.lock": "y", "c.js": "z" });
  const tree = hashTree(root);
  assert.equal(tree.has("a.lock"), false);
  assert.equal(tree.has("deep/b.lock"), false);
  assert.equal(tree.has("c.js"), true);
});

test("a trailing slash only matches directories", () => {
  const root = project({ ".turnstampignore": "dist/\n", "dist/out.js": "x", "dist.js": "y" });
  const tree = hashTree(root);
  assert.equal(tree.has("dist/out.js"), false);
  assert.equal(tree.has("dist.js"), true);
});

test("an anchored pattern only matches from the root", () => {
  const root = project({ ".turnstampignore": "packages/app/gen.js\n", "packages/app/gen.js": "x", "other/packages/app/gen.js": "y" });
  const tree = hashTree(root);
  assert.equal(tree.has("packages/app/gen.js"), false);
  assert.equal(tree.has("other/packages/app/gen.js"), true);
});

test("comments and blank lines are not rules", () => {
  const root = project({ ".turnstampignore": "# a comment\n\nfoo.js\n", "foo.js": "x" });
  assert.equal(readIgnoreRules(root).length, 1);
});

test("node_modules is always skipped even with no ignore file", () => {
  const root = project({ "node_modules/pkg/index.js": "x", "index.js": "y" });
  const tree = hashTree(root);
  assert.equal(tree.has("node_modules/pkg/index.js"), false);
  assert.equal(tree.has("index.js"), true);
});

test("hashTree reports how much it skipped", () => {
  const root = project({ ".turnstampignore": "*.log\n", "a.log": "1", "b.log": "2", "c.js": "3" });
  const tree = hashTree(root);
  assert.equal(tree.skipped, 2);
  assert.ok(tree.inspected >= 3);
});
