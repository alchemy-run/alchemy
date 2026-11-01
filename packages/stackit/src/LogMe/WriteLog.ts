import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { SyslogEntry, SyslogError } from "../internal/syslog.ts";
import type { Credential } from "./Credential.ts";

export type { SyslogEntry, SyslogError };

/**
 * Runtime binding that sends log lines to a LogMe instance's syslog drain: the
 * credential's `syslogDrainUrl`.
 *
 * It opens a socket per call, writes each entry as a newline-framed RFC 5424 message,
 * and closes it, so **the host needs raw TCP**: on a Cloudflare Worker, the
 * `nodejs_compat` flag. A `syslog-tls://` or `tls://` URL connects with TLS, a
 * `syslog://` or `tcp://` one without. Any other URL fails with
 * `SyslogDrainUnsupported`, and a credential without one with `SyslogDrainMissing`.
 *
 * Nothing confirms a line was stored, since syslog has no acknowledgement: read it back
 * with `SearchLogs`. Lines take no STACKIT role and no service account. The host's egress
 * IP has to be in the instance's `acl`, or it can't connect.
 *
 * To forward another STACKIT instance's logs here, you don't need this binding: set that
 * instance's `syslog` prop.
 *
 * ### Sending Logs
 * **Example:** Send an entry from a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Logs = Stackit.LogMe.Instance("Logs", {
 *   version: "2",
 *   planName: "stackit-logme2-1.2.50-replica",
 *   acl: ["203.0.113.7/32"],
 * });
 * export const App = Logs.pipe(
 *   Effect.flatMap((logs) => Stackit.LogMe.Credential("App", { instanceId: logs.instanceId })),
 * );
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const credential = yield* App;
 *     const writeLog = yield* Stackit.LogMe.WriteLog(credential);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* writeLog({ message: "order placed", severity: 6, appName: "api" });
 *         return yield* HttpServerResponse.json({ ok: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.LogMe.WriteLogHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category LogMe
 */
export interface WriteLog extends Binding.Service<
  WriteLog,
  "Stackit.LogMe.WriteLog",
  (
    credential: Credential,
  ) => Effect.Effect<
    (
      entries: SyslogEntry | ReadonlyArray<SyslogEntry>,
    ) => Effect.Effect<void, SyslogError, RuntimeContext>
  >
> {}

export const WriteLog = Binding.Service<WriteLog>("Stackit.LogMe.WriteLog");
