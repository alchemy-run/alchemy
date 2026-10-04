// Minimal Worker entry for bundling an Effect entry whose exports carry
// native exports; only its default export is read by the generated entry.
//
// The `package.json` beside it roots `findCwdForBundle` at this directory,
// so a relative native-export module (`./sandbox.ts`) resolves here and the
// bundle would succeed silently — the outcome the provider's native-export
// validation exists to prevent.
export default {
  fetch: () => new Response("native-export:ok"),
};
