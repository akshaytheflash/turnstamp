import { Plugin } from "@opencode/plugin";

import { createTracker } from "./src/opencode-plugin.js";

// OpenCode plugin entrypoint.
//
// This is both the package default export and the "./opencode" subpath, so
// OpenCode can load the package directly from a plugins entry.
//
// Options:
//   actor  name written into the ledger, defaults to opencode
//   root   project root, defaults to the location directory
//   debug  print ledger errors instead of swallowing them
export default Plugin.define({
  id: "turnstamp",
  async setup(ctx) {
    const tracker = createTracker({
      root: ctx.options.root || ctx.location.directory,
      actor: ctx.options.actor || "opencode",
      debug: ctx.options.debug === true,
    });

    await ctx.tool.hook("execute.before", (event) => {
      tracker.before(event);
    });

    await ctx.tool.hook("execute.after", (event) => {
      tracker.after(event);
    });
  },
});
