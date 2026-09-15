import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import { findZoneByName } from "@/Cloudflare/Zone/lookup";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as apiGateway from "@distilled.cloud/cloudflare/api-gateway";
import { UserSchemaProvider } from "@/Cloudflare/ApiShield/UserSchema";
import { noopSession } from "@/Report";
import { Stack } from "@/Stack";
import { Stage } from "@/Stage";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Credentials,
  apiTokenCredentials,
} from "@distilled.cloud/cloudflare/Credentials";
import { expect, it } from "alchemy-test";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { MinimumLogLevel } from "effect/References";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

it.live(
  "migration: user schema multipart booleans and PATCH retain their wire types",
  () =>
    Effect.gen(function* () {
      const source = yield* fixture("openapi-v1.json");
      for (const enabled of [false, true]) {
        const writes: string[] = [];
        let validationEnabled = enabled;
        const client = HttpClient.make((request) =>
          Effect.gen(function* () {
            if (request.method === "POST") {
              expect(request.body._tag).toBe("FormData");
              if (request.body._tag !== "FormData")
                return yield* Effect.die("Expected multipart form data");
              const form = request.body.formData;
              expect(form.getAll("validation_enabled")).toEqual([
                String(enabled),
              ]);
              expect(form.has("validationEnabled")).toBe(false);
              expect(form.has("validation_enabled2")).toBe(false);
              const file = form.get("file");
              expect(file).toBeInstanceOf(File);
              if (!(file instanceof File))
                return yield* Effect.die("Expected uploaded file");
              const uploaded = yield* Effect.sync(() =>
                HttpClientResponse.fromWeb(request, new Response(file)),
              );
              expect(yield* uploaded.text).toBe(source);
              writes.push("POST");
            } else if (request.method === "PATCH") {
              expect(request.body._tag).toBe("Uint8Array");
              if (request.body._tag !== "Uint8Array")
                return yield* Effect.die("Expected JSON body");
              const bytes = request.body.body;
              const body = yield* Effect.sync(() =>
                JSON.parse(new TextDecoder().decode(bytes)),
              );
              expect(body).toEqual({ validation_enabled: true });
              validationEnabled = true;
              writes.push("PATCH");
            }
            return yield* Effect.sync(() => {
              const schema = {
                schema_id: "schema-id",
                name: "migration-schema",
                kind: "openapi_v3",
                source,
                validation_enabled: validationEnabled,
                created_at: "2026-01-01T00:00:00Z",
              };
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  success: true,
                  errors: [],
                  messages: [],
                  result: request.method === "POST" ? { schema } : schema,
                }),
              );
            });
          }),
        );
        yield* Effect.gen(function* () {
          const provider = yield* Provider.findProvider(
            Cloudflare.ApiShield.UserSchema,
          );
          const context = {
            id: "Schema",
            fqn: "Schema",
            instanceId: "migration",
            session: { ...noopSession, note: () => Effect.void },
            bindings: [],
          };
          const news = {
            zoneId: "zone-id",
            name: "migration-schema",
            schema: source,
            validationEnabled: enabled,
          };
          const created = yield* provider.reconcile({
            ...context,
            news,
            olds: undefined,
            output: undefined,
          });
          expect(created.validationEnabled).toBe(enabled);
          const updated = yield* provider.reconcile({
            ...context,
            news: { ...news, validationEnabled: true },
            olds: undefined,
            output: created,
          });
          expect(updated.schemaId).toBe(created.schemaId);
          expect(updated.validationEnabled).toBe(true);
          expect(writes).toEqual(enabled ? ["POST"] : ["POST", "PATCH"]);
        }).pipe(
          Effect.provide(UserSchemaProvider()),
          Effect.provideService(Stack, {
            name: "migration-userschema",
            stage: "test",
            resources: {},
            bindings: {},
            actions: {},
          }),
          Effect.provideService(Stage, "test"),
          Effect.provideService(
            CloudflareEnvironment,
            Effect.succeed({
              type: "apiToken",
              apiToken: Redacted.make("test-token"),
              accountId: "account-id",
              source: { type: "env" },
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.provideService(
            Credentials,
            Effect.succeed(apiTokenCredentials({ apiToken: "test-token" })),
          ),
        );
      }
    }).pipe(Effect.provide(NodeServices.layer)),
);

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const zoneName =
  process.env.CLOUDFLARE_TEST_DNS_ZONE_NAME ?? "alchemy-test-2.us";

// Deterministic per-test schema names.
const NAME_DEFAULT = "alch-userschema-default";
const NAME_REPLACE = "alch-userschema-replace";
const NAME_LIST = "alch-userschema-list";

