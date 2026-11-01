import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { registryFor, Stage } from "./stack.ts";

/**
 * The effectful form. It binds to its own space from inside the app: the service account
 * key `StackitBindings.Bind` creates has to arrive as an environment variable, and
 * `/get-space` only answers if it signs with that key.
 */
export default class EffectApp extends Stackit.CloudFoundry.App<EffectApp>()(
  "StackitCloudFoundryEffect",
  Effect.gen(function* () {
    const stage = yield* Stage;
    const registry = yield* registryFor("effect");
    return {
      spaceId: stage.space.spaceId,
      credentials: stage.credentials,
      main: import.meta.url,
      registry,
      memoryInMb: 256,
      env: { GREETING: "hello from effect" },
    };
  }),
  Effect.gen(function* () {
    const stage = yield* Stage;
    const getSpace = yield* Stackit.CloudFoundry.GetSpace(stage.space);

    const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
      effect.pipe(
        Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
        Effect.catchCause((cause) =>
          HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
        ),
      );

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://app");
        switch (url.pathname) {
          case "/hello":
            return yield* respond(
              Effect.sync(() => ({
                form: "effect",
                greeting: process.env.GREETING,
                keyIsPacked: (process.env.ALCHEMY_STACKIT_SERVICE_ACCOUNT_KEY ?? "").startsWith(
                  '{"_tag":"Redacted"',
                ),
              })),
            );
          case "/get-space":
            return yield* respond(getSpace());
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(Effect.provide(Stackit.CloudFoundry.GetSpaceHttp)),
) {}
