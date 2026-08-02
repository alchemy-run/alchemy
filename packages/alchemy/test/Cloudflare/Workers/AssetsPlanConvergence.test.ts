import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as pathe from "pathe";
import { cloneFixture } from "../Utils/Fixture.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const main = pathe.resolve(import.meta.dirname, "fixtures/worker.ts");
const assetsFixture = pathe.resolve(
  import.meta.dirname,
  "fixtures/assets-only",
);

const actionOf = (plan: any, logicalId: string) =>
  (Object.values(plan.resources) as any[]).find(
    (node: any) => node.resource.LogicalId === logicalId,
  )?.action;

describe.concurrent("Cloudflare.Worker assets plan convergence", () => {
  // A Worker whose `assets` is a plain `{ directory }` (no precomputed
  // `hash` from an upstream build) must still converge to a noop plan when
  // the directory contents are unchanged. The diff hashes the tree the same
  // way the apply does, so users don't have to hand-roll their own
  // directory hashing to get convergent plans.
  test.provider(
    "unchanged assets directory converges to a noop plan",
    (stack) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* stack.destroy();

        // Two independent mutable copies of the assets fixture: `dirA`
        // feeds the main+assets worker, `dirB` feeds the assets-only and
        // script+assets workers, so editing `dirA` must dirty only the
        // first worker.
        const dirA = yield* cloneFixture(assetsFixture, {
          prefix: "alchemy-assets-plan-a-",
        });
        const dirB = yield* cloneFixture(assetsFixture, {
          prefix: "alchemy-assets-plan-b-",
        });

        // One worker per `hasChanged` branch that previously returned a
        // conservative "changed" whenever `assets` carried no precomputed
        // hash: bundled main + assets, assets-only (no entry), and inline
        // script + assets.
        const program = () =>
          Effect.gen(function* () {
            const withMain = yield* Cloudflare.Worker("AssetsPlanWithMain", {
              main,
              assets: { directory: dirA },
              compatibility: { date: "2024-01-01" },
            });
            const assetsOnly = yield* Cloudflare.Worker(
              "AssetsPlanAssetsOnly",
              {
                assets: { directory: dirB, notFoundHandling: "404-page" },
                compatibility: { date: "2024-01-01" },
              },
            );
            const withScript = yield* Cloudflare.Worker("AssetsPlanScript", {
              script: `export default { fetch: () => new Response("assets-plan-script") };`,
              assets: { directory: dirB },
              compatibility: { date: "2024-01-01" },
            });
            return { withMain, assetsOnly, withScript };
          });

        yield* stack.deploy(program());

        // Nothing changed → every worker must plan as a noop. This is the
        // regression: the diff used to refuse to read the assets directory
        // and conservatively reported "update" on every plan.
        const settled = yield* stack.plan(program());
        expect(actionOf(settled, "AssetsPlanWithMain")).toBe("noop");
        expect(actionOf(settled, "AssetsPlanAssetsOnly")).toBe("noop");
        expect(actionOf(settled, "AssetsPlanScript")).toBe("noop");

        // Editing an asset in dirA must dirty exactly the worker that
        // serves it — content changes still surface as updates.
        yield* fs.writeFileString(
          path.join(dirA, "index.html"),
          "<html><body>alchemy-assets-plan-index-v2</body></html>",
        );
        const changed = yield* stack.plan(program());
        expect(actionOf(changed, "AssetsPlanWithMain")).toBe("update");
        expect(actionOf(changed, "AssetsPlanAssetsOnly")).toBe("noop");
        expect(actionOf(changed, "AssetsPlanScript")).toBe("noop");

        // Deploying the change re-settles the plan.
        yield* stack.deploy(program());
        const resettled = yield* stack.plan(program());
        expect(actionOf(resettled, "AssetsPlanWithMain")).toBe("noop");
        expect(actionOf(resettled, "AssetsPlanAssetsOnly")).toBe("noop");
        expect(actionOf(resettled, "AssetsPlanScript")).toBe("noop");

        yield* stack.destroy();
      }),
    { timeout: 360_000 },
  );
});
