import {
  deploymentMetadata,
  validateBindingNames,
} from "@/Celld/DeploymentConfig.ts";
import { prepareDeployment } from "@/Celld/Deployment.ts";
import { describe, expect, it } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";

const metadata = {
  scriptName: "test-worker",
  mainModule: "index.js",
  compatibilityDate: "2026-09-01",
  compatibilityFlags: ["nodejs_compat"],
  durableObjects: [{ name: "Counter", className: "Counter" }],
  vars: { ALCHEMY_SECRET: "test-only" },
  bindings: [
    { type: "kv_namespace" as const, name: "CACHE", namespaceId: "cache" },
    { type: "d1" as const, name: "DATABASE", id: "database" },
    { type: "r2_bucket" as const, name: "FILES", bucketName: "files" },
    { type: "queue" as const, name: "WORK", queueName: "work" },
    {
      type: "workflow" as const,
      name: "FLOW",
      workflowName: "flow",
      className: "Flow",
    },
    { type: "worker_loader" as const, name: "LOADER" },
  ],
  queueConsumers: [{ queue: "work" }],
};

describe("Celld native deployment metadata", () => {
  it.effect("separates user classes from runtime-derived system classes", () =>
    Effect.gen(function* () {
      const lowered = yield* deploymentMetadata(metadata);
      expect(lowered.doClasses).toEqual(["Counter"]);
      expect(lowered.sqliteClasses).toEqual(["Counter"]);
      expect(lowered.queueConsumers).toEqual([
        {
          queue: "work",
          max_batch_size: 10,
          max_batch_timeout: 5,
          max_retries: 3,
        },
      ]);
      const prepared = yield* prepareDeployment({
        scriptName: metadata.scriptName,
        mainModule: metadata.mainModule,
        modules: [
          {
            name: "index.js",
            content:
              "export default { fetch() { return new Response('ok'); } };",
          },
        ],
        ...lowered,
      });
      expect(prepared.manifest.do_classes).toEqual([
        "Counter",
        "__D1Database",
        "__KvNamespace",
        "__Queue",
        "__Workflow.test-worker",
      ]);
      expect(prepared.manifest.required_features).toEqual(
        expect.arrayContaining([
          "d1-v1",
          "kv-v1",
          "queues-v1",
          "workflows-v1",
          "r2-v1",
        ]),
      );
    }),
  );

  it.effect(
    "rejects native, variable, Durable Object and asset binding collisions",
    () =>
      Effect.gen(function* () {
        for (const options of [
          { ...metadata, vars: { CACHE: "conflict" } },
          {
            ...metadata,
            durableObjects: [{ name: "CACHE", className: "Counter" }],
          },
          { ...metadata, assets: { directory: "public", binding: "CACHE" } },
          { ...metadata, vars: { "not-a-javascript-identifier": "invalid" } },
        ]) {
          const result = yield* Effect.result(validateBindingNames(options));
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result))
            expect(result.failure._tag).toBe("Celld.BindingConflict");
        }
      }),
  );

  it.effect("preserves explicit queue policy values including zero", () =>
    Effect.gen(function* () {
      const lowered = yield* deploymentMetadata({
        ...metadata,
        queueConsumers: [
          {
            queue: "work",
            maxBatchSize: 1,
            maxBatchTimeout: 0,
            maxRetries: 0,
            retryDelay: 0,
            maxConcurrency: 1,
            deadLetterQueue: "dead",
          },
        ],
      });
      expect(lowered.queueConsumers).toEqual([
        {
          queue: "work",
          max_batch_size: 1,
          max_batch_timeout: 0,
          max_retries: 0,
          retry_delay: 0,
          max_concurrency: 1,
          dead_letter_queue: "dead",
        },
      ]);
    }),
  );
});
