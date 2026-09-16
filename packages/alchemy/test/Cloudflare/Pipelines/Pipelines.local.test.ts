import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Test from "@/Test/Alchemy";
import * as Output from "@/Output";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Path from "node:path";

const { test } = Test.make({ providers: Cloudflare.providers(), dev: true });
const credentials = {
  accessKeyId: Redacted.make("local"),
  secretAccessKey: Redacted.make("local"),
};

const program = (minimum: number) =>
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("PipelineBucket", {
      forceDestroy: true,
    });
    const stream = yield* Cloudflare.Pipelines.Stream("Events", {
      http: { enabled: false },
      schema: {
        fields: [
          { name: "id", type: "string", required: true },
          { name: "amount", type: "int32", required: true },
        ],
      },
    });
    const sink = yield* Cloudflare.Pipelines.Sink("Orders", {
      type: "r2",
      config: { bucket: bucket.bucketName, credentials, path: "orders" },
    });
    const archive = yield* Cloudflare.Pipelines.Sink("Archive", {
      type: "r2",
      format: { type: "json", compression: "gzip" },
      config: { bucket: bucket.bucketName, credentials, path: "archive" },
    });
    const pipeline = yield* Cloudflare.Pipelines.Pipeline("Transform", {
      sql: Output.interpolate`INSERT INTO ${sink.name} SELECT id, amount AS total FROM ${stream.name} WHERE amount >= ${minimum}; INSERT INTO ${archive.name} SELECT * FROM ${stream.name} WHERE amount < 10`,
    });
    const worker = yield* Cloudflare.Worker("pipelines-local-fixture", {
      main: Path.resolve(import.meta.dirname, "fixtures/local-worker.ts"),
      env: { EVENTS: stream, BUCKET: bucket },
    });
    return { stream, sink, archive, pipeline, worker };
  });

test.provider(
  "native send applies SQL filters/projections and writes JSON/gzip to local R2 across pipeline replacement",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const initial = yield* stack.deploy(program(10));
      expect(initial.stream.streamId).toMatch(/^dev:/);
      expect(initial.sink.sinkId).toMatch(/^dev:/);
      expect(initial.pipeline.pipelineId).toMatch(/^dev:/);
      const send = (url: string, records: unknown) =>
        Effect.tryPromise(async () => {
          const response = await fetch(url, {
            method: "POST",
            body: JSON.stringify(records),
          });
          return { status: response.status, body: await response.json() };
        });
      const objects = (url: string) =>
        Effect.tryPromise(async () => {
          const response = await fetch(url);
          if (!response.ok) throw new Error(await response.text());
          return response.json() as Promise<
            { key: string; rows: Record<string, unknown>[] }[]
          >;
        });
      expect(
        (yield* send(initial.worker.url!, [
          { id: "kept", amount: 20 },
          { id: "small", amount: 3 },
        ])).status,
      ).toBe(200);
      const first = yield* objects(initial.worker.url!);
      expect(first).toHaveLength(2);
      expect(first.find((x) => x.key.startsWith("orders/"))?.rows).toEqual([
        { id: "kept", total: 20 },
      ]);
      expect(
        first.find(
          (x) => x.key.startsWith("archive/") && x.key.endsWith(".json.gz"),
        )?.rows,
      ).toEqual([{ id: "small", amount: 3 }]);
      const invalid = yield* send(initial.worker.url!, [
        { id: "missing amount" },
      ]);
      expect(invalid.status).toBe(400);
      expect(yield* objects(initial.worker.url!)).toHaveLength(2);

      const updated = yield* stack.deploy(program(30));
      expect(updated.pipeline.pipelineId).not.toEqual(
        initial.pipeline.pipelineId,
      );
      expect(updated.stream.streamId).toEqual(initial.stream.streamId);
      expect(
        (yield* send(updated.worker.url!, [
          { id: "filtered", amount: 20 },
          { id: "second", amount: 40 },
        ])).status,
      ).toBe(200);
      const after = yield* objects(updated.worker.url!);
      expect(after).toHaveLength(3);
      expect(after.flatMap((x) => x.rows)).toContainEqual({
        id: "second",
        total: 40,
      });
      expect(
        after.flatMap((x) => x.rows).some((r) => r.id === "filtered"),
      ).toBe(false);
      yield* stack.destroy();
    }),
  { timeout: 90_000 },
);

test.provider(
  "rejects unsupported local SQL before accepting events",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const failure = yield* stack
        .deploy(
          Cloudflare.Pipelines.Pipeline("Unsupported", {
            sql: "WITH t AS (SELECT * FROM events) INSERT INTO orders SELECT * FROM t",
          }),
        )
        .pipe(Effect.result);
      expect(failure._tag).toEqual("Failure");
      yield* stack.destroy();
    }),
  { timeout: 90_000 },
);
