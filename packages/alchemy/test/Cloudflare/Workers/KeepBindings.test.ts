import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import * as workers from "@distilled.cloud/cloudflare/workers";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as pathe from "pathe";
import { waitForWorkerToBeDeleted } from "../Utils/Worker.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const main = pathe.resolve(import.meta.dirname, "fixtures/worker.ts");

describe.concurrent("Cloudflare.Worker keepBindings", () => {
  // A script upload replaces the whole binding set. A secret written
  // out-of-band survives the next deploy only when its type is listed in
  // `keepBindings`; without the prop the upload owns the binding set and
  // the secret is dropped.
  test.provider(
    "keeps out-of-band secret_text bindings across a deploy",
    (stack) =>
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;

        yield* stack.destroy();

        const program = (opts: {
          flags: string[];
          keepBindings?: readonly Cloudflare.WorkerKeepBindingType[];
        }) =>
          Effect.gen(function* () {
            return yield* Cloudflare.Worker("KeepBindingsWorker", {
              main,
              compatibility: { date: "2024-01-01", flags: opts.flags },
              env: { GREETING: "hello" },
              keepBindings: opts.keepBindings,
            });
          });

        const secretNames = Effect.fn(function* (scriptName: string) {
          const secrets = yield* workers.listScriptSecrets({
            accountId,
            scriptName,
          });
          return secrets.result.map((secret) => secret.name).toSorted();
        });

        const worker = yield* stack.deploy(program({ flags: [] }));

        // Write a secret the way an operator would: outside Alchemy.
        yield* workers.putScriptSecret({
          accountId,
          scriptName: worker.workerName,
          name: "OUT_OF_BAND_SECRET",
          text: "set-outside-alchemy",
          type: "secret_text",
        });
        expect(yield* secretNames(worker.workerName)).toEqual([
          "OUT_OF_BAND_SECRET",
        ]);

        // A metadata change with keepBindings deploys and keeps the secret.
        yield* stack.deploy(
          program({ flags: ["nodejs_compat"], keepBindings: ["secret_text"] }),
        );
        expect(yield* secretNames(worker.workerName)).toEqual([
          "OUT_OF_BAND_SECRET",
        ]);

        // Dropping keepBindings hands the binding set back to the upload.
        yield* stack.deploy(program({ flags: [] }));
        expect(yield* secretNames(worker.workerName)).toEqual([]);

        yield* stack.destroy();
        yield* waitForWorkerToBeDeleted(worker.workerName, accountId);
      }).pipe(logLevel),
  );
});
