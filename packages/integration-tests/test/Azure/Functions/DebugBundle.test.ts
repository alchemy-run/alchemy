import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, layer } from "alchemy-test";
import * as Bundle from "alchemy/Bundle/Bundle";
import { findCwdForBundle, resolveMainPath } from "alchemy/Bundle/TempRoot";
import * as Effect from "effect/Effect";
import { distilledFromSource } from "./fixtures/distilled-source.ts";
import { managedIdentityHostBundle } from "@alchemy.run/azure/AzureBindings";

// TEMPORARY: bundle the effect fixture like the provider does and list the
// bare imports left in it (deleted before handing off).
layer(NodeServices.layer)("debug bundle", (it) => {
  it.effect(
    "effect fixture bundle",
    () =>
      Effect.gen(function* () {
        const virtualEntryPlugin = yield* Bundle.virtualEntryPlugin;
        const input = yield* resolveMainPath(`${import.meta.dirname}/fixtures/effect-function.ts`);
        const cwd = yield* findCwdForBundle(input);
        const result = yield* Bundle.build(
          managedIdentityHostBundle({
            input,
            cwd,
            platform: "node",
            resolve: { conditionNames: [...Bundle.NODE_CONDITION_NAMES] },
            plugins: [
              distilledFromSource,
              virtualEntryPlugin(
                (importPath) => `
import { bootstrap } from "@alchemy.run/azure/Bootstrap/Functions";
globalThis.__ALCHEMY_RUNTIME__ = true;
const { default: entrypoint } = await import(${JSON.stringify(importPath)});
await bootstrap(entrypoint);
`,
              ),
            ],
          }),
          { format: "esm", entryFileNames: "index.mjs" },
        );
        const bare = result.files
          .filter((file) => typeof file.content === "string")
          .flatMap((file) => (file.content as string).split("\n"))
          .filter((line) => /^import\b/.test(line) && !/["'](\.\/|node:)/.test(line));
        console.log("BARE", JSON.stringify(bare, null, 1));
        const fs = yield* Effect.promise(() => import("node:fs"));
        fs.mkdirSync("/tmp/azfn-bundle", { recursive: true });
        for (const f of result.files) fs.writeFileSync(`/tmp/azfn-bundle/${f.path}`, f.content as any);
        fs.writeFileSync("/tmp/azfn-bundle/package.json", '{"type":"module","main":"index.mjs"}');
        console.log("FILES", result.files.map((f) => `${f.path} ${String(f.content).length}`));
        expect(true).toBe(true);
      }),
    { timeout: 300_000 },
  );
});
