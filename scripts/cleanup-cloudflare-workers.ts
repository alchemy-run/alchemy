#!/usr/bin/env bun
/**
 * Bulk-delete Cloudflare Workers in the current Alchemy profile's account.
 * A worker is deleted if either:
 *   - its name does NOT contain `KEEP` (default "alchemy"), OR
 *   - its name contains ANY substring in the comma-separated `DELETE_MATCH`
 *     list (default `pr-,create-update,alchemy-test,distilled`)
 *
 * `DELETE_MATCH` overrides `KEEP`, so e.g. `alchemy-test-*` workers are
 * deleted even though they contain "alchemy".
 *
 * Queue-consumer workers can't be deleted directly — Cloudflare returns
 * `QueueConsumerConflict`. The script pre-builds a `scriptName → consumers`
 * map by fanning `listConsumers` across every queue, and on conflict
 * deletes each consumer first then retries the script delete.
 *
 * Authentication resolves through the active Alchemy profile
 * (`ALCHEMY_PROFILE`, default `default`).
 *
 * Usage:
 *   bun scripts/cleanup-cloudflare-workers.ts
 *   KEEP=alchemy DELETE_MATCH=pr-,distilled bun scripts/cleanup-cloudflare-workers.ts
 *   DRY_RUN=1 bun scripts/cleanup-cloudflare-workers.ts
 *   CONCURRENCY=16 bun scripts/cleanup-cloudflare-workers.ts
 *   ALCHEMY_PROFILE=staging bun scripts/cleanup-cloudflare-workers.ts
 */
import {
  Credentials as CfCredentials,
  formatHeaders,
} from "@distilled.cloud/cloudflare/Credentials";
import * as queues from "@distilled.cloud/cloudflare/queues";
import * as workers from "@distilled.cloud/cloudflare/workers";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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

const KEEP = (process.env.KEEP ?? "alchemy").toLowerCase();
const DELETE_PATTERNS = (
  process.env.DELETE_MATCH ?? "pr-,create-update,alchemy-test,distilled"
)
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter((s) => s.length > 0);
const DRY_RUN = process.env.DRY_RUN === "1";
const CONCURRENCY = Math.max(1, Number(process.env.CONCURRENCY ?? 8));

const shouldDelete = (name: string): boolean => {
  const lower = name.toLowerCase();
  if (DELETE_PATTERNS.some((p) => lower.includes(p))) return true;
  if (!lower.includes(KEEP)) return true;
  return false;
};

/**
 * Walk every queue page in the account. The distilled SDK's `listQueues`
 * only returns the first page (100 results); large accounts overflow.
 */
const listAllQueues = (accountId: string) =>
  Effect.gen(function* () {
    const credentialsEff = yield* CfCredentials;
    const credentials = yield* credentialsEff;
    const headers = formatHeaders(credentials);
    const client = yield* HttpClient.HttpClient;

    const ids: string[] = [];
    for (let page = 1; ; page++) {
      const res = yield* client.execute(
        HttpClientRequest.get(
          `${credentials.apiBaseUrl}/accounts/${accountId}/queues?page=${page}`,
        ).pipe(HttpClientRequest.setHeaders(headers)),
      );
      const body = (yield* res.json) as {
        result?: { queue_id?: string }[] | null;
      };
      const batch = body.result ?? [];
      if (batch.length === 0) break;
      for (const q of batch) {
        if (q.queue_id) ids.push(q.queue_id);
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
const buildConsumerMap = (accountId: string) =>
  Effect.gen(function* () {
    const queueIds = yield* listAllQueues(accountId);

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
      JSON.stringify({
        main_module: "worker.js",
        bindings: [],
      }),
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

const deleteWithConsumerRecovery = (
  accountId: string,
  scriptName: string,
  consumers: Map<string, { queueId: string; consumerId: string }[]>,
) =>
  workers.deleteScript({ accountId, scriptName, force: true }).pipe(
    Effect.catchTag("QueueConsumerConflict", () =>
      Effect.gen(function* () {
        const bindings = consumers.get(scriptName) ?? [];
        if (bindings.length === 0) {
          // No queue ↔ consumer mapping found — overwrite the worker
          // with an empty script then retry the delete.
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
            // If Cloudflare still complains after unwiring the queue
            // consumers we found, fall back to overwriting.
            Effect.catchTag("QueueConsumerConflict", () =>
              forceOverwriteAndDelete(accountId, scriptName),
            ),
          );
      }),
    ),
  );

const program = Effect.gen(function* () {
  const { accountId } = yield* CloudflareEnvironment;
  yield* Console.log(
    `→ account=${accountId} keep=${JSON.stringify(KEEP)} deleteMatch=${JSON.stringify(DELETE_PATTERNS)} dryRun=${DRY_RUN} concurrency=${CONCURRENCY}`,
  );

  const consumers = yield* buildConsumerMap(accountId);
  yield* Console.log(
    `→ queue-consumer bindings indexed for ${consumers.size} scripts`,
  );

  const response = yield* workers.listScripts({ accountId });
  const all = (response.result ?? []).flatMap((s): string[] =>
    s.id == null ? [] : [s.id],
  );
  yield* Console.log(`→ total scripts: ${all.length}`);

  const victims = all.filter(shouldDelete);
  yield* Console.log(`→ scripts to delete: ${victims.length}`);
  for (const id of victims) yield* Console.log(`   - ${id}`);
  if (DRY_RUN || victims.length === 0) return;

  let ok = 0;
  let fail = 0;
  yield* Effect.forEach(
    victims,
    (scriptName) =>
      deleteWithConsumerRecovery(accountId, scriptName, consumers).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            ok += 1;
            console.log(`✓ deleted ${scriptName} (${ok}/${victims.length})`);
          }),
        ),
        Effect.catch((e) =>
          Effect.sync(() => {
            fail += 1;
            console.error(`✗ ${scriptName}: ${String(e)}`);
          }),
        ),
      ),
    { concurrency: CONCURRENCY, discard: true },
  );
  yield* Console.log(`→ done: deleted=${ok} failed=${fail}`);
  if (fail > 0) return yield* Effect.fail(new Error("some deletes failed"));
});

// Mirror the `cloudflareLayers` wiring from
// `packages/alchemy/src/Cli/commands/cloudflare.ts` so the script resolves
// credentials through whichever profile is active (`ALCHEMY_PROFILE`,
// default `default`) — env, stored, or oauth.
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
