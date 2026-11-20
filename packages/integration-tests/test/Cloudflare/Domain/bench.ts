import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { Credentials, formatHeaders } from "@distilled.cloud/cloudflare/Credentials";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Schedule from "effect/Schedule";
import { requestWorker } from "../Utils/WorkerRequest.ts";

/**
 * What the Domain benchmarks share: seeding accounts over the bench Worker's
 * routes, and reading a Worker's Durable Object usage from Cloudflare's
 * analytics.
 */

export const EVENTS = 10;
// A Worker request runs at most 6 outgoing calls at once: seed in small batches, many at a time.
export const SEED_BATCH = 10;
// Deposits to one account per request: one object takes them in order.
export const DEPOSIT_BATCH = 1000;
export class NotYet extends Data.TaggedError("NotYet")<{
  readonly status: number;
  readonly body: string;
}> {}

export const call = (url: string, method: "GET" | "POST", path: string) =>
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

export const serving = (url: string, version: string) =>
  call(url, "GET", "/version").pipe(
    Effect.filterOrFail(
      (body) => body === version,
      (body) => new NotYet({ status: 200, body }),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 90 }),
  );

export interface Usage {
  readonly requests: number;
  readonly byType: Record<string, number>;
  readonly rowsRead: number;
  readonly rowsWritten: number;
  /** Billed duration, in GB-seconds. */
  readonly duration: number;
}

/** The Worker's Durable Object usage between two instants, from Cloudflare's GraphQL analytics. */
export const usage = (scriptName: string, from: Date, to: Date) =>
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

/**
 * Analytics arrive minutes late, and later the more there are: wait five minutes,
 * then read until three reads a minute apart agree. Read before the stack is
 * destroyed: a deleted Worker's rows lose its script name.
 */
export const settledUsage = (scriptName: string, from: Date, to: Date) =>
  Effect.gen(function* () {
    yield* Effect.sleep("5 minutes");
    let last = yield* usage(scriptName, from, to);
    let agreed = 0;
    for (let attempt = 0; attempt < 15 && agreed < 2; attempt++) {
      yield* Effect.sleep("1 minute");
      const next = yield* usage(scriptName, from, to);
      agreed =
        next.requests === last.requests && next.rowsWritten === last.rowsWritten ? agreed + 1 : 0;
      last = next;
    }
    return last;
  });

export const now = Effect.sync(() => new Date());

/** Retry a seed request, logging why: a slow seed is otherwise silent. */
export const seedRetry = <A, E extends { readonly _tag: string }, R>(
  path: string,
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    // A seed request can hang for many minutes: fail it and send it again (seeds are idempotent).
    Effect.timeout("2 minutes"),
    Effect.tapError((error) =>
      Effect.sync(() =>
        console.log(
          `SEED-RETRY ${path} ${error._tag}${"status" in error ? ` ${String(error.status)}` : ""}${"body" in error ? ` ${String(error.body).slice(0, 120)}` : ""}`,
        ),
      ),
    ),
    Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
  );

export const seedAccounts = (url: string, accounts: number, events: number) =>
  Effect.forEach(
    Array.from({ length: Math.ceil(accounts / SEED_BATCH) }, (_, i) => i * SEED_BATCH),
    (from) => {
      const path = `/seed/${from}/${Math.min(SEED_BATCH, accounts - from)}/${events}`;
      return seedRetry(path, call(url, "POST", path));
    },
    { concurrency: 64, discard: true },
  );

export const seedOne = (url: string, account: string, events: number) =>
  Effect.forEach(
    Array.from({ length: Math.ceil(events / DEPOSIT_BATCH) }, (_, i) => i * DEPOSIT_BATCH + 1),
    (from) => {
      const path = `/deposit/${account}/${from}/${Math.min(DEPOSIT_BATCH, events - from + 1)}`;
      return seedRetry(path, call(url, "POST", path));
    },
    { concurrency: 4, discard: true },
  );
