import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Path from "node:path";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });
class RestartPending extends Data.TaggedError("RestartPending") {}

test.provider(
  "R2 local bucket enforces retention and removes it on update",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (locked: boolean) =>
        Effect.gen(function* () {
          const bucket = yield* Cloudflare.R2.Bucket("LockedBucket", {
            lockRules: locked
              ? [
                  {
                    id: "audit",
                    prefix: "audit/",
                    condition: { type: "Indefinite" },
                  },
                ]
              : [],
          });
          const worker = yield* Cloudflare.Worker("local-r2-locks", {
            main: Path.resolve(
              import.meta.dirname,
              "fixtures/bucket-locks-worker.ts",
            ),
            env: { BUCKET: bucket },
          });
          return { bucket, worker };
        });
      let deployed = yield* stack.deploy(program(true));
      expect(deployed.bucket.bucketName).toMatch(/^dev:/);
      const request = (path: string) =>
        Effect.promise(() =>
          fetch(`${deployed.worker.url}${path}`).then((r) => r.text()),
        );
      expect(yield* request("/seed")).toBe("seeded");
      expect(JSON.parse(yield* request("/overwrite")).allowed).toBe(false);
      expect(JSON.parse(yield* request("/delete")).allowed).toBe(false);
      expect(yield* request("/read")).toBe("original");
      deployed = yield* stack.deploy(program(false));
      const allowed = yield* request("/overwrite").pipe(
        Effect.flatMap((body) =>
          JSON.parse(body).allowed
            ? Effect.succeed(true)
            : Effect.fail(new RestartPending()),
        ),
        Effect.retry({
          while: (error) => error._tag === "RestartPending",
          times: 8,
          schedule: Schedule.spaced("500 millis"),
        }),
      );
      expect(allowed).toBe(true);
      expect(yield* request("/read")).toBe("changed");
      expect(JSON.parse(yield* request("/delete")).allowed).toBe(true);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
