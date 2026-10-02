import * as Alchemy from "@/index.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { relativeWorkerMain } from "@/Cloudflare/Workers/Worker";
import * as Provider from "@/Provider.ts";
import { InMemoryService, State } from "@/State/index.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect, test as unitTest } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { pathToFileURL } from "node:url";
import path from "pathe";

/** The `main` the provider received as `news`. */
let observedMain: unknown;

// A stand-in provider: only the props the engine hands it matter here.
const providers: Layer.Layer<any> = Provider.succeed(Cloudflare.Worker as any, {
  list: () => Effect.succeed([]),
  diff: Effect.fn(function* () {
    return undefined;
  }),
  reconcile: Effect.fn(function* ({ news }: any) {
    observedMain = news.main;
    return { workerName: "api" } as any;
  }),
  delete: Effect.fn(function* () {}),
});

const store = InMemoryService({});
const state = Layer.succeed(State, store);

const { test, deploy } = Test.make({ providers, state });

const entry = path.join(process.cwd(), "src", "api.ts");

describe(
  "Cloudflare.Worker main",
  { tags: ["unit", "provider:cloudflare", "local"] },
  () => {
    describe("relativeWorkerMain", () => {
      unitTest("relativizes a file URL inside cwd", () => {
        expect(
          relativeWorkerMain("file:///repo/apps/api/src/index.ts", "/repo"),
        ).toEqual("apps/api/src/index.ts");
      });

      unitTest("relativizes an absolute path inside cwd", () => {
        expect(relativeWorkerMain("/repo/src/worker.ts", "/repo")).toEqual(
          "src/worker.ts",
        );
      });

      unitTest("keeps relative paths and paths outside cwd", () => {
        expect(relativeWorkerMain("./src/worker.ts", "/repo")).toEqual(
          "./src/worker.ts",
        );
        expect(relativeWorkerMain("/other/worker.ts", "/repo")).toEqual(
          "/other/worker.ts",
        );
        expect(relativeWorkerMain("file:///other/worker.ts", "/repo")).toEqual(
          "file:///other/worker.ts",
        );
      });

      unitTest("decodes escaped characters in file URLs", () => {
        expect(
          relativeWorkerMain("file:///my%20repo/src/worker.ts", "/my repo"),
        ).toEqual("src/worker.ts");
      });
    });

    // Drift repair rebuilds the bundle from the props in state, so a
    // persisted absolute `main` breaks once the deploying checkout is gone.
    test(
      "persists an import.meta.url main relative to cwd",
      Effect.gen(function* () {
        const stack = Alchemy.Stack(
          "WorkerMainStack",
          { providers, state },
          Effect.gen(function* () {
            const worker = yield* Cloudflare.Worker("Api", {
              main: pathToFileURL(entry).href,
            });
            return { workerName: worker.workerName };
          }),
        );
        yield* deploy(stack, { stage: "main-path" });

        expect(observedMain).toEqual("src/api.ts");
        const row = yield* (yield* store).get({
          stack: "WorkerMainStack",
          stage: "main-path",
          fqn: "Api",
        });
        expect((row as any)?.props?.main).toEqual("src/api.ts");
      }),
      { timeout: 60_000 },
    );
  },
);
