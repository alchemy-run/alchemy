import * as Azure from "@alchemy.run/azure";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
// TEMPORARY: this checkout's distilled `lib/` is stale (see distilled-source.ts).
import { distilledFromSource } from "../../Functions/fixtures/distilled-source.ts";

// Resources the Schema Registry binding fixture consumes. Module-scope so the
// test yields the same declarations. The registry needs a Standard namespace,
// and Standard allows one schema group.
export const Registry = Azure.EventHub.Namespace("SrBindingsEvents", { sku: "Standard" });

export const Schemas = Effect.gen(function* () {
  const namespace = yield* Registry;
  return yield* Azure.EventHub.SchemaGroup("SrBindingsSchemas", {
    namespace: namespace.namespaceName,
    schemaType: "Avro",
  });
});

/** The Avro record schema the test registers as version `v` of `name`. */
export const avroSchema = (name: string, v: number) =>
  JSON.stringify({
    type: "record",
    name,
    namespace: "alchemy.test",
    fields: [{ name: `field${v}`, type: "string" }],
  });

const AVRO = "application/json; serialization=Avro";

/** Answer `{ ok, result }`, or `{ ok: false, error }` with a 500 so callers retry. */
const respond = (effect: Effect.Effect<unknown, unknown, RuntimeContext>) =>
  effect.pipe(
    Effect.flatMap((result) => HttpServerResponse.json({ ok: true, result })),
    Effect.catchCause((cause) =>
      HttpServerResponse.json({ ok: false, error: Cause.pretty(cause) }, { status: 500 }),
    ),
  );

const text = (body: Uint8Array) => new TextDecoder().decode(body);

/**
 * Effect Function with one route per Schema Registry binding. Routes take
 * `name` (schema name), `v` (the content version of {@link avroSchema}),
 * `id` and `version`, and answer `{ ok, result | error }` with a 500 on
 * error, so a caller retries through role propagation and a real failure
 * shows the registry error.
 */
export default class SchemaRegistryFunction extends Azure.Functions.Function<SchemaRegistryFunction>()(
  "SrBindingsFunction",
  {
    main: import.meta.url,
    build: { input: { plugins: [distilledFromSource] } },
  },
  Effect.gen(function* () {
    const namespace = yield* Registry;
    const schemas = yield* Schemas;
    const registerSchema = yield* Azure.EventHub.RegisterSchema(schemas);
    const getSchemaById = yield* Azure.EventHub.GetSchemaById(schemas);
    const getSchemaByVersion = yield* Azure.EventHub.GetSchemaByVersion(schemas);
    const getSchemaProperties = yield* Azure.EventHub.GetSchemaPropertiesByContent(schemas);
    const listSchemaVersions = yield* Azure.EventHub.ListSchemaVersions(schemas);
    const listSchemaGroups = yield* Azure.EventHub.ListSchemaGroups(namespace);
    const read = yield* Azure.EventHub.SchemaGroupRead(schemas);
    const write = yield* Azure.EventHub.SchemaGroupWrite(schemas);
    const readWrite = yield* Azure.EventHub.SchemaGroupReadWrite(schemas);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const url = new URL(request.url, "http://localhost");
        const name = url.searchParams.get("name") ?? "";
        const v = Number(url.searchParams.get("v") ?? "1");
        const id = url.searchParams.get("id") ?? "";
        const version = Number(url.searchParams.get("version") ?? "1");
        const content = avroSchema(name, v);
        switch (url.pathname) {
          case "/register":
            return yield* respond(
              Effect.map(
                registerSchema({ schemaName: name, contentType: AVRO, body: content }),
                (res) => ({ id: res.schemaId, version: res.schemaVersion }),
              ),
            );
          case "/get-by-id":
            return yield* respond(
              Effect.map(getSchemaById({ id }), (res) => ({
                content: text(res.body),
                contentType: res.contentType,
                schemaName: res.schemaName,
                version: res.schemaVersion,
              })),
            );
          case "/get-by-version":
            return yield* respond(
              Effect.map(
                getSchemaByVersion({ schemaName: name, schemaVersion: version }),
                (res) => ({
                  content: text(res.body),
                  id: res.schemaId,
                  version: res.schemaVersion,
                }),
              ),
            );
          case "/get-properties":
            return yield* respond(
              Effect.map(
                getSchemaProperties({ schemaName: name, contentType: AVRO, body: content }),
                (res) => ({ id: res.schemaId, version: res.schemaVersion }),
              ),
            );
          case "/list-versions":
            return yield* respond(
              Effect.map(listSchemaVersions({ schemaName: name }), (page) => ({
                versions: page.Value,
              })),
            );
          case "/list-groups":
            return yield* respond(
              Effect.map(listSchemaGroups(), (page) => ({ groups: page.Value })),
            );
          case "/read":
            return yield* respond(
              Effect.gen(function* () {
                const versions = yield* read.listSchemaVersions(name);
                const latest = yield* read.getSchemaVersion(name, versions.at(-1) ?? 0);
                const byId = yield* read.getSchema(latest.id);
                const properties = yield* read.getSchemaProperties(name, avroSchema(name, 1));
                return { versions, latest, byId, properties };
              }),
            );
          case "/write":
            return yield* respond(write.registerSchema(name, content));
          case "/read-write":
            return yield* respond(
              Effect.gen(function* () {
                const registered = yield* readWrite.registerSchema(name, content);
                const schema = yield* readWrite.getSchema(registered.id);
                const versions = yield* readWrite.listSchemaVersions(name);
                return { registered, schema, versions };
              }),
            );
          default:
            return HttpServerResponse.text("not found", { status: 404 });
        }
      }),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Azure.EventHub.RegisterSchemaHttp,
        Azure.EventHub.GetSchemaByIdHttp,
        Azure.EventHub.GetSchemaByVersionHttp,
        Azure.EventHub.GetSchemaPropertiesByContentHttp,
        Azure.EventHub.ListSchemaVersionsHttp,
        Azure.EventHub.ListSchemaGroupsHttp,
        Azure.EventHub.SchemaGroupReadHttp,
        Azure.EventHub.SchemaGroupWriteHttp,
        Azure.EventHub.SchemaGroupReadWriteHttp,
      ),
    ),
  ),
) {}
