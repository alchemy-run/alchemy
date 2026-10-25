import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as eventhub from "@distilled.cloud/azure/eventhub";
import * as registry from "@distilled.cloud/azure/schemaregistry-data";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import SchemaRegistryFunction, {
  avroSchema,
  Registry,
  Schemas,
} from "./fixtures/schema-registry-function.ts";
import { waitGone } from "./util.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Object ID (`oid` claim) of the identity running the tests. */
const deployerObjectId = Effect.gen(function* () {
  const config = yield* yield* Credentials;
  const token = Redacted.value(config.bearerToken);
  return yield* Effect.sync(
    () =>
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
        .oid as string,
  );
});

const Stack = Alchemy.Stack(
  "AzureSchemaRegistryBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* SchemaRegistryFunction;
    const namespace = yield* Registry;
    const schemas = yield* Schemas;
    // The deployer registers and reads schemas out of band.
    const deployer = yield* deployerObjectId.pipe(Effect.orDie);
    yield* Azure.Authorization.RoleAssignment("SrDeployerContributor", {
      scope: schemas.schemaGroupId,
      roleDefinitionId: Azure.Authorization.BuiltInRole.SchemaRegistryContributor,
      principalId: deployer,
      principalType: "ServicePrincipal",
    });
    return {
      url: fn.url,
      principalId: fn.principalId,
      resourceGroup: namespace.resourceGroup,
      namespaceName: namespace.namespaceName,
      namespaceId: namespace.namespaceId,
      groupName: schemas.schemaGroupName,
      groupId: schemas.schemaGroupId,
    };
  }),
);

// Standard Event Hubs namespace (~$0.03/hour) + a Flex Consumption app;
// ~4 min deploy, ~2 min destroy: well under $0.05 per run.
const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

/** Azure credentials and environment for out-of-band calls. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation, then return the last answer so a real
 * failure shows its registry error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.get(`${url}${route}`).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((body) => body as Body),
      Effect.flatMap((body) => (body?.ok ? Effect.succeed(body) : Effect.fail(body))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 60 }),
      Effect.catch((body) => Effect.succeed(body as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** The deployer's role can trail the deploy by a few minutes. */
const whileDenied = {
  while: (e: { readonly _tag: string }) => e._tag === "SchemaRegistryAccessDenied",
  schedule: Schedule.spaced("10 seconds"),
  times: 30,
} as const;

const AVRO = "application/json; serialization=Avro";
/** The registry answers the media type without the space. */
const AVRO_STORED = "application/json;serialization=Avro";

const where = Effect.map(stack, ({ namespaceName, groupName }) => ({
  fullyQualifiedNamespace: `${namespaceName}.servicebus.windows.net`,
  groupName,
}));

/** Register version `v` of `name` out of band; returns its ID and version. */
const seed = (name: string, v: number) =>
  Effect.gen(function* () {
    const at = yield* where;
    const res = yield* registry
      .RegisterSchema({ ...at, schemaName: name, contentType: AVRO, body: avroSchema(name, v) })
      .pipe(Effect.retry(whileDenied));
    return { id: res.schemaId ?? "", version: res.schemaVersion ?? 0 };
  });

/** One version of `name` out of band. */
const versionOf = (name: string, version: number) =>
  Effect.gen(function* () {
    const at = yield* where;
    const res = yield* registry
      .GetSchemaByVersion({ ...at, schemaName: name, schemaVersion: version })
      .pipe(Effect.retry(whileDenied));
    return {
      id: res.schemaId,
      version: res.schemaVersion,
      content: new TextDecoder().decode(res.body),
    };
  });

const live = { timeout: 600_000 };

