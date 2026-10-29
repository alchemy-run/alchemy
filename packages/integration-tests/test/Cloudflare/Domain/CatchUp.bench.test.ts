import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { Credentials, formatHeaders } from "@distilled.cloud/cloudflare/Credentials";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import { requestWorker } from "../Utils/WorkerRequest.ts";
import BenchV1 from "./fixtures/bench/v1.ts";
import BenchV2 from "./fixtures/bench/v2.ts";

/**
 * What a backfill costs and how long a deploy waits for it on Cloudflare: seed
 * N accounts with 10 deposits each, deploy a view keyed by account, and read
 * the Durable Object requests and SQLite rows of the backfill from Cloudflare's
 * analytics. Each run prints a `BENCH` line of JSON. Widths come from
 * `DOMAIN_BENCH_INSTANCES` (comma-separated, default 1000).
 */

const EVENTS = 10;
const SEED_BATCH = 50;
const sizes = (process.env.DOMAIN_BENCH_INSTANCES ?? "1000").split(",").map(Number);

class NotYet extends Data.TaggedError("NotYet")<{
  readonly status: number;
  readonly body: string;
}> {}

const call = (url: string, method: "GET" | "POST", path: string) =>
  requestWorker(
    (method === "GET" ? HttpClientRequest.get : HttpClientRequest.post)(`${url}${path}`).pipe(
      HttpClientRequest.setHeaders({ connection: "close", "cache-control": "no-cache" }),
    ),
  ).pipe(
    Effect.retry({
      while: (error) => error._tag === "HttpClientError",
      schedule: Schedule.spaced("1 second"),
      times: 5,
    }),
    Effect.flatMap((res) =>
      res.text.pipe(
        Effect.flatMap((body) =>
          res.status === 200
            ? Effect.succeed(body)
            : Effect.fail(new NotYet({ status: res.status, body })),
        ),
      ),
    ),
  );

const serving = (url: string, version: string) =>
  call(url, "GET", "/version").pipe(
    Effect.filterOrFail(
      (body) => body === version,
      (body) => new NotYet({ status: 200, body }),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 90 }),
  );

interface Usage {
  readonly requests: number;
  readonly byType: Record<string, number>;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  /** Billed duration, in GB-seconds. */
  readonly duration: number;
}

/** The Worker's Durable Object usage between two instants, from Cloudflare's GraphQL analytics. */
const usage = (scriptName: string, from: Date, to: Date) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;
    const headers = formatHeaders(yield* yield* Credentials);
    const client = yield* HttpClient.HttpClient;
    const query = <T>(query: string) =>
      client
        .execute(
          HttpClientRequest.post("https://api.cloudflare.com/client/v4/graphql").pipe(
            HttpClientRequest.setHeaders(headers),
            HttpClientRequest.bodyJsonUnsafe({ query }),
          ),
        )
        .pipe(
          Effect.flatMap((res) => res.json),
          Effect.map(
            (body) => (body as { data: { viewer: { accounts: [T] } } }).data.viewer.accounts[0],
          ),
        );
    const window = `datetime_geq: "${from.toISOString()}", datetime_leq: "${to.toISOString()}"`;
    const { invocations } = yield* query<{
      invocations: ReadonlyArray<{
        sum: { requests: number };
        dimensions: { namespaceId: string; type: string };
      }>;
    }>(`{ viewer { accounts(filter: { accountTag: "${accountId}" }) {
      invocations: durableObjectsInvocationsAdaptiveGroups(limit: 1000, filter: { scriptName: "${scriptName}", ${window} }) {
        sum { requests } dimensions { namespaceId type }
      } } } }`);
    const namespaces = [...new Set(invocations.map((row) => row.dimensions.namespaceId))];
    const { periodic } =
      namespaces.length === 0
        ? { periodic: [] }
        : yield* query<{
            periodic: ReadonlyArray<{
              sum: { rowsRead: number; rowsWritten: number; duration: number };
            }>;
          }>(`{ viewer { accounts(filter: { accountTag: "${accountId}" }) {
            periodic: durableObjectsPeriodicGroups(limit: 1000, filter: { namespaceId_in: ${JSON.stringify(namespaces)}, ${window} }) {
              sum { rowsRead rowsWritten duration } dimensions { namespaceId }
            } } } }`);
    const byType: Record<string, number> = {};
    for (const row of invocations) {
      byType[row.dimensions.type] = (byType[row.dimensions.type] ?? 0) + row.sum.requests;
    }
    return {
      requests: invocations.reduce((total, row) => total + row.sum.requests, 0),
      byType,
      rowsRead: periodic.reduce((total, row) => total + row.sum.rowsRead, 0),
      rowsWritten: periodic.reduce((total, row) => total + row.sum.rowsWritten, 0),
      duration: periodic.reduce((total, row) => total + row.sum.duration, 0),
    } satisfies Usage;
  });