const resolveZoneId = Effect.gen(function* () {
  const { accountId } = yield* yield* CloudflareEnvironment;
  const zone = yield* findZoneByName({ accountId, name: zoneName });
  if (!zone) {
    return yield* Effect.die(
      new Error(`zone "${zoneName}" not found in account`),
    );
  }
  return zone.id;
});

const fixture = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(
      path.join(import.meta.dirname, "fixtures", file),
    );
  });

// The scoped API token the test harness mints propagates eventually-
// consistently — a fresh token intermittently 403s. Ride out the blips on
// the test's own out-of-band calls by retrying the typed `Forbidden` error.
const forbiddenRetrySchedule = Schedule.spaced("1 second");

// Read a schema out-of-band; `undefined` when gone.
const getSchema = (zoneId: string, schemaId: string) =>
  apiGateway.getUserSchema({ zoneId, schemaId }).pipe(
    Effect.map(
      (schema): apiGateway.GetUserSchemaResponse | undefined => schema,
    ),
    Effect.catchTag("SchemaNotFound", () => Effect.succeed(undefined)),
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: forbiddenRetrySchedule,
      times: 8,
    }),
  );

test.provider(
  "create, enable validation in place, destroy a user schema",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      const source = yield* fixture("openapi-v1.json");

      yield* stack.destroy();

      const schema = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ApiShield.UserSchema("DefaultSchema", {
            zoneId,
            name: NAME_DEFAULT,
            schema: source,
          });
        }),
      );

      expect(schema.zoneId).toEqual(zoneId);
      expect(schema.name).toEqual(NAME_DEFAULT);
      expect(schema.kind).toEqual("openapi_v3");
      expect(schema.source).toEqual(source);
      expect(schema.validationEnabled).toEqual(false);
      expect(schema.schemaId.length).toBeGreaterThan(0);

      const live = yield* getSchema(zoneId, schema.schemaId);
      expect(live?.name).toEqual(NAME_DEFAULT);
      expect(live?.source).toEqual(source);

      // Enable validation — same identity, patched in place.
      const enabled = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ApiShield.UserSchema("DefaultSchema", {
            zoneId,
            name: NAME_DEFAULT,
            schema: source,
            validationEnabled: true,
          });
        }),
      );
      expect(enabled.schemaId).toEqual(schema.schemaId);
      expect(enabled.validationEnabled).toEqual(true);

      const patched = yield* getSchema(zoneId, schema.schemaId);
      expect(patched?.validationEnabled).toEqual(true);

      yield* stack.destroy();

      const gone = yield* getSchema(zoneId, schema.schemaId);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "changing the schema source triggers replacement",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      const sourceV1 = yield* fixture("openapi-v1.json");
      const sourceV2 = yield* fixture("openapi-v2.json");

      yield* stack.destroy();

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ApiShield.UserSchema("ReplaceSchema", {
            zoneId,
            name: NAME_REPLACE,
            schema: sourceV1,
          });
        }),
      );
      expect(initial.source).toEqual(sourceV1);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ApiShield.UserSchema("ReplaceSchema", {
            zoneId,
            name: NAME_REPLACE,
            schema: sourceV2,
          });
        }),
      );

      // The source is immutable — a new physical schema exists.
      expect(replaced.schemaId).not.toEqual(initial.schemaId);
      expect(replaced.source).toEqual(sourceV2);

      // The old schema was deleted as part of the replacement.
      const oldSchema = yield* getSchema(zoneId, initial.schemaId);
      expect(oldSchema).toBeUndefined();

      const live = yield* getSchema(zoneId, replaced.schemaId);
      expect(live?.source).toEqual(sourceV2);

      yield* stack.destroy();

      const gone = yield* getSchema(zoneId, replaced.schemaId);
      expect(gone).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (zone-scoped collection): `list()` fans out over
// every zone via `listAllZones` and exhaustively paginates each zone's
// schemas. Deploy a schema, then assert its id appears in the result.
test.provider(
  "list enumerates the deployed user schema",
  (stack) =>
    Effect.gen(function* () {
      const zoneId = yield* resolveZoneId;
      const source = yield* fixture("openapi-v1.json");

      yield* stack.destroy();

      const schema = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Cloudflare.ApiShield.UserSchema("ListSchema", {
            zoneId,
            name: NAME_LIST,
            schema: source,
          });
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.ApiShield.UserSchema,
      );
      const all = yield* provider.list();

      const found = all.find((s) => s.schemaId === schema.schemaId);
      expect(found).toBeDefined();
      expect(found?.zoneId).toEqual(zoneId);
      expect(found?.name).toEqual(NAME_LIST);
      expect(found?.kind).toEqual("openapi_v3");
      expect(found?.source).toEqual(source);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
