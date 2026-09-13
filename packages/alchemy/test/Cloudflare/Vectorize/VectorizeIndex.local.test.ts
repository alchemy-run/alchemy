import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Schedule from "effect/Schedule";
import * as Effect from "effect/Effect";
import * as Path from "node:path";

class RestartPending extends Data.TaggedError("RestartPending") {}

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

test.provider(
  "Vectorize local index binds, persists across deploy, and replaces configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (dimensions = 2) =>
        Effect.gen(function* () {
          const index = yield* Cloudflare.Vectorize.Index("LocalIndex", {
            dimensions,
          });
          const worker = yield* Cloudflare.Worker("local-vectorize", {
            main: Path.resolve(import.meta.dirname, "fixtures/local-worker.ts"),
            env: { INDEX: index },
          });
          return { index, worker };
        });
      let deployed = yield* stack.deploy(program());
      expect(deployed.index.indexName).toMatch(/^dev:/);
      const invoke = (method: string, args: unknown[] = []) =>
        Effect.promise(async () => {
          const response = await fetch(deployed.worker.url!, {
            method: "POST",
            body: JSON.stringify({ method, args }),
          });
          if (!response.ok) throw new Error(await response.text());
          return response.json() as Promise<any>;
        });
      expect((yield* invoke("describe")).dimensions).toBe(2);
      yield* invoke("upsert", [[{ id: "a", values: [1, 0] }]]);
      expect(
        (yield* invoke("queryById", ["a", { topK: 1 }])).matches[0].id,
      ).toBe("a");
      const originalName = deployed.index.indexName;
      deployed = yield* stack.deploy(program());
      expect(deployed.index.indexName).toBe(originalName);
      expect((yield* invoke("describe")).vectorCount).toBe(1);
      deployed = yield* stack.deploy(program(3));
      expect(deployed.index.indexName).not.toBe(originalName);
      const info = yield* invoke("describe").pipe(
        Effect.flatMap((info) =>
          info.dimensions === 3
            ? Effect.succeed(info)
            : Effect.fail(new RestartPending()),
        ),
        Effect.retry({
          while: (error) => error._tag === "RestartPending",
          times: 8,
          schedule: Schedule.spaced("500 millis"),
        }),
      );
      expect(info.dimensions).toBe(3);
      expect((yield* invoke("describe")).vectorCount).toBe(0);
      yield* stack.destroy();
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
