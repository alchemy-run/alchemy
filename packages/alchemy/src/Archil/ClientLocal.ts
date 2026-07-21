import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { Client, type ClientOptions } from "./Client.ts";
import { Credentials } from "./Credentials.ts";
import { makeArchilClient, type ArchilAuth } from "./RuntimeAuth.ts";

/**
 * Current-credentials implementation of the {@link Client} binding.
 *
 * Runs every call with the ambient deploy-time API key (profile /
 * `ARCHIL_API_KEY`) instead of minting a token — for scripts, Actions, and
 * tests. Registers no binding on any host. The client's default region is
 * the credentials' default region unless overridden per client.
 */
export const ClientLocal = Layer.effect(
  Client,
  Effect.gen(function* () {
    // Credentials + HTTP client are ambient during stack-eval (the stack's
    // providers layer). Capture the full context so each op runs with the
    // current credentials.
    const { defaultRegion } = yield* yield* Credentials;
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();
    const auth: ArchilAuth = {
      authorize: (eff) => eff.pipe(Effect.provideContext(context)),
    };
    return Effect.fn(function* (options?: ClientOptions) {
      return makeArchilClient(
        auth,
        Effect.succeed(options?.region ?? defaultRegion),
      );
    });
  }),
);
