import * as AWS from "@/AWS/index.ts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Probe for Lambda's Shutdown phase and post-response window.
 *
 * The init closure registers an instance-scope finalizer that writes a
 * marker to stdout (→ CloudWatch): the generated entry registers an
 * internal extension, so Lambda grants the runtime a 500 ms SIGTERM window
 * at sandbox spin-down in which the entry closes the instance scope — the
 * marker appears exactly once per sandbox, never per invocation.
 *
 * The fetch handler registers a deliberately slow (2 s) request-scope
 * finalizer: the extension holds the Invoke phase open after the response
 * is returned, so the response must come back fast while the marker still
 * lands in the logs afterwards.
 */
export default class ShutdownProbe extends AWS.Lambda.Function<ShutdownProbe>()(
  "ShutdownProbe",
  {
    main: import.meta.url,
    url: true,
    // Leaves ~9 s of post-response budget for the slow request finalizer
    // (the extension races queued work against the invocation deadline).
    timeout: Duration.seconds(10),
  },
  Effect.gen(function* () {
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => console.log("ALCHEMY_INSTANCE_FINALIZED")),
    );
    return {
      fetch: Effect.gen(function* () {
        yield* Effect.addFinalizer(() =>
          Effect.sleep("2 seconds").pipe(
            Effect.andThen(
              Effect.sync(() => console.log("ALCHEMY_REQUEST_FINALIZED")),
            ),
          ),
        );
        return HttpServerResponse.text("ok");
      }),
    };
  }),
) {}
