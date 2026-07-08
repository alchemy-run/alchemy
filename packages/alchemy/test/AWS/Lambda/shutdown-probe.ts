import * as AWS from "@/AWS/index.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Probe for Lambda's Shutdown phase. The init closure registers an
 * instance-scope finalizer that writes a marker to stdout (→ CloudWatch).
 * The generated entry registers an internal extension, so Lambda grants the
 * runtime a 500 ms SIGTERM window at shutdown, in which the entry closes
 * the instance scope and this finalizer runs — exactly once per sandbox,
 * never per invocation.
 */
export default class ShutdownProbe extends AWS.Lambda.Function<ShutdownProbe>()(
  "ShutdownProbe",
  {
    main: import.meta.url,
    url: true,
  },
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => console.log("ALCHEMY_INSTANCE_FINALIZED")),
    );
    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }),
) {}
