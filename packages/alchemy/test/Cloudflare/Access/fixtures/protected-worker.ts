import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

/** Unique body used as the T1/T2/T3 success oracle — never a bare 200. */
export const fixtureBody = "alchemy-access-protected-worker-body";

export default class ProtectedWorker extends Cloudflare.Worker<ProtectedWorker>()(
  "ProtectedWorker",
  {
    main: import.meta.url,
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/whoami")) {
          const ctx = yield* Cloudflare.WorkerExecutionContext;
          const aud = yield* ctx.access.aud;
          const identity = yield* ctx.access.identity.pipe(
            Effect.catchTag("AccessIdentityError", () =>
              Effect.succeed(undefined),
            ),
          );
          // Service Auth has an aud but no user identity. Bypass / no
          // Access leaves both undefined.
          if (aud === undefined && identity === undefined) {
            return HttpServerResponse.text("anonymous");
          }
          return yield* HttpServerResponse.json({
            aud: aud ?? null,
            email: identity?.email ?? null,
            name: identity?.name ?? null,
            userUuid: identity?.user_uuid ?? null,
            accountId: identity?.account_id ?? null,
          });
        }
        return HttpServerResponse.text(fixtureBody);
      }),
    };
  }),
) {}
