import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Ping, Puller, registryFor } from "./stack.ts";

/**
 * The effectful form. It binds to the async fixture from inside a Function: the
 * service account key `StackitBindings.Bind` creates has to arrive as a revision
 * variable, and `/get-function` only answers if it signs with that key.
 */
export default class EffectFunction extends Stackit.Functions.Function<EffectFunction>()(
  "StackitFunctionsEffect",
  Effect.gen(function* () {
    const puller = yield* Puller;
    const registry = yield* registryFor("effect");
    return {
      main: import.meta.url,
      registry,
      pullCredential: puller.pullCredentialId,
      env: { GREETING: "hello from effect" },
    };
  }),
  Effect.gen(function* () {
    const ping = yield* Ping;
    const getFunction = yield* Stackit.Functions.GetFunction(ping);
    const invoke = yield* Stackit.Functions.Invoke(ping);

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
        const url = new URL(request.url, "http://function");
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
          case "/get-function":
            return yield* respond(getFunction());
          case "/invoke":
            return yield* respond(
              invoke({ path: "/through-invoke" }).pipe(Effect.flatMap((response) => response.json)),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(Effect.provide([Stackit.Functions.GetFunctionHttp, Stackit.Functions.InvokeHttp])),
) {}
