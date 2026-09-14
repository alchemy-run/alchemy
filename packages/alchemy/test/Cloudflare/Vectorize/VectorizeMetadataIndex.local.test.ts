import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Path from "node:path";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });

test.provider(
  "Vectorize local metadata index enables filtering and removal disables it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (metadata: false | "string" | "number" = "string") =>
        Effect.gen(function* () {
          const index = yield* Cloudflare.Vectorize.Index("LocalIndex", {
            dimensions: 2,
          });
          if (metadata)
            yield* Cloudflare.Vectorize.MetadataIndex("Category", {
              indexName: index.indexName,
              propertyName: "category",
              indexType: metadata,
            });
          const worker = yield* Cloudflare.Worker("local-vectorize-metadata", {
            main: Path.resolve(import.meta.dirname, "fixtures/local-worker.ts"),
            env: { INDEX: index },
          });
          return { index, worker };
        });
      let deployed = yield* stack.deploy(program());
      const invoke = (method: string, args: unknown[] = []) =>
        Effect.promise(async () => {
          const response = await fetch(deployed.worker.url!, {
            method: "POST",
            body: JSON.stringify({ method, args }),
          });
          return response.json() as Promise<any>;
        });
      yield* invoke("upsert", [
        [
          { id: "book", values: [1, 0], metadata: { category: "book" } },
          { id: "film", values: [1, 1], metadata: { category: "film" } },
        ],
      ]);
      const filtered = yield* invoke("query", [
        [1, 0],
        { filter: { category: "film" }, returnMetadata: "indexed" },
      ]);
      expect(filtered.matches.map((v: { id: string }) => v.id)).toEqual([
        "film",
      ]);
      // Replacing the same property must not let cleanup delete its successor.
      deployed = yield* stack.deploy(program("number"));
      yield* invoke("upsert", [
        [{ id: "numeric", values: [1, 0], metadata: { category: 7 } }],
      ]);
      expect(
        (yield* invoke("query", [
          [1, 0],
          { filter: { category: 7 } },
        ])).matches.map((v: { id: string }) => v.id),
      ).toEqual(["numeric"]);
      deployed = yield* stack.deploy(program(false));
      expect(
        (yield* invoke("query", [[1, 0], { filter: { category: "film" } }]))
          .error,
      ).toContain("No metadata index");
      deployed = yield* stack.deploy(program());
      // Metadata indexes never retroactively index existing vectors, including
      // after deleting and recreating the same property name.
      expect(
        (yield* invoke("query", [[1, 0], { filter: { category: "film" } }]))
          .matches,
      ).toEqual([]);
      yield* invoke("upsert", [
        [{ id: "film", values: [1, 1], metadata: { category: "film" } }],
      ]);
      expect(
        (yield* invoke("query", [
          [1, 0],
          { filter: { category: "film" } },
        ])).matches.map((v: { id: string }) => v.id),
      ).toEqual(["film"]);
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
