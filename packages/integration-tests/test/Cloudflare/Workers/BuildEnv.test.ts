import * as Cloudflare from "@alchemy.run/cloudflare";
import { resolveBuildEnv } from "@alchemy.run/cloudflare/Workers/BuildEnv";
import { describe, expect, it } from "@alchemy.run/test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";

describe(
  "resolveBuildEnv",
  { tags: ["unit", "provider:cloudflare", "provider:cloudflare:worker", "local"] },
  () => {
    it.effect("inlines literals and evaluates env-bound Effects", () =>
      Effect.gen(function* () {
        const env = yield* resolveBuildEnv(
          {
            STRING: "value",
            NUMBER: 1,
            BOOLEAN: true,
            SECRET: Redacted.make("secret"),
            EFFECT: Effect.succeed("from-effect"),
            SELF_URL: Cloudflare.Workers.URL,
          },
          "https://worker.example.com",
        );
        expect(env).toEqual({
          STRING: "value",
          NUMBER: "1",
          BOOLEAN: "true",
          SECRET: "secret",
          EFFECT: "from-effect",
          SELF_URL: "https://worker.example.com",
        });
      }),
    );

    // Effect-shaped bindings only run while the Worker binds them. A build
    // that yields `S3Credentials` fails with
    // "Service not found: Cloudflare.Workers.WorkerEnvironment".
    it.effect("skips Effect-shaped bindings instead of yielding them", () =>
      Effect.gen(function* () {
        const env = yield* resolveBuildEnv(
          {
            PUBLIC: "value",
            BUCKET_S3: Cloudflare.R2.S3Credentials(Cloudflare.R2.Bucket("Bucket"), {
              access: "read",
            }),
            LOADER: Cloudflare.Workers.WorkerLoader("Loader"),
          },
          undefined,
        );
        expect(env).toEqual({ PUBLIC: "value" });
      }),
    );
  },
);
