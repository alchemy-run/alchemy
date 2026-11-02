import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { sendSyslog, SyslogDrainMissing, type SyslogEntry } from "../internal/syslog.ts";
import type { Credential } from "./Credential.ts";
import { WriteLog } from "./WriteLog.ts";

/**
 * Implementation of {@link WriteLog}, over a syslog socket. The name keeps the package's
 * `<Op>Http` convention; no HTTP is involved.
 *
 * @layer
 * @provides Stackit.LogMe.WriteLog
 */
export const WriteLogHttp = Layer.succeed(
  WriteLog,
  Effect.fn(function* (credential: Credential) {
    const drain = yield* credential.syslogDrainUrl;
    return (entries: SyslogEntry | ReadonlyArray<SyslogEntry>) =>
      Effect.gen(function* () {
        const url = yield* drain;
        if (url === undefined) {
          return yield* new SyslogDrainMissing({
            message: "This LogMe credential has no syslog drain URL.",
          });
        }
        yield* sendSyslog(url, entries);
      });
  }),
);
