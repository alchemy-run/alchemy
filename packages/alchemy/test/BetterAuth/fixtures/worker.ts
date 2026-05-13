import * as Cloudflare from "@/Cloudflare/index.ts";
import * as BetterAuth from "@alchemy.run/better-auth";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Hyperdrive } from "./database.ts";
import * as schema from "./schema.ts";

export default class BetterAuthPgWorker extends Cloudflare.Worker<BetterAuthPgWorker>()(
  "BetterAuthPgWorker",
  {
    main: import.meta.filename,
    subdomain: { enabled: true, previewsEnabled: false },
    compatibility: { date: "2024-09-23", flags: ["nodejs_compat"] },
  },
  Effect.gen(function* () {
    const auth = yield* BetterAuth.BetterAuth;
    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        if (request.url.startsWith("/api/auth/")) return yield* auth.fetch;
        return HttpServerResponse.text("ok");
      }),
    };
  }).pipe(
    Effect.provide(
      BetterAuth.postgresDrizzle({
        db: Hyperdrive,
        schema,
        emailAndPassword: { enabled: true },
      }),
    ),
  ),
) {}
