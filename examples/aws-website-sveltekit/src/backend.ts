// The effectful site module: default-exports the Website class, anchored
// by `main: import.meta.url`. The engine imports it at plan time (binding
// collection — bucket-name env var + IAM onto the server Lambda) and the
// deployed Lambda re-imports it inside the SvelteKit server bundle to
// serve the backend's RPC methods.
//
// Narrow subpath imports only (`alchemy/AWS/S3`, not `alchemy/AWS`): this
// module is bundled into the framework server build and evaluated by the
// Vite dev server — the provider barrel would drag the whole IaC engine
// along with it.
import * as S3 from "alchemy/AWS/S3";
import { SvelteKit } from "alchemy/AWS/Website";
import { remote } from "alchemy/ProviderMode";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

/**
 * S3 bucket bound by the site's program. `remote()` keeps the bucket REAL
 * even under `alchemy dev` — the dev server's capability clients hit AWS
 * directly with your ambient credentials.
 */
export const SiteData = S3.Bucket("SiteData", {
  forceDestroy: true,
}).pipe(remote());

/**
 * One Lambda serves the SvelteKit app AND the Effect program's backend.
 * The program's RPC METHODS are the API surface: each method is callable
 * through `createClient` (`alchemy/client`) — in-process from
 * `+page.server.ts` (the value form) and over the wire from the browser
 * (`POST /api/__rpc/<method>`, the type-only form) — in the deployed
 * Lambda and in `vite dev` alike.
 */
export default class Site extends SvelteKit<Site>()(
  "SvelteKitSite",
  {
    main: import.meta.url,
    forceDestroy: true,
  },
  Effect.gen(function* () {
    const bucket = yield* SiteData;
    const putObject = yield* S3.PutObject(bucket);
    const getObject = yield* S3.GetObject(bucket);
    return {
      /** Read the saved message from the S3 bucket (null when unset). */
      get: () =>
        Effect.gen(function* () {
          const object = yield* getObject({ Key: "message" }).pipe(
            Effect.catchTag("NoSuchKey", () => Effect.succeed(undefined)),
            Effect.orDie,
          );
          return object?.Body === undefined
            ? null
            : yield* Stream.mkString(Stream.decodeText(object.Body)).pipe(
                Effect.orDie,
              );
        }),
      /** Save a message to the S3 bucket and return it. */
      save: (value: string) =>
        Effect.gen(function* () {
          yield* putObject({ Key: "message", Body: value }).pipe(Effect.orDie);
          return value;
        }),
    };
  }).pipe(Effect.provide([S3.PutObjectHttp, S3.GetObjectHttp])),
) {}
