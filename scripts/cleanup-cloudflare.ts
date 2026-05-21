#!/usr/bin/env bun
/**
 * Bulk-delete Cloudflare resources in the active Alchemy profile's account.
 *
 * Cleans up: Workers, Hyperdrive configs, D1 databases, Queues, Workflows.
 *
 * Workers obey a name filter (alchemy-* are preserved by default). Workers
 * that are queue consumers can't be deleted directly — Cloudflare returns
 * `QueueConsumerConflict`. The script pre-builds a `scriptName → consumers`
 * map by fanning `listConsumers` across every queue, and on conflict
 * deletes each consumer first then retries the script delete.
 *
 * Hyperdrive, D1, Queues, and Workflows are deleted unconditionally
 * (the API enforces unique names within the account; nothing to keep).
 *
 * Authentication resolves through the active Alchemy profile
 * (`ALCHEMY_PROFILE`, default `default`).
 *
 * Usage:
 *   bun scripts/cleanup-cloudflare.ts
 *   KEEP=alchemy- DELETE_MATCH=pr-,distilled bun scripts/cleanup-cloudflare.ts
 *   DRY_RUN=1 bun scripts/cleanup-cloudflare.ts
 *   CONCURRENCY=16 bun scripts/cleanup-cloudflare.ts
 *   SKIP=hyperdrive,d1 bun scripts/cleanup-cloudflare.ts
 *   ALCHEMY_PROFILE=staging bun scripts/cleanup-cloudflare.ts
 */
import {
  Credentials as CfCredentials,
  formatHeaders,
} from "@distilled.cloud/cloudflare/Credentials";
import * as d1 from "@distilled.cloud/cloudflare/d1";
import * as hyperdrive from "@distilled.cloud/cloudflare/hyperdrive";
import * as queues from "@distilled.cloud/cloudflare/queues";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as workflows from "@distilled.cloud/cloudflare/workflows";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { AuthProviders } from "../packages/alchemy/src/Auth/AuthProvider.ts";
import { CredentialsStoreLive } from "../packages/alchemy/src/Auth/Credentials.ts";
import { ProfileLive } from "../packages/alchemy/src/Auth/Profile.ts";
import { CloudflareAuth } from "../packages/alchemy/src/Cloudflare/Auth/AuthProvider.ts";
import {
  CloudflareEnvironment,
  fromProfile,
} from "../packages/alchemy/src/Cloudflare/CloudflareEnvironment.ts";
import { fromAuthProvider } from "../packages/alchemy/src/Cloudflare/Credentials.ts";
import {
  PlatformServices,
  runMain,
} from "../packages/alchemy/src/Util/PlatformServices.ts";

const KEEP = (process.env.KEEP ?? "alchemy-").toLowerCase();
const DELETE_PATTERNS = (process.env.DELETE_MATCH ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s.length > 0);
const DRY_RUN = process.env.DRY_RUN === "1";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? 8));
const SKIP = new Set(
  (process.env.SKIP ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0),
);

const shouldDeleteWorker = (name: string): boolean => {
  const lower = name.toLowerCase();
  if (DELETE_PATTERNS.some((p) => lower.includes(p))) return true;
  if (!lower.includes(KEEP)) return true;
  return false;
};

/**
 * Walk every queue page in the account. The distilled SDK's `listQueues`
 * only returns the first page (100 results); large accounts overflow.
 */
const listAllQueueIds = (accountId: string) =>
  Effect.gen(function* () {
    const credentialsEff = yield* CfCredentials;
    const credentials = yield* credentialsEff;
    const headers = formatHeaders(credentials);
    const client = yield* HttpClient.HttpClient;

    const ids: { queueId: string; queueName: string }[] = [];
    for (let page = 1; ; page++) {
      const res = yield* client.execute(
        HttpClientRequest.get(
          `${credentials.apiBaseUrl}/accounts/${accountId}/queues?page=${page}`,
        ).pipe(HttpClientRequest.setHeaders(headers)),
      );
      const body = (yield* res.json) as {
        result?: { queue_id?: string; queue_name?: string }[] | null;
      };
      const batch = body.result ?? [];
      if (batch.length === 0) break;
      for (const q of batch) {
        if (q.queue_id) {
          ids.push({
            queueId: q.queue_id,
            queueName: q.queue_name ?? q.queue_id,
          });
        }
      }
    }
    return ids;
  });

