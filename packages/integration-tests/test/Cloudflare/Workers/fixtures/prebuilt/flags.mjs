// A prebuilt Worker (`bundle: false`): uploaded as written. `import.meta.resolve`
// exists only on the new module registry, and `process` only under Node
// compatibility, so the response shows which flags the runtime applied.
export default {
  async fetch() {
    return Response.json({
      resolve: typeof import.meta.resolve,
      process: typeof globalThis.process,
    });
  },
};
