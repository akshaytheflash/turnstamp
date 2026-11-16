#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ledgerPath } from "../src/ledger.js";

// Wires turnstamp into the agents on this machine. Both installs are additive:
// existing settings are read, merged and written back, never replaced.

const HOOK = path.resolve(import.meta.dirname, "..", "hooks", "claude-code.js");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");
}

// True when a matcher group already contains one of our hooks. The command is
// the node binary in exec form, so the script path lives in args.
function isOurs(group) {
  return (group.hooks || []).some((hook) => {
    const texts = [hook.command, ...(hook.args || [])].filter((v) => typeof v === "string");
    return texts.some((text) => text.includes("turnstamp") || text.includes("claude-code.js"));
  });
}

function merged(existing, entry) {
  const list = Array.isArray(existing) ? existing : [];
  const matcher = entry.matcher;
  const already = list.some((group) => group.matcher === matcher && isOurs(group));
  return already ? list : [...list, entry];
}

function claudeHook(command, matcher, async) {
  return {
    matcher,
    hooks: [
      {
        type: "command",
        command: "node",
        args: [command],
        ...(async ? { async: true } : {}),
      },
    ],
  };
}

export function installClaudeCode(scope = "project", cwd = process.cwd()) {
  const file =
    scope === "user"
      ? path.join(os.homedir(), ".claude", "settings.json")
      : path.join(cwd, ".claude", "settings.json");

  const settings = readJson(file) || {};
  settings.hooks = settings.hooks || {};

  const matcher = "Write|Edit|MultiEdit|NotebookEdit";
  settings.hooks.PreToolUse = merged(settings.hooks.PreToolUse, claudeHook(HOOK, matcher, false));
  settings.hooks.PostToolUse = merged(settings.hooks.PostToolUse, claudeHook(HOOK, matcher, false));
  settings.hooks.PostToolUseFailure = merged(
    settings.hooks.PostToolUseFailure,
    claudeHook(HOOK, matcher, false),
  );
  // Bash is logged as a call. It is async so it never delays the command.
  settings.hooks.PreToolUse = merged(
    settings.hooks.PreToolUse,
    claudeHook(HOOK, "Bash|PowerShell", true),
  );

  writeJson(file, settings);
  return { file, hook: HOOK };
}

export function installOpencode(scope = "project", cwd = process.cwd(), entrypoint) {
  const dir =
    scope === "user"
      ? path.join(os.homedir(), ".config", "opencode")
      : path.join(cwd, ".opencode");

  const pluginDir = path.join(dir, "plugins", "turnstamp");
  fs.mkdirSync(pluginDir, { recursive: true });

  // OpenCode loads a local plugin directory by file name, not through package
  // exports, so this file just re-exports the implementation. A file URL keeps
  // it working when the package is installed globally.
  const target = entrypoint || path.resolve(import.meta.dirname, "..", "opencode.js");
  const url = pathToFileURL(target).href;

  fs.writeFileSync(
    path.join(pluginDir, "index.js"),
    ['import plugin from "' + url + '";', "", "export default plugin;", ""].join("\n"),
    "utf8",
  );

  return { dir: pluginDir };
}

export function initLedger(cwd = process.cwd()) {
  const file = ledgerPath(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, "", "utf8");
  }
  return file;
}
