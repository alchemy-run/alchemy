import type * as cf from "@cloudflare/workers-types";
import { evaluateFlag } from "@alchemy.run/cloudflare-runtime/core/bindings/Flagship";
import { isLocalId } from "../LocalRuntime.ts";
import { makeLocalStore } from "./LocalStore.ts";
import * as Option from "effect/Option";
import * as Path from "node:path";
import { AlchemyContext } from "../../AlchemyContext.ts";
import { makeFlagshipClient } from "./ReadFlagsBinding.ts";
import type { FlagAttributes } from "./Flag.ts";
import type { ReadFlagsClient } from "./ReadFlags.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Credentials } from "../Credentials.ts";
import type { App } from "./App.ts";
import { ReadFlags } from "./ReadFlags.ts";
import {
  type FlagshipAuth,
  makeHttpFlagshipClient,
} from "./ReadFlagsHttpClient.ts";

/**
 * Local implementation of the {@link ReadFlags} binding — evaluates Flagship
 * feature flags from persisted local definitions for a local App, or over the Cloudflare HTTP API (`GET .../flagship/apps/{appId}/evaluate`)
 * using the **current credentials** instead of a native Worker binding
 * ({@link ReadFlagsBinding}).
 *
 * Provide it on an {@link Action} (or any deploy-time Effect) so you can read
 * flag values with the same `getBooleanValue`/`getStringValue`/… client you'd
 * use inside a Worker:
 *
 * @example Reading a flag from an Action
 * ```typescript
 * const CheckFlag = Alchemy.Action(
 *   "CheckFlag",
 *   Effect.gen(function* () {
 *     const flags = yield* Cloudflare.Flagship.ReadFlags(app);
 *     return Effect.fn(function* () {
 *       return yield* flags.getBooleanValue("new-checkout", false);
 *     });
 *   }).pipe(Effect.provide(Cloudflare.Flagship.ReadFlagsLocal)),
 * );
 * ```
 *
 * The app id is resolved at apply time through the ambient {@link RuntimeContext}
 * (in an Action, that's the resolve context the engine provides around the
 * body), so `ReadFlags(app)` works even though the app is created in the same
 * deploy.
 *
 * Local apps support the full flat targeting context and raw binding methods,
 * using the same offline evaluator as local Workers. Live apps use HTTP:
 * the HTTP evaluate endpoint only accepts a
 * single `targetingKey` (read from `context.targetingKey`), so attribute-based
 * targeting rules that key off other context fields cannot be exercised locally.
 * The `raw` runtime binding has no HTTP equivalent and dies if used — see
 * {@link makeHttpFlagshipClient}.
 */
export const ReadFlagsLocal = Layer.effect(
  ReadFlags,
  Effect.gen(function* () {
    // Account + credentials are ambient during stack-eval (the stack's
    // providers layer). Capture the full context so the evaluate op can run
    // with the current credentials — no `host.bind`, no minted token.
    const { accountId } = yield* yield* CloudflareEnvironment;
    const context = yield* Effect.context<
      Credentials | HttpClient.HttpClient
    >();
    const auth: FlagshipAuth = {
      authorize: (eff) => eff.pipe(Effect.provideContext(context)),
      accountId,
    };

    const alchemy = yield* Effect.serviceOption(AlchemyContext);
    const store = Option.isSome(alchemy)
      ? makeLocalStore(Path.join(alchemy.value.dotAlchemy, "local"))
      : undefined;
    return Effect.fn(function* (app: App) {
      // Deferred accessor — resolves the appId against the tracker at apply
      // time (in an Action, that's the engine's resolve context).
      const appId = yield* app.appId;
      const client = appId.pipe(
        Effect.map((id) => {
          if (!isLocalId(id))
            return makeHttpFlagshipClient(auth, Effect.succeed(id));
          if (!store)
            throw new Error(
              "Offline Flagship requires the local stack storage context",
            );
          const details = async (
            key: string,
            fallback: unknown,
            type?: string,
            context?: cf.FlagshipEvaluationContext,
          ) =>
            evaluateFlag(
              await Effect.runPromise(store.read<FlagAttributes>(id, key)),
              key,
              fallback,
              type,
              context,
            );
          const raw = {
            get: async (
              key: string,
              fallback?: unknown,
              context?: cf.FlagshipEvaluationContext,
            ) => (await details(key, fallback, undefined, context)).value,
            ...Object.fromEntries(
              ["Boolean", "String", "Number", "Object"].flatMap((type) => [
                [
                  `get${type}Value`,
                  async (
                    key: string,
                    fallback: unknown,
                    context?: cf.FlagshipEvaluationContext,
                  ) =>
                    (await details(key, fallback, type.toLowerCase(), context))
                      .value,
                ],
                [
                  `get${type}Details`,
                  (
                    key: string,
                    fallback: unknown,
                    context?: cf.FlagshipEvaluationContext,
                  ) => details(key, fallback, type.toLowerCase(), context),
                ],
              ]),
            ),
          } as cf.Flagship;
          return makeFlagshipClient(Effect.succeed(raw));
        }),
      );
      // App IDs resolve during the Action body, after local/remote provisioning.
      const methods = [
        "get",
        ...["Boolean", "String", "Number", "Object"].flatMap((type) => [
          `get${type}Value`,
          `get${type}Details`,
        ]),
      ];
      return {
        raw: client.pipe(Effect.flatMap((binding) => binding.raw)),
        ...Object.fromEntries(
          methods.map((method) => [
            method,
            (...args: unknown[]) =>
              client.pipe(
                Effect.flatMap((binding) =>
                  (
                    binding as unknown as Record<
                      string,
                      (...args: unknown[]) => Effect.Effect<unknown>
                    >
                  )[method]!(...args),
                ),
              ),
          ]),
        ),
      } as ReadFlagsClient;
    });
  }),
);