/**
 * Map `scriptName → [{queueId, consumerId}, ...]` built by fanning out
 * `listConsumers` across every queue in the account.
 *
 * Used to clear queue-consumer bindings before re-trying a worker delete
 * that failed with `QueueConsumerConflict`.
 */
const buildConsumerMap = (accountId: string, queueIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const map = new Map<string, { queueId: string; consumerId: string }[]>();
    yield* Effect.forEach(
      queueIds,
      (queueId) =>
        queues.listConsumers({ accountId, queueId }).pipe(
          Effect.tap((res) =>
            Effect.sync(() => {
              for (const c of res.result ?? []) {
                const consumerId = c.consumerId;
                const script = "script" in c ? c.script : undefined;
                if (!consumerId || !script) return;
                const entry = map.get(script) ?? [];
                entry.push({ queueId, consumerId });
                map.set(script, entry);
              }
            }),
          ),
          Effect.catch(() => Effect.void),
        ),
      { concurrency: 8, discard: true },
    );
    return map;
  });

/**
 * Last-resort cleanup: PUT a minimal script over the worker with no
 * bindings, no queue consumer config. Cloudflare drops the queue-consumer
 * relationship when the script's bindings list no longer contains it, so
 * a follow-up `deleteScript` then succeeds. Used when `listQueues` has
 * no matching consumer entry but the API still insists the worker is a
 * consumer (orphaned reference from a deleted queue).
 */
const forceOverwriteAndDelete = (accountId: string, scriptName: string) =>
  Effect.gen(function* () {
    const credentialsEff = yield* CfCredentials;
    const credentials = yield* credentialsEff;
    const headers = formatHeaders(credentials);

    const form = new FormData();
    form.append(
      "metadata",
      JSON.stringify({ main_module: "worker.js", bindings: [] }),
    );
    form.append(
      "worker.js",
      new Blob(
        [
          "export default { fetch() { return new Response('deleted', { status: 410 }); } };",
        ],
        { type: "application/javascript+module" },
      ),
      "worker.js",
    );

    const client = yield* HttpClient.HttpClient;
    yield* client.execute(
      HttpClientRequest.put(
        `${credentials.apiBaseUrl}/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`,
      ).pipe(
        HttpClientRequest.setHeaders(headers),
        HttpClientRequest.bodyFormData(form),
      ),
    );
    yield* Console.log(`  ↳ overwrote ${scriptName} with empty script`);
    return yield* workers.deleteScript({
      accountId,
      scriptName,
      force: true,
    });
  });

const deleteWorkerWithConsumerRecovery = (
  accountId: string,
  scriptName: string,
  consumers: Map<string, { queueId: string; consumerId: string }[]>,
) =>
  workers.deleteScript({ accountId, scriptName, force: true }).pipe(
    Effect.catchTag("QueueConsumerConflict", () =>
      Effect.gen(function* () {
        const bindings = consumers.get(scriptName) ?? [];
        if (bindings.length === 0) {
          return yield* forceOverwriteAndDelete(accountId, scriptName);
        }
        for (const { queueId, consumerId } of bindings) {
          yield* queues.deleteConsumer({ accountId, queueId, consumerId }).pipe(
            Effect.tap(() =>
              Console.log(
                `  ↳ unbound consumer ${consumerId} from queue ${queueId} for ${scriptName}`,
              ),
            ),
            Effect.catchTag("ConsumerNotFound", () => Effect.void),
          );
        }
        return yield* workers
          .deleteScript({ accountId, scriptName, force: true })
          .pipe(
            Effect.catchTag("QueueConsumerConflict", () =>
              forceOverwriteAndDelete(accountId, scriptName),
            ),
          );
      }),
    ),
  );