describe(
  "Schema Registry bindings on an Azure Function",
  { tags: ["provider:azure", "provider:azure:eventhub", "live"] },
  () => {
    describe("EventHub.RegisterSchema", () => {
      test(
        "registers a schema version",
        Effect.gen(function* () {
          const body = yield* call("/register?name=Register&v=1");
          expectOk(body);
          expect(body.result.version).toEqual(1);
          expect(body.result.id).toMatch(/^[0-9a-f]{32}$/);
          expect(yield* versionOf("Register", 1)).toEqual({
            id: body.result.id,
            version: 1,
            content: avroSchema("Register", 1),
          });
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("EventHub.GetSchemaById", () => {
      test(
        "reads a schema by its ID",
        Effect.gen(function* () {
          const seeded = yield* seed("ById", 1);
          const body = yield* call(`/get-by-id?id=${seeded.id}`);
          expectOk(body);
          expect(body.result).toEqual({
            content: avroSchema("ById", 1),
            contentType: AVRO_STORED,
            schemaName: "ById",
            version: seeded.version,
          });
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("EventHub.GetSchemaByVersion", () => {
      test(
        "reads one version of a schema",
        Effect.gen(function* () {
          yield* seed("ByVersion", 1);
          const second = yield* seed("ByVersion", 2);
          const body = yield* call(`/get-by-version?name=ByVersion&version=${second.version}`);
          expectOk(body);
          expect(body.result).toEqual({
            content: avroSchema("ByVersion", 2),
            id: second.id,
            version: second.version,
          });
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("EventHub.GetSchemaPropertiesByContent", () => {
      test(
        "finds the ID of registered content",
        Effect.gen(function* () {
          const seeded = yield* seed("ByContent", 1);
          const body = yield* call("/get-properties?name=ByContent&v=1");
          expectOk(body);
          expect(body.result).toEqual({ id: seeded.id, version: seeded.version });
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("EventHub.ListSchemaVersions", () => {
      test(
        "lists the versions of a schema",
        Effect.gen(function* () {
          yield* seed("Versions", 1);
          yield* seed("Versions", 2);
          const body = yield* call("/list-versions?name=Versions");
          expectOk(body);
          expect(body.result.versions).toEqual([1, 2]);
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("EventHub.ListSchemaGroups", () => {
      test(
        "lists the schema groups of the namespace",
        Effect.gen(function* () {
          const { groupName } = yield* stack;
          const body = yield* call("/list-groups");
          expectOk(body);
          expect(body.result.groups).toEqual([groupName]);
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("EventHub.SchemaGroupRead", () => {
      test(
        "lists versions and reads by version, ID, and content",
        Effect.gen(function* () {
          const first = yield* seed("Read", 1);
          const second = yield* seed("Read", 2);
          const body = yield* call("/read?name=Read");
          expectOk(body);
          const { groupName } = yield* stack;
          const latest = {
            id: second.id,
            groupName,
            schemaName: "Read",
            version: 2,
            contentType: AVRO_STORED,
            content: avroSchema("Read", 2),
          };
          expect(body.result).toEqual({
            versions: [1, 2],
            latest,
            byId: latest,
            properties: { id: first.id, groupName, schemaName: "Read", version: 1 },
          });
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("EventHub.SchemaGroupWrite", () => {
      test(
        "registers a schema in the group's format",
        Effect.gen(function* () {
          const { groupName } = yield* stack;
          const body = yield* call("/write?name=Write&v=1");
          expectOk(body);
          expect(body.result).toEqual({
            id: expect.stringMatching(/^[0-9a-f]{32}$/),
            groupName,
            schemaName: "Write",
            version: 1,
          });
          expect(yield* versionOf("Write", 1)).toEqual({
            id: body.result.id,
            version: 1,
            content: avroSchema("Write", 1),
          });
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("EventHub.SchemaGroupReadWrite", () => {
      test(
        "registers a schema, then reads it back",
        Effect.gen(function* () {
          const { groupName } = yield* stack;
          const body = yield* call("/read-write?name=ReadWrite&v=1");
          expectOk(body);
          const id = body.result.registered.id;
          expect(body.result).toEqual({
            registered: { id, groupName, schemaName: "ReadWrite", version: 1 },
            schema: {
              id,
              groupName,
              schemaName: "ReadWrite",
              version: 1,
              contentType: AVRO_STORED,
              content: avroSchema("ReadWrite", 1),
            },
            versions: [1],
          });
          expect((yield* versionOf("ReadWrite", 1)).id).toEqual(id);
        }).pipe(Effect.provide(azure)),
        live,
      );
    });

    describe("least privilege", () => {
      test(
        "assigns Reader on the group, schemas/write and Reader on the namespace",
        Effect.gen(function* () {
          const out = yield* stack;
          expect(out.principalId).toMatch(/^[0-9a-f-]{36}$/);
          const { subscriptionId } = yield* Azure.AzureEnvironment.current;
          const page = yield* authorization.ListRoleAssignmentForSubscription({
            subscriptionId,
            _filter: `principalId eq '${out.principalId}'`,
          });
          const group = out.groupId.toLowerCase();
          const namespace = out.namespaceId.toLowerCase();
          const grants: string[] = [];
          for (const assignment of page.value) {
            const scope = assignment.properties?.scope?.toLowerCase() ?? "";
            // Only the registry scopes; the app's host-storage grants are not the bindings'.
            if (scope !== group && scope !== namespace) continue;
            const roleDefinitionId =
              assignment.properties?.roleDefinitionId?.split("/").pop() ?? "";
            const role = yield* authorization.GetRoleDefinition({
              scope: `/subscriptions/${subscriptionId}`,
              roleDefinitionId,
            });
            const permissions = (role.properties?.permissions ?? []).flatMap((p) => [
              ...(p.actions ?? []),
              ...(p.dataActions ?? []),
            ]);
            grants.push(
              `${scope === group ? "group" : "namespace"} ${[...permissions].sort().join(",")}`,
            );
          }
          const reader =
            "Microsoft.EventHub/namespaces/schemagroups/read,Microsoft.EventHub/namespaces/schemas/read";
          const writer = "Microsoft.EventHub/namespaces/schemas/write";
          // Read bindings share one Reader assignment on the group; write bindings
          // share one schemas/write assignment on the namespace (registration
          // refuses a role on the group); ListSchemaGroups reads the namespace.
          expect(grants.sort()).toEqual(
            [`group ${reader}`, `namespace ${reader}`, `namespace ${writer}`].sort(),
          );
        }).pipe(Effect.provide(azure)),
        { timeout: 120_000 },
      );
    });
  },
);

// Destroy, then prove the namespace (and its schema group) is gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    // `undefined` when the deploy failed; destroy still removes what it created.
    const out = yield* stack;
    yield* destroy(Stack);
    if (out !== undefined) {
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      expect(
        yield* waitGone(
          eventhub.GetNamespace({
            subscriptionId,
            resourceGroupName: out.resourceGroup,
            namespaceName: out.namespaceName,
          }),
        ),
      ).toEqual("gone");
    }
  }).pipe(Effect.provide(azure)),
  { timeout: 1_200_000 },
);
