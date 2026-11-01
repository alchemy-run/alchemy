import type * as loki from "@distilled.cloud/stackit/logs_loki";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { Credential } from "./Credential.ts";
import type { Instance } from "./Instance.ts";

/**
 * Bind an {@link Instance} and a {@link Credential} to the instance's Loki push API, on its
 * `logsPushUrl`. Provide {@link PushLogsHttp}. Lines are in Loki's JSON format, with
 * nanosecond timestamps as strings. Needs a plan with logs, such as
 * `Observability-Starter-EU01`.
 *
 * Calls authenticate with the credential's HTTP Basic, so this grants no STACKIT role
 * and creates no service account: the credential's username and `Redacted` password
 * and the instance's URL travel through the host's environment. STACKIT has no
 * narrower credential, so it can do everything the API allows on the instance: the
 * limit here is the client's surface, not a permission. When the instance has an
 * `acl`, the host's egress address has to be in it.
 *
 * ### Pushing Logs
 * **Example:** Push a line from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Metrics = Stackit.Observability.Instance("Metrics", {
 *   plan: "Observability-Starter-EU01",
 * });
 * export const Reader = Metrics.pipe(
 *   Effect.flatMap((metrics) =>
 *     Stackit.Observability.Credential("Reader", { instanceId: metrics.instanceId }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const metrics = yield* Metrics;
 *     const reader = yield* Reader;
 *     const pushLogs = yield* Stackit.Observability.PushLogs(metrics, reader);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* pushLogs({
 *           streams: [{ stream: { app: "api" }, values: [[`${Date.now()}000000`, "hello"]] }],
 *         });
 *         return yield* HttpServerResponse.json({ pushed: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Observability.PushLogsHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category Observability
 */
export interface PushLogs extends Binding.Service<
  PushLogs,
  "Stackit.Observability.PushLogs",
  (
    instance: Instance,
    credential: Credential,
  ) => Effect.Effect<
    (request: loki.PushRequest) => Effect.Effect<loki.PushResponse, loki.PushError, RuntimeContext>
  >
> {}

export const PushLogs = Binding.Service<PushLogs>("Stackit.Observability.PushLogs");
