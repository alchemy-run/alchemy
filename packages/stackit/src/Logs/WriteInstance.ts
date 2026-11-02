import type * as loki from "@distilled.cloud/stackit/logs_loki";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { AccessToken } from "./AccessToken.ts";

export interface WriteInstanceClient {
  /** Push log lines in Loki's JSON format. Timestamps are nanosecond strings. */
  push: (
    request: loki.PushRequest,
  ) => Effect.Effect<loki.PushResponse, loki.PushError, RuntimeContext>;
  /** Push log records in OTLP/HTTP's JSON encoding. */
  pushOtlp: (
    request: loki.PushOtlpRequest,
  ) => Effect.Effect<loki.PushOtlpResponse, loki.PushOtlpError, RuntimeContext>;
}

/**
 * Bind an {@link AccessToken} to the write half of a Logs instance's Loki API: `push`
 * and `pushOtlp`. Provide {@link WriteInstanceHttp}.
 *
 * Calls authenticate with the token, on the instance's own Grafana Loki API, so this
 * grants no STACKIT role and creates no service account: the token and the instance's
 * URL travel through the host's environment, with the token kept `Redacted`. The token
 * needs the `write` permission, or Loki's gateway refuses the call. The host's egress
 * IP has to be in the instance's `acl`, or it can't connect.
 *
 * ### Pushing Logs
 * **Example:** Push a line from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Logs = Stackit.Logs.Instance("Logs", { acl: ["0.0.0.0/0"] });
 * export const Token = Logs.pipe(
 *   Effect.flatMap((logs) =>
 *     Stackit.Logs.AccessToken("Token", {
 *       instanceId: logs.instanceId,
 *       permissions: ["write"],
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const logs = yield* Stackit.Logs.WriteInstance(yield* Token);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* logs.push({
 *           streams: [{ stream: { app: "api" }, values: [[`${Date.now()}000000`, "hello"]] }],
 *         });
 *         return HttpServerResponse.empty();
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Logs.WriteInstanceHttp)),
 * ) {}
 * ```
 *
 * **Example:** Push an OTLP log record from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Logs = Stackit.Logs.Instance("Logs", { acl: ["0.0.0.0/0"] });
 * export const Token = Logs.pipe(
 *   Effect.flatMap((logs) =>
 *     Stackit.Logs.AccessToken("Token", {
 *       instanceId: logs.instanceId,
 *       permissions: ["write"],
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const logs = yield* Stackit.Logs.WriteInstance(yield* Token);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* logs.pushOtlp({
 *           resourceLogs: [
 *             {
 *               resource: {
 *                 attributes: [{ key: "service.name", value: { stringValue: "api" } }],
 *               },
 *               scopeLogs: [
 *                 {
 *                   logRecords: [
 *                     {
 *                       timeUnixNano: `${Date.now()}000000`,
 *                       severityText: "INFO",
 *                       body: { stringValue: "hello" },
 *                     },
 *                   ],
 *                 },
 *               ],
 *             },
 *           ],
 *         });
 *         return HttpServerResponse.empty();
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Logs.WriteInstanceHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product STACKIT Logs
 * @category Logs
 */
export interface WriteInstance extends Binding.Service<
  WriteInstance,
  "Stackit.Logs.WriteInstance",
  (accessToken: AccessToken) => Effect.Effect<WriteInstanceClient>
> {}

export const WriteInstance = Binding.Service<WriteInstance>("Stackit.Logs.WriteInstance");
