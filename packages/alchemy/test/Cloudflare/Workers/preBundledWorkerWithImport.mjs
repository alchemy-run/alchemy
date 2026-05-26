import { importedSentinel } from "./preBundledWorkerModule.mjs";

export default {
  async fetch() {
    return new Response(importedSentinel, {
      headers: { "x-alchemy-imported-sentinel": importedSentinel },
    });
  },
};