interface CleanupResult {
  readonly kind: string;
  readonly listed: number;
  readonly ok: number;
  readonly fail: number;
}

const driveCleanup = <Item, E, R>(
  kind: string,
  items: ReadonlyArray<Item>,
  label: (item: Item) => string,
  del: (item: Item) => Effect.Effect<unknown, E, R>,
): Effect.Effect<CleanupResult, never, R> =>
  Effect.gen(function* () {
    yield* Console.log(`\n=== ${kind} ===`);
    yield* Console.log(`→ found ${items.length}`);
    for (const item of items) yield* Console.log(`   - ${label(item)}`);
    if (DRY_RUN || items.length === 0) {
      return { kind, listed: items.length, ok: 0, fail: 0 };
    }
    let ok = 0;
    let fail = 0;
    yield* Effect.forEach(
      items,
      (item) =>
        del(item).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              ok += 1;
              console.log(
                `✓ ${kind}: deleted ${label(item)} (${ok}/${items.length})`,
              );
            }),
          ),
          Effect.catch((e) =>
            Effect.sync(() => {
              fail += 1;
              console.error(`✗ ${kind}: ${label(item)}: ${String(e)}`);
            }),
          ),
        ),
      { concurrency: CONCURRENCY, discard: true },
    );
    return { kind, listed: items.length, ok, fail };
  });

const cleanupWorkers = (accountId: string, queueIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const consumerMap = yield* buildConsumerMap(accountId, queueIds);
    yield* Console.log(
      `→ queue-consumer bindings indexed for ${consumerMap.size} scripts`,
    );
    const all = yield* workers.listScripts.items({ accountId }).pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk).flatMap((s): string[] =>
          s.id == null ? [] : [s.id],
        ),
      ),
    );
    yield* Console.log(`→ total worker scripts: ${all.length}`);
    const victims = all.filter(shouldDeleteWorker);
    yield* Console.log(
      `→ workers to delete: ${victims.length} (keep=${JSON.stringify(KEEP)} deleteMatch=${JSON.stringify(DELETE_PATTERNS)})`,
    );
    return yield* driveCleanup(
      "workers",
      victims,
      (name) => name,
      (name) => deleteWorkerWithConsumerRecovery(accountId, name, consumerMap),
    );
  });

const cleanupHyperdrives = (accountId: string) =>
  Effect.gen(function* () {
    const all = yield* hyperdrive.listConfigs.items({ accountId }).pipe(
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    );
    return yield* driveCleanup(
      "hyperdrive",
      all,
      (c) => `${c.name} (${c.id})`,
      (c) =>
        hyperdrive
          .deleteConfig({ accountId, hyperdriveId: c.id })
          .pipe(Effect.catchTag("HyperdriveConfigNotFound", () => Effect.void)),
    );
  });

const cleanupD1 = (accountId: string) =>
  Effect.gen(function* () {
    const all = yield* d1.listDatabases.items({ accountId }).pipe(
      Stream.runCollect,
      Effect.map((chunk) =>
        Array.from(chunk).flatMap((db): { uuid: string; name: string }[] =>
          db.uuid == null ? [] : [{ uuid: db.uuid, name: db.name ?? db.uuid }],
        ),
      ),
    );
    return yield* driveCleanup(
      "d1",
      all,
      (db) => `${db.name} (${db.uuid})`,
      (db) =>
        d1
          .deleteDatabase({ accountId, databaseId: db.uuid })
          .pipe(Effect.catchTag("DatabaseNotFound", () => Effect.void)),
    );
  });

const cleanupQueues = (
  accountId: string,
  queueIds: ReadonlyArray<{ queueId: string; queueName: string }>,
) =>
  driveCleanup(
    "queues",
    queueIds,
    (q) => `${q.queueName} (${q.queueId})`,
    (q) =>
      queues
        .deleteQueue({ accountId, queueId: q.queueId })
        .pipe(Effect.catchTag("QueueNotFound", () => Effect.void)),
  );

