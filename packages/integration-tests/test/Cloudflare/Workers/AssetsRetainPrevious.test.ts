import * as Cloudflare from "@alchemy.run/cloudflare";
/**
 * `assets.retainPrevious` against the real asset upload session.
 *
 * A page loaded before a deploy still references the previous build's
 * content-hashed chunks. With `retainPrevious`, a deploy of build N serves
 * build N plus build N-1's retained files, never the files build N-1's
 * deploy itself carried. A redeploy of build N (a Worker-only change)
 * keeps serving build N-1's files.
 *
 * Each `fixtures/assets-retain-previous/build-N` directory is one build:
 * an `index.html` shell and one hashed-style chunk under `assets/`.
 */
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { expectUrlAbsent, expectUrlContains } from "../Utils/Http.ts";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const build = (n: number) =>
  pathe.resolve(import.meta.dirname, `fixtures/assets-retain-previous/build-${n}`);
const chunk = (n: number) => `/assets/chunk-${n}.css`;
const marker = (n: number) => `alchemy-assets-retain-previous-build-${n}`;

// Requests that match no asset reach this script, so a removed chunk
// answers with the script's marker instead of the chunk's.
const workerScript = (version: string) => `
export default {
  fetch: async () => new Response(${JSON.stringify(version)}),
};
`;

const retainPrevious = { paths: ["assets/**"] };

test.provider(
  "assets: retainPrevious serves the previous build's chunks until the next build",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const deploy = (assets: { directory: string; hash?: string }, version: string) =>
        stack.deploy(
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("AssetsRetainPreviousWorker", {
              script: workerScript(version),
              workersDev: true,
              compatibility: { date: "2024-01-01" },
              assets: { ...assets, retainPrevious },
            });
          }),
        );

      const keys = (manifest: Record<string, unknown> | undefined) => Object.keys(manifest ?? {});

      let workerName: string | undefined;

      yield* Effect.gen(function* () {
        // Build 1: records its own chunk, carries nothing.
        const first = yield* deploy({ directory: build(1) }, "worker-v1");
        workerName = first.workerName;
        const url = first.url!;
        expect(keys(first.retainedAssets)).toEqual([chunk(1)]);
        expect(keys(first.carriedAssets)).toEqual([]);
        yield* expectUrlContains(`${url}${chunk(1)}`, marker(1), {
          timeout: "120 seconds",
          label: "build 1 chunk",
        });

        // Build 2: records only its own chunk and carries build 1's.
        const second = yield* deploy({ directory: build(2) }, "worker-v2");
        expect(keys(second.retainedAssets)).toEqual([chunk(2)]);
        expect(keys(second.carriedAssets)).toEqual([chunk(1)]);
        yield* expectUrlContains(`${url}${chunk(2)}`, marker(2), {
          timeout: "60 seconds",
          label: "build 2 chunk",
        });
        yield* expectUrlContains(`${url}${chunk(1)}`, marker(1), {
          timeout: "60 seconds",
          label: "build 1 chunk carried",
        });

        // A Worker-only change redeploys build 2. The directory carries no
        // precomputed hash, so the manifest is uploaded again: build 1
        // must stay served.
        const again = yield* deploy({ directory: build(2) }, "worker-v3");
        expect(keys(again.retainedAssets)).toEqual([chunk(2)]);
        expect(keys(again.carriedAssets)).toEqual([chunk(1)]);
        yield* expectUrlContains(`${url}/route`, "worker-v3", {
          timeout: "60 seconds",
          label: "worker-only redeploy landed",
        });
        yield* expectUrlContains(`${url}${chunk(1)}`, marker(1), {
          timeout: "60 seconds",
          label: "build 1 chunk carried after a redeploy of build 2",
        });

        // Build 3, with a precomputed hash: carries build 2 only. Build 1
        // was carried, never recorded, so it is gone.
        const hashed = { directory: build(3), hash: "assets-retain-previous-build-3" };
        const third = yield* deploy(hashed, "worker-v4");
        expect(keys(third.retainedAssets)).toEqual([chunk(3)]);
        expect(keys(third.carriedAssets)).toEqual([chunk(2)]);
        yield* expectUrlContains(`${url}${chunk(3)}`, marker(3), {
          timeout: "60 seconds",
          label: "build 3 chunk",
        });
        yield* expectUrlContains(`${url}${chunk(2)}`, marker(2), {
          timeout: "60 seconds",
          label: "build 2 chunk carried",
        });
        yield* expectUrlAbsent(`${url}${chunk(1)}`, marker(1), {
          timeout: "60 seconds",
          label: "build 1 chunk carried only once",
        });

        // Same hash again: the skip path never reads the directory, so it
        // carries both records forward from state and keeps build 2 served.
        const skipped = yield* deploy(hashed, "worker-v5");
        expect(keys(skipped.retainedAssets)).toEqual([chunk(3)]);
        expect(keys(skipped.carriedAssets)).toEqual([chunk(2)]);
        yield* expectUrlContains(`${url}/route`, "worker-v5", {
          timeout: "60 seconds",
          label: "skip-path redeploy landed",
        });
        yield* expectUrlContains(`${url}${chunk(2)}`, marker(2), {
          timeout: "60 seconds",
          label: "build 2 chunk carried after a skip-path redeploy",
        });
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* stack.destroy().pipe(Effect.ignore);
            if (workerName) {
              yield* waitForWorkerToBeDeleted(workerName, accountId).pipe(Effect.ignore);
            }
          }),
        ),
      );
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:worker", "live"],
    timeout: 420_000,
  },
);