/** Analytics arrive minutes late: read until two reads a minute apart agree. */
const settledUsage = (scriptName: string, from: Date, to: Date) =>
  Effect.gen(function* () {
    let last = yield* usage(scriptName, from, to);
    for (let attempt = 0; attempt < 10; attempt++) {
      yield* Effect.sleep("1 minute");
      const next = yield* usage(scriptName, from, to);
      if (
        next.requests === last.requests &&
        next.rowsWritten === last.rowsWritten &&
        next.requests > 0
      ) {
        return next;
      }
      last = next;
    }
    return last;
  });

const now = Effect.sync(() => new Date());

const { test } = Test.make({ providers: Cloudflare.providers() });

for (const instances of sizes) {
  test.provider.skipIf(!!process.env.FAST)(
    `live: backfill of ${instances} instances with ${EVENTS} events each`,
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const { worker } = yield* stack.deploy(
          Effect.gen(function* () {
            return { worker: yield* BenchV1 };
          }),
        );
        const url = worker.url!.replace(/\/+$/, "");
        const scriptName = worker.workerName;
        yield* serving(url, "v1");

        // History before the view exists.
        const seedStart = yield* now;
        yield* Effect.forEach(
          Array.from({ length: Math.ceil(instances / SEED_BATCH) }, (_, i) => i * SEED_BATCH),
          (from) =>
            call(
              url,
              "POST",
              `/seed/${from}/${Math.min(SEED_BATCH, instances - from)}/${EVENTS}`,
            ).pipe(Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 })),
          { concurrency: 16, discard: true },
        );
        const seedEnd = yield* now;
        // Keep the seed out of the backfill's analytics window.
        yield* Effect.sleep("2 minutes");

        const deployStart = yield* now;
        yield* stack.deploy(
          Effect.gen(function* () {
            return { worker: yield* BenchV2 };
          }),
        );
        const deployEnd = yield* now;
        yield* serving(url, "v2");

        // The deploy returned once the backfill was done.
        const history = JSON.parse(yield* call(url, "GET", "/history")) as { complete: boolean };
        expect(history.complete).toBe(true);
        const expected = Array.from({ length: EVENTS }, (_, n) => n + 1);
        for (const i of [0, Math.floor(instances / 2), instances - 1]) {
          const body = JSON.parse(yield* call(url, "GET", `/deposits/b${i}`)) as {
            amounts: ReadonlyArray<number>;
          };
          expect(body.amounts).toEqual(expected);
        }

        const settleEnd = new Date(deployEnd.getTime() + 2 * 60_000);
        yield* Effect.sleep("2 minutes");
        const seed = yield* settledUsage(scriptName, seedStart, seedEnd);
        const backfill = yield* settledUsage(scriptName, deployStart, settleEnd);
        const events = instances * EVENTS;
        const result = {
          instances,
          events,
          deploySeconds: +((deployEnd.getTime() - deployStart.getTime()) / 1000).toFixed(1),
          seedSeconds: +((seedEnd.getTime() - seedStart.getTime()) / 1000).toFixed(1),
          backfill,
          seed,
          requestsPerInstance: +(backfill.requests / instances).toFixed(2),
          rowsWrittenPerEvent: +(backfill.rowsWritten / events).toFixed(2),
          rowsReadPerEvent: +(backfill.rowsRead / events).toFixed(2),
        };
        yield* Effect.sync(() => console.log(`BENCH ${JSON.stringify(result)}`));

        yield* stack.destroy();
      }),
    { timeout: 3_600_000 },
  );
}
