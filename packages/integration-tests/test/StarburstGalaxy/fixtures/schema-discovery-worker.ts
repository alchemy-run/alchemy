import * as Cloudflare from "@alchemy.run/cloudflare";
import * as StarburstGalaxy from "@alchemy.run/starburst-galaxy";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import { UnreadableLake } from "./bindings.ts";

const { SchemaDiscovery } = StarburstGalaxy;

/** The typed error a call failed with, or its result. */
const outcome = <A, E extends { readonly _tag: string; readonly message?: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.map((value) => ({ ok: true as const, value })),
    Effect.catch((error: E) =>
      Effect.succeed({ ok: false as const, tag: error._tag, message: error.message ?? "" }),
    ),
  );

/** A Worker that drives every SchemaDiscovery binding against a lake Galaxy cannot read. */
export default class GalaxySchemaDiscoveryWorker extends Cloudflare.Worker<GalaxySchemaDiscoveryWorker>()(
  "GalaxySchemaDiscoveryWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const create = yield* SchemaDiscovery.CreateSchemaDiscovery(UnreadableLake);
    const get = yield* SchemaDiscovery.GetSchemaDiscovery(UnreadableLake);
    const apply = yield* SchemaDiscovery.ApplySchemaDiscovery(UnreadableLake);
    const list = yield* SchemaDiscovery.ListSchemaDiscoveries(UnreadableLake);
    const remove = yield* SchemaDiscovery.DeleteSchemaDiscovery(UnreadableLake);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://worker");
        if (url.pathname !== "/discover")
          return HttpServerResponse.text("not found", { status: 404 });

        const missing = { schemaDiscoveryId: "sd-1234567890" };
        const created = yield* outcome(
          create({ uri: "s3://noaa-ghcn-pds/csv/", skipApplying: true }),
        );
        const listed = yield* outcome(list());
        const got = yield* outcome(get(missing));
        const applied = yield* outcome(apply(missing));
        const deleted = yield* outcome(remove(missing));
        return yield* HttpServerResponse.json({
          created,
          listed: listed.ok ? { ok: true, count: listed.value.length } : listed,
          got: got.ok ? { ok: true } : got,
          applied: applied.ok ? { ok: true } : applied,
          deleted: deleted.ok ? { ok: true } : deleted,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(HttpServerResponse.text(Cause.pretty(cause), { status: 500 })),
        ),
      ),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        SchemaDiscovery.CreateSchemaDiscoveryHttp,
        SchemaDiscovery.GetSchemaDiscoveryHttp,
        SchemaDiscovery.ApplySchemaDiscoveryHttp,
        SchemaDiscovery.ListSchemaDiscoveriesHttp,
        SchemaDiscovery.DeleteSchemaDiscoveryHttp,
      ),
    ),
  ),
) {}
