import * as Cloudflare from "alchemy/Cloudflare";
import {
  BearerTokenValidator,
  StateApi,
  StateAuthLive,
} from "alchemy/State/HttpStateApi";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";
import crypto from "node:crypto";
import Store from "./Store.ts";
import { AuthToken } from "./Token.ts";

export const STATE_STORE_SCRIPT_NAME = "alchemy-state-store" as const;

export default Cloudflare.Worker(
  "Api",
  {
    name: STATE_STORE_SCRIPT_NAME,
    main: import.meta.path,
    url: true,
    compatibility: {
      flags: ["nodejs_compat"],
      date: "2026-03-17",
    },
  },
  Effect.gen(function* () {
    const secret = yield* Cloudflare.Secret.bind(AuthToken);
    const store = yield* Store;

    const bearerTokenValidator = Layer.effect(
      BearerTokenValidator,
      secret.get().pipe(
        Effect.map((expected) =>
          BearerTokenValidator.of({
            validate: (token) =>
              !!expected && timingSafeEqual(token, expected)
                ? Effect.void
                : Effect.fail(new HttpApiError.Unauthorized()),
          }),
        ),
        Effect.orDie,
      ),
    );

    const stateApi = HttpApiBuilder.group(StateApi, "state", (handlers) =>
      handlers
        .handle("listStacks", () =>
          store.getByName(Store.ROOT_DO_NAME).listStacks(),
        )
        .handle("listStages", ({ params }) =>
          store.getByName(params.stack).listStages(),
        )
        .handle("listResources", ({ params }) =>
          store.getByName(params.stack).listResources({ stage: params.stage }),
        )
        .handle("getState", ({ params }) =>
          store
            .getByName(params.stack)
            .get({ stage: params.stage, fqn: decodeURIComponent(params.fqn) }),
        )
        .handle("setState", ({ params, payload }) =>
          store
            .getByName(params.stack)
            .set({
              stage: params.stage,
              fqn: decodeURIComponent(params.fqn),
              value: payload as any,
            })
            .pipe(
              Effect.tap(() =>
                store
                  .getByName(Store.ROOT_DO_NAME)
                  .registerStack({ stack: params.stack }),
              ),
            ),
        )
        .handle("deleteState", ({ params }) =>
          // The DO method is `remove`, not `delete` — `delete` is
          // reserved by Cloudflare's RPC stub proxy.
          store
            .getByName(params.stack)
            .remove({
              stage: params.stage,
              fqn: decodeURIComponent(params.fqn),
            })
            .pipe(Effect.asVoid),
        )
        .handle("getReplacedResources", ({ params }) =>
          store
            .getByName(params.stack)
            .getReplacedResources({ stage: params.stage }),
        )
        .handle("deleteStack", ({ params, query }) =>
          store
            .getByName(params.stack)
            .deleteStack(
              query.stage === undefined ? {} : { stage: query.stage },
            )
            .pipe(
              Effect.flatMap(() =>
                query.stage === undefined
                  ? store
                      .getByName(Store.ROOT_DO_NAME)
                      .unregisterStack({ stack: params.stack })
                  : Effect.void,
              ),
              Effect.asVoid,
            ),
        ),
    );

    return {
      fetch: HttpApiBuilder.layer(StateApi).pipe(
        Layer.provide(stateApi),
        Layer.provide(StateAuthLive),
        Layer.provide(bearerTokenValidator),
        // The state-store worker never serves files, so HttpPlatform's
        // file-response surface is stubbed.
        Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
        HttpRouter.toHttpEffect,
      ),
    };
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.SecretBindingLive))),
);

/**
 * Stub `HttpPlatform` for the worker. The state-store API never
 * issues file responses, so both surface methods die if invoked. Lets
 * us avoid pulling in a `FileSystem` dependency that workers don't
 * have.
 */
const HttpPlatformStub = Layer.succeed(HttpPlatform.HttpPlatform, {
  fileResponse: () => Effect.die("HttpPlatform.fileResponse not supported"),
  fileWebResponse: () =>
    Effect.die("HttpPlatform.fileWebResponse not supported"),
});

/**
 * Timing-safe string comparison using the Workers runtime's built-in
 * `crypto.subtle.timingSafeEqual`.
 *
 * @see https://developers.cloudflare.com/workers/examples/protect-against-timing-attacks/
 */
const timingSafeEqual = (a: string, b: string): boolean => {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  if (aBytes.byteLength !== bBytes.byteLength) return false;
  // @ts-expect-error - TODO(sam)
  return crypto.subtle.timingSafeEqual(aBytes, bBytes);
};
