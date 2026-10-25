import type * as rolldown from "rolldown";

declare const Bun: { resolveSync(specifier: string, from: string): string };

/**
 * TEMPORARY test-only rolldown plugin: bundle `@distilled.cloud/*` from its
 * TypeScript sources (resolved the way the bun test runner resolves them)
 * instead of its `lib/` build, which is stale in this checkout.
 */
export const distilledFromSource: rolldown.Plugin = {
  name: "test:distilled-from-source",
  resolveId(source, importer) {
    if (!source.startsWith("@distilled.cloud/")) return null;
    try {
      const from = importer ? importer.slice(0, importer.lastIndexOf("/")) : import.meta.dirname;
      return Bun.resolveSync(source, from);
    } catch {
      return null;
    }
  },
};
