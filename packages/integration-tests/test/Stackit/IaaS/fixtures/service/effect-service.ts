import * as Stackit from "@alchemy.run/stackit";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Box, EFFECT_PORT, SECRET_VALUE } from "./stack.ts";

/**
 * The effectful form. Its binding proves the native path: `/list-commands` only
 * answers if the program signs with a token from the server's metadata API, for the
 * account attached to the server, which holds the binding's grant. `/hello` reports
 * that no key was bound.
 */
export default class EffectService extends Stackit.IaaS.Service<EffectService>()(
  "StackitServiceEffect",
  Effect.gen(function* () {
    const { server, address } = yield* Box;
    return {
      server,
      main: import.meta.url,
      port: EFFECT_PORT,
      publicIp: address.ip,
      env: { GREETING: "hello from effect", SECRET: SECRET_VALUE },
    };
  }),
  Effect.gen(function* () {
    const { server } = yield* Box;
    const listCommands = yield* Stackit.RunCommand.ListCommands(server);

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
        const url = new URL(request.url, "http://service");
        switch (url.pathname) {
          case "/hello":
            return yield* respond(
              Effect.sync(() => ({
                form: "effect",
                greeting: process.env.GREETING,
                secret: process.env.SECRET,
                hasKey: process.env.ALCHEMY_STACKIT_SERVICE_ACCOUNT_KEY !== undefined,
                account: process.env.ALCHEMY_STACKIT_ATTACHED_SERVICE_ACCOUNT,
              })),
            );
          case "/list-commands":
            return yield* respond(listCommands());
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(Effect.provide(Stackit.RunCommand.ListCommandsHttp)),
) {}
