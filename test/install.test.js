import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { installClaudeCode, installOpencode } from "../src/install.js";

function tempProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "turnstamp-install-"));
}

test("claude install adds hooks and keeps existing settings", () => {
  const root = tempProject();
  const settingsFile = path.join(root, ".claude", "settings.json");
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ permissions: { allowed: ["Bash(git *)"] } }));

  installClaudeCode("project", root);

  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  assert.deepEqual(settings.permissions.allowed, ["Bash(git *)"], "existing settings survive");
  assert.ok(settings.hooks.PreToolUse.length > 0);
  assert.ok(settings.hooks.PostToolUse.length > 0);
  assert.ok(
    settings.hooks.PreToolUse.some((g) => g.matcher.includes("Write")),
    "file tools are watched",
  );
});

test("claude install does not duplicate its own hooks", () => {
  const root = tempProject();
  installClaudeCode("project", root);
  installClaudeCode("project", root);

  const settings = JSON.parse(fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"));
  const ours = settings.hooks.PreToolUse.filter((g) =>
    (g.hooks || []).some((h) => (h.args || []).some((a) => a.includes("turnstamp"))),
  );
  assert.equal(ours.length, 2, "one for file tools and one for shell, no duplicates");
});

test("claude hook uses exec form with the script as an argument", () => {
  const root = tempProject();
  const result = installClaudeCode("project", root);
  const settings = JSON.parse(fs.readFileSync(result.file, "utf8"));
  const group = settings.hooks.PostToolUse[0];
  const hook = group.hooks[0];

  assert.equal(hook.command, "node");
  assert.ok(Array.isArray(hook.args));
  assert.ok(hook.args[0].endsWith("claude-code.js"));
});

test("opencode install writes a plugin directory that imports the implementation", () => {
  const root = tempProject();
  const result = installOpencode("project", root);
  const index = path.join(result.dir, "index.js");
  const body = fs.readFileSync(index, "utf8");

  assert.ok(fs.existsSync(index));
  assert.match(body, /export default plugin/);
  assert.match(body, /opencode\.js/);
});