// The distilled SDK's `listWorkflows` schema requires `className: string`,
// but Cloudflare returns `class_name: null` for some workflows. Use raw
// HTTP to side-step the schema decoder.
const listAllWorkflows = (accountId: string) =>
  Effect.gen(function* () {
    const credentialsEff = yield* CfCredentials;
    const credentials = yield* credentialsEff;
    const headers = formatHeaders(credentials);
    const client = yield* HttpClient.HttpClient;

    const items: { id: string; name: string }[] = [];
    for (let page = 1; ; page++) {
      const res = yield* client.execute(
        HttpClientRequest.get(
          `${credentials.apiBaseUrl}/accounts/${accountId}/workflows?page=${page}&per_page=100`,
        ).pipe(HttpClientRequest.setHeaders(headers)),
      );
      const body = (yield* res.json) as {
        result?: { id?: string; name?: string }[] | null;
      };
      const batch = body.result ?? [];
      if (batch.length === 0) break;
      for (const w of batch) {
        if (w.id && w.name) items.push({ id: w.id, name: w.name });
      }
      if (batch.length < 100) break;
    }
    return items;
  });

const cleanupWorkflows = (accountId: string) =>
  Effect.gen(function* () {
    const all = yield* listAllWorkflows(accountId);
    return yield* driveCleanup(
      "workflows",
      all,
      (w) => `${w.name} (${w.id})`,
      (w) =>
        workflows
          .deleteWorkflow({ accountId, workflowName: w.name })
          .pipe(Effect.catchTag("WorkflowNotFound", () => Effect.void)),
    );
  });

const program = Effect.gen(function* () {
  const { accountId } = yield* CloudflareEnvironment;
  yield* Console.log(
    `→ account=${accountId} dryRun=${DRY_RUN} concurrency=${CONCURRENCY} skip=${JSON.stringify([...SKIP])}`,
  );

  const queueRecords =
    SKIP.has("queues") && SKIP.has("workers")
      ? []
      : yield* listAllQueueIds(accountId);
  const queueIds = queueRecords.map((q) => q.queueId);

  const results: CleanupResult[] = [];

  // Workflows first — they may reference workers.
  if (!SKIP.has("workflows")) {
    results.push(yield* cleanupWorkflows(accountId));
  }
  // Hyperdrive next — independent.
  if (!SKIP.has("hyperdrive")) {
    results.push(yield* cleanupHyperdrives(accountId));
  }
  // Workers — clears queue-consumer bindings, may PUT empty scripts.
  if (!SKIP.has("workers")) {
    results.push(yield* cleanupWorkers(accountId, queueIds));
  }
  // Queues — after workers so producers/consumers are gone.
  if (!SKIP.has("queues")) {
    results.push(yield* cleanupQueues(accountId, queueRecords));
  }
  // D1 last — workers using it should be gone first.
  if (!SKIP.has("d1")) {
    results.push(yield* cleanupD1(accountId));
  }

  yield* Console.log("\n=== summary ===");
  for (const r of results) {
    yield* Console.log(
      `  ${r.kind}: listed=${r.listed} deleted=${r.ok} failed=${r.fail}`,
    );
  }
  const totalFail = results.reduce((acc, r) => acc + r.fail, 0);
  if (totalFail > 0) {
    return yield* Effect.fail(new Error(`${totalFail} delete(s) failed`));
  }
});

const authProviders: AuthProviders["Service"] = {};
const authRegistry = Layer.succeed(AuthProviders, authProviders);
const authLayer = Layer.provideMerge(CloudflareAuth, authRegistry);

const profile = Layer.mergeAll(
  Layer.provide(ProfileLive, PlatformServices),
  Layer.provide(CredentialsStoreLive, PlatformServices),
);

const cloudflare = Layer.mergeAll(fromAuthProvider(), fromProfile()).pipe(
  Layer.provide(authLayer),
  Layer.provide(profile),
);

const services = Layer.mergeAll(cloudflare, FetchHttpClient.layer);

runMain(program.pipe(Effect.provide(services)));
