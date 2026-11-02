import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Ping, PullLogin, registryFor } from "./stack.ts";

/**
 * The effectful form. It binds to the async fixture from inside an Application: the service
 * account key `StackitBindings.Bind` creates has to arrive through an environment secret, and
 * `/get-application` only answers if it signs with that key.
 */
export default class EffectApplication extends Stackit.ContainerApplications.Application<EffectApplication>()(
  "StackitScaEffect",
  Effect.gen(function* () {
    const login = yield* PullLogin;
    const registry = yield* registryFor("effect");
    return {
      main: import.meta.url,
      environmentId: login.environmentId,
      registry,
      env: { GREETING: "hello from effect" },
    };
  }),
  Effect.gen(function* () {
    const ping = yield* Ping;
    const getApplication = yield* Stackit.ContainerApplications.GetApplication(ping);

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
        const url = new URL(request.url, "http://application");
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
          case "/get-application":
            return yield* respond(
              // A container variable's value must not leave the Application in the test's logs.
              getApplication().pipe(
                Effect.map(({ id, status }) => ({ id, status: status?.current })),
              ),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(Effect.provide(Stackit.ContainerApplications.GetApplicationHttp)),
) {}
