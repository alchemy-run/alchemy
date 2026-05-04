import {
  BearerTokenValidator,
  StateApi,
  StateAuthLive,
} from "../../State/HttpStateApi.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiError from "effect/unstable/httpapi/HttpApiError";
import crypto from "node:crypto";
import * as Secret from "../SecretsStore/Secret.ts";
import { SecretBindingLive } from "../SecretsStore/SecretBinding.ts";
import { Worker } from "../Workers/Worker.ts";
import Store from "./Store.ts";
import { AuthToken } from "./Token.ts";

export const STATE_STORE_SCRIPT_NAME = "alchemy-state-store" as const;

/**
 * Version of the deployed Cloudflare State Store worker contract.
 *
 * Bump this whenever the wire format or runtime behaviour of the
 * worker changes in a way that an older deployed copy can no longer
 * satisfy. Clients query `/version` on the deployed worker and
 * compare against this constant; a mismatch (or 404) triggers a
 * forced redeploy via the bootstrap flow.
 */
export const STATE_STORE_VERSION = 1 as const;

/**
 * Path on disk to *this* file, used as the worker's bundling entry.
 *
 * When running from source (e.g. dev / monorepo), `import.meta.url` points
 * at `Api.ts` and we can use it directly. When the alchemy CLI is run from
 * its published `bin/alchemy.js` bundle, this module is inlined into the
 * CLI bundle and `import.meta.url` resolves to `bin/alchemy.js` — which
 * has no `default` export and breaks the worker bundler with
 * `[MISSING_EXPORT] "default" is not exported by "bin/alchemy.js"`.
 *
 * In the bundled case, fall back to the published source file shipped
 * alongside the CLI under `../src/Cloudflare/StateStore/Api.ts`.
 */
export default Worker(
  "Api",
  {
    name: STATE_STORE_SCRIPT_NAME,
    main: import.meta.filename,
    url: true,
    compatibility: {
      flags: ["nodejs_compat"],
      date: "2026-03-17",
    },
  },
  Effect.gen(function* () {
    const secret = yield* Secret.Secret.bind(AuthToken);
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

    const versionApi = HttpApiBuilder.group(StateApi, "version", (handlers) =>
      handlers.handle("getVersion", () =>
        Effect.succeed({ version: STATE_STORE_VERSION }),
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
        Layer.provide(versionApi),
        Layer.provide(StateAuthLive),
        Layer.provide(bearerTokenValidator),
        // The state-store worker never serves files, so HttpPlatform's
        // file-response surface is stubbed.
        Layer.provide([Etag.layer, HttpPlatformStub, Path.layer]),
        HttpRouter.toHttpEffect,
      ),
    };
  }).pipe(Effect.provide(Layer.mergeAll(SecretBindingLive))),
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
