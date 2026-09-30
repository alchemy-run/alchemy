import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { CloudflareApiLive } from "@/Cloudflare/Providers.ts";
import { waitForMetadata, waitForVectorize } from "./Readiness.ts";
import * as vectorize from "@distilled.cloud/cloudflare/vectorize";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { HttpClientResponse } from "effect/http";
import * as HttpClient from "effect/http/HttpClient";
import Stack from "./fixtures/stack.ts";

/**
 * End-to-end test of the `Cloudflare.Vectorize` native worker binding against a
 * real Cloudflare Worker + Vectorize index, covering BOTH invocation styles:
 *
 *  - effect-worker: `yield* Cloudflare.Vectorize.SearchIndex(index)` inside a
 *    `Cloudflare.Worker` init, binding provided via `SearchIndexBinding`.
 *  - async-worker:  the index declared on the Worker `env`, used as the native
 *    runtime `Vectorize` binding from a plain `async fetch`.
 *
 * Both workers share ONE index (vectors are id-prefixed by style so they stay
 * independent) and are driven by a single `exercise(label, baseUrl)` flow that
 * upserts → describes → queries → filtered-queries → getByIds. Vectorize
 * mutations are eventually consistent, so reads are polled until visible.
 */
const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Cloudflare.providers(),
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Fresh workers.dev URLs take a few seconds to start serving 200s, and edge
// propagation can still transiently 404/500 individual route hits after the
// script is resolvable. Bound both the retry count and the entire request.
const readinessRetry = {
  schedule: Schedule.max([Schedule.spaced("1 second"), Schedule.recurs(8)]),
} as const;

const getJson = (url: string) =>
  HttpClient.get(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((res) => res.json),
    Effect.retry(readinessRetry),
    Effect.timeout("15 seconds"),
  );

const postJson = (url: string) =>
  HttpClient.post(url).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.flatMap((res) => res.json),
    Effect.retry(readinessRetry),
    Effect.timeout("15 seconds"),
  );

/** Drives the client surface using this worker's vector ID prefix. */
const exercise = (
  label: string,
  baseUrl: string,
  accountId: string,
  indexName: string,
) =>
  Effect.gen(function* () {
    // Gate on /health first to prove the script is resolvable.
    yield* HttpClient.get(`${baseUrl}/health`).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.timeout("5 seconds"),
      Effect.retry({
        schedule: Schedule.max([
          Schedule.spaced("1 second"),
          Schedule.recurs(8),
        ]),
      }),
      Effect.timeout("15 seconds"),
    );

    const upsertRes = (yield* postJson(`${baseUrl}/upsert`)) as {
      mutationId: string;
    };
    expect(upsertRes).toMatchObject({ mutationId: expect.any(String) });

    const describeRes = yield* getJson(`${baseUrl}/describe`);
    expect(describeRes).toMatchObject({ dimensions: 32 });

    // Observe processing and all read surfaces under one readiness budget.
    // The fixture is the sole writer, so compare opaque mutation IDs exactly.
    const { queryBody, getRes, filteredBody } = yield* waitForVectorize({
      description: `[${label}] mutation ${upsertRes.mutationId} processed and visible to query, ID lookup and metadata filtering`,
      effect: Effect.all(
        {
          progress: vectorize
            .getIndexInfo({ accountId, indexName })
            .pipe(Effect.timeout("10 seconds")),
          queryBody: getJson(`${baseUrl}/query`).pipe(
            Effect.map((body) => body as { count: number; ids: string[] }),
          ),
          getRes: getJson(`${baseUrl}/get`).pipe(
            Effect.map((body) => body as { ids: string[] }),
          ),
          filteredBody: getJson(`${baseUrl}/query-filtered`).pipe(
            Effect.map(
              (body) =>
                body as { count: number; ids: string[]; kinds: string[] },
            ),
          ),
        },
        { concurrency: "unbounded" },
      ),
      predicate: ({ progress, queryBody, getRes, filteredBody }) =>
        progress.processedUpToMutation === upsertRes.mutationId &&
        queryBody.count >= 3 &&
        getRes.ids.length === 2 &&
        filteredBody.ids.length === 1 &&
        filteredBody.kinds.length === 1,
    });
    expect(queryBody.count).toBeGreaterThanOrEqual(3);
    expect(queryBody.ids[0]).toBe(`${label}-a`);
    expect(getRes).toEqual({ ids: [`${label}-a`, `${label}-b`] });
    expect(filteredBody.ids).toEqual([`${label}-b`]);
    expect(filteredBody.kinds).toEqual(["second"]);
  }).pipe(logLevel, Effect.provide(CloudflareApiLive()));

const stack = beforeAll(
  Effect.gen(function* () {
    yield* destroy(Stack);
    const deployed = yield* deploy(Stack);
    const { accountId } = yield* yield* CloudflareEnvironment;
    yield* waitForMetadata(accountId, deployed.indexName, [
      {
        propertyName: "kind",
        indexType: "string",
        mutationId: deployed.metadataMutationId,
      },
    ]);
    return { ...deployed, accountId };
  }).pipe(Effect.provide(CloudflareApiLive())),
  { timeout: 210_000 },
);
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

test(
  "effect-worker: SearchIndex(index) exercises the client surface",
  Effect.gen(function* () {
    const { effectWorkerUrl, accountId, indexName } = yield* stack;
    yield* exercise("effect", effectWorkerUrl, accountId, indexName);
  }),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:vectorize",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 210_000,
  },
);

test(
  "async-worker: env Vectorize binding exercises the client surface",
  Effect.gen(function* () {
    const { asyncWorkerUrl, accountId, indexName } = yield* stack;
    yield* exercise("async", asyncWorkerUrl, accountId, indexName);
  }),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:vectorize",
      "provider:cloudflare:worker",
      "live",
    ],
    timeout: 210_000,
  },
);
