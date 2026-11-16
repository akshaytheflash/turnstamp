// One vocabulary for every agent. Each integration translates its own payload
// into these, so the ledger, the verifier and the report never need to know
// which tool produced an event.

export const ACTOR_KINDS = ["agent", "human", "system"];

// A call is the agent asking for one tool. A tool may touch several files, so a
// call fans out into one file event per path.
export function callEvent(fields) {
  return {
    actor: fields.actor || "agent",
    kind: "call",
    session: fields.session ?? null,
    call: fields.call ?? null,
    tool: fields.tool || "unknown",
    action: fields.action || "call",
    target: null,
    detail: fields.detail ?? null,
    ...(fields.phase ? { phase: fields.phase } : {}),
  };
}

// A file event says: this path went from `before` to `after` because of this
// call. `before` is missing when the file did not exist.
export function fileEvent(fields) {
  return {
    actor: fields.actor || "agent",
    kind: "file",
    session: fields.session ?? null,
    call: fields.call ?? null,
    tool: fields.tool || "unknown",
    action: fields.action || "write",
    target: fields.target,
    detail: fields.after ?? null,
    before: fields.before ?? null,
  };
}

// Paths that arrive absolute, or with Windows separators, are normalised so the
// same file always becomes the same target in the ledger.
export function normalizeTarget(root, filePath) {
  if (!filePath || typeof filePath !== "string") {
    return null;
  }
  let p = filePath.replace(/\\/g, "/");
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (p === base) {
    return ".";
  }
  if (p.startsWith(base + "/")) {
    p = p.slice(base.length + 1);
  }
  p = p.replace(/^\.\//, "");
  while (p.startsWith("../")) {
    p = p.slice(3);
  }
  return p || null;
}
