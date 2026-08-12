import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { Users } from "./users-namespace.ts";

/**
 * The canonical effectful Website shape (curried-class form): a Vite SPA
 * whose Effect program binds a KV namespace through the native-binding
 * capability. Plan-level tests assert the collect-only stamping, the
 * `server.routes` → `runWorkerFirst` compilation, and the collected
 * binding rows — the site is never built or deployed.
 */
export default class ViteSite extends Cloudflare.Website.Vite<ViteSite>()(
  "ViteSite",
  {
    main: import.meta.url,
    rootDir: import.meta.dirname,
    assets: { notFoundHandling: "single-page-application" },
  },
  Effect.gen(function* () {
    const namespace = yield* Users;
    const users = yield* Cloudflare.KV.ReadWriteNamespace(namespace);
    return {
      fetch: Effect.gen(function* () {
        const value = yield* users.get("current").pipe(Effect.orDie);
        return HttpServerResponse.text(value ?? "none");
      }),
    };
  }).pipe(Effect.provide(Cloudflare.KV.ReadWriteNamespaceBinding)),
) {}
