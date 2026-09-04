import * as Cloudflare from "@/Cloudflare";
import type * as runtime from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Control, Preserved } from "./preserve-secret.ts";

/**
 * Echoes the runtime value of both fixture secrets so the test can observe
 * what the Secrets Store actually holds (the API never returns values).
 */
export default class PreserveSecretWorker extends Cloudflare.Worker<PreserveSecretWorker>()(
  "PreserveSecretWorker",
  {
    main: import.meta.url,
    workersDev: { enabled: true, previewsEnabled: false },
    env: {
      PRESERVED: Preserved,
      CONTROL: Control,
    },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const pathname = new URL(request.originalUrl, "http://x").pathname;
        const env = yield* Cloudflare.Workers.WorkerEnvironment;
        const secrets = env as Record<string, runtime.SecretsStoreSecret>;
        const binding =
          pathname === "/preserved"
            ? secrets.PRESERVED
            : pathname === "/control"
              ? secrets.CONTROL
              : undefined;
        if (binding === undefined) {
          return HttpServerResponse.text("Not Found", { status: 404 });
        }
        const value = yield* Effect.promise(() => binding.get());
        return yield* HttpServerResponse.json({ value });
      }),
    };
  }),
) {}
