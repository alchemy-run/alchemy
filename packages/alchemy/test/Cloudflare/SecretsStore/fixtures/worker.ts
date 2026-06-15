import * as Cloudflare from "@/Cloudflare";
import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { ApiKey } from "./secret.ts";

/**
 * Worker that receives a `Cloudflare.SecretsStore.Secret` through its
 * `env` (an async binding) rather than via `Cloudflare.Secret.bind`. The
 * Worker provider must map it to a `secrets_store_secret` binding so the
 * runtime sees a real `SecretsStoreSecret` (with `.get()`), not a JSON
 * blob. The `/secret` route reads it back and echoes the value.
 */
export default class AsyncSecretWorker extends Cloudflare.Worker<AsyncSecretWorker>()(
  "AsyncSecretBindingWorker",
  {
    main: import.meta.filename,
    subdomain: { enabled: true, previewsEnabled: false },
    env: {
      MY_SECRET: ApiKey,
    },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl).pathname;
        if (pathname === "/secret") {
          const env = yield* Cloudflare.WorkerEnvironment;
          const secret = (env as Record<string, runtime.SecretsStoreSecret>)
            .MY_SECRET;
          const value = yield* Effect.promise(() => secret.get());
          return yield* HttpServerResponse.json({ value });
        }
        return HttpServerResponse.text("ok");
      }),
    };
  }),
) {}
