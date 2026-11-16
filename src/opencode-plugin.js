import path from "node:path";

import { appendEvent, ledgerPath } from "./ledger.js";
import { normalizeTarget } from "./events.js";
import { isFileTool, readState, shellCommand, toolPaths } from "./tools.js";

// Records every OpenCode tool call in the ledger.
//
// The before hook reads the state of each file the call is about to touch. The
// after hook reads it again. The pair is what proves the transition, and it is
// the agent's own account of what it did.
//
// A Map keyed by call id holds the pending "before" states between the two
// hooks. Calls that never finish are simply dropped.
export function createTracker(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const file = options.ledger || ledgerPath(root);
  const actor = options.actor || "opencode";
  const pending = new Map();

  function record(event) {
    try {
      appendEvent(file, { ...event, actor });
    } catch (err) {
      // A ledger that cannot be written must never take the session down.
      if (options.debug) {
        console.error(`turnstamp: ${err.message}`);
      }
    }
  }

  return {
    before(event) {
      const tool = String(event.tool);
      const session = String(event.sessionID || "");
      const call = String(event.id || "");

      if (isFileTool(tool)) {
        const paths = toolPaths(tool, event.input).map((p) => normalizeTarget(root, p)).filter(Boolean);
        const states = paths.map((p) => ({ target: p, before: readState(path.join(root, p)) }));
        pending.set(call, { tool, session, states });

        record({
          kind: "call",
          phase: "before",
          session,
          call,
          tool,
          action: "call",
          detail: JSON.stringify({ files: paths }),
        });
        return;
      }

      const command = tool === "shell" ? shellCommand(event.input) : null;
      pending.set(call, { tool, session, states: [] });
      record({
        kind: "call",
        phase: "before",
        session,
        call,
        tool,
        action: tool === "shell" ? "shell" : "call",
        target: command,
        detail: command,
      });
    },

    after(event) {
      const tool = String(event.tool);
      const session = String(event.sessionID || "");
      const call = String(event.id || "");
      const held = pending.get(call);
      pending.delete(call);

      if (!isFileTool(tool)) {
        record({
          kind: "call",
          phase: "after",
          session,
          call,
          tool,
          action: event.status === "error" ? "failed" : "done",
          detail: event.status === "error" ? String(event.error?.message || "error") : null,
        });
        return;
      }

      const states = held ? held.states : [];
      const paths = states.length
        ? states
        : toolPaths(tool, event.input).map((p) => ({
            target: normalizeTarget(root, p),
            before: "missing",
          }));

      for (const item of paths) {
        if (!item.target) {
          continue;
        }
        const after = readState(path.join(root, item.target));
        record({
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
    },
  };
}
