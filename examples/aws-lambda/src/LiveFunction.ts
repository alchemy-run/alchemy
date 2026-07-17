import * as AWS from "alchemy/AWS";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/**
 * Minimal fixture for exercising Live Lambda (`alchemy dev`): responds with
 * `process.platform`, which is `linux` when the handler runs in AWS and the
 * developer machine's platform (e.g. `darwin`) when proxied locally.
 */
export default class LiveFunction extends AWS.Lambda.Function<LiveFunction>()(
  "LiveFunction",
  { main: import.meta.url, url: true },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        return yield* HttpServerResponse.json({
          marker: "live-v1",
          platform: process.platform,
          functionName: process.env.AWS_LAMBDA_FUNCTION_NAME ?? null,
        });
      }),
    };
  }),
) {}
