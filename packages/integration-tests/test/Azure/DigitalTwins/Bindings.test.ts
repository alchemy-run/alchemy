import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as dt from "@distilled.cloud/azure/digitaltwins-data";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Output from "alchemy/Output";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import DtFunction, {
  FLOOR,
  FLOOR_ID,
  GridEndpoint,
  IMPORT_JOB_ID,
  RELATIONSHIP_ID,
  ROOM,
  ROOM_ID,
  ROUTE_ID,
  SCRATCH,
  THERMOSTAT,
  Twins,
} from "./fixtures/function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Built-in **Azure Digital Twins Data Owner**: the deployer's out-of-band data-plane access. */
const DIGITAL_TWINS_DATA_OWNER = "bcd981a7-7f74-457b-83e1-cceb9e632ffe";

/** Object ID (`oid` claim) of the identity running the tests. */
const callerObjectId = Effect.gen(function* () {
  const config = yield* yield* Credentials;
  const token = Redacted.value(config.bearerToken);
  return yield* Effect.sync(
    () =>
      JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"))
        .oid as string,
  );
});

const Stack = Alchemy.Stack(
  "AzureDigitalTwinsBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* DtFunction;
    const twins = yield* Twins;
    yield* GridEndpoint;
    // Holds the import job's (empty) input and output blobs.
    const account = yield* Azure.Storage.StorageAccount("DtImportData");
    const container = yield* Azure.Storage.BlobContainer("DtImports", {
      storageAccount: account.storageAccountName,
    });
    // Lets the deployer verify each binding's effect through the data plane.
    const deployer = yield* callerObjectId.pipe(Effect.orDie);
    yield* Azure.Authorization.RoleAssignment("DtDeployerDataOwner", {
      scope: twins.instanceId,
      roleDefinitionId: DIGITAL_TWINS_DATA_OWNER,
      principalId: deployer,
    });
    return {
      url: fn.url,
      principalId: fn.principalId,
      instanceId: twins.instanceId,
      hostName: twins.hostName,
      importBlobs: Output.interpolate`https://${account.storageAccountName}.blob.core.windows.net/${container.containerName}`,
    };
  }),
);

// ~$0.01/run (Flex Consumption, Digital Twins and Event Grid bill per
// operation); ~5 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Deployer credentials and environment for out-of-band checks and hooks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation (about 4 minutes), then return the last
 * answer so a real failure shows its Azure error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.execute(HttpClientRequest.get(`${url}${route}`)).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((json) => json as Body),
      Effect.flatMap((json) => (json?.ok ? Effect.succeed(json) : Effect.fail(json))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
      Effect.catch((json) => Effect.succeed(json as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** The instance's data-plane endpoint. */
const endpoint = Effect.map(stack, ({ hostName }) => `https://${hostName}`);

/** Run a data-plane read as the deployer (retried through role propagation). */
const asDeployer = <A, E>(f: (endpoint: string) => Effect.Effect<A, E, dt.AzureOpContext>) =>
  Effect.gen(function* () {
    const at = yield* endpoint;
    return yield* f(at).pipe(Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 18 }));
  }).pipe(Effect.provide(azure));

/** The `_tag` a deployer read fails with (`"found"` when it succeeds). */
const deployerTag = <A, E extends { _tag: string }>(
  f: (endpoint: string) => Effect.Effect<A, E, dt.AzureOpContext>,
) =>
  Effect.gen(function* () {
    const at = yield* endpoint;
    return yield* f(at).pipe(
      Effect.as("found"),
      Effect.catch((error) => Effect.succeed(error._tag)),
    );
  }).pipe(Effect.provide(azure));

/** Role assignments of the Function's identity, without its own host-storage grants. */
const assignmentsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    // Every page: a filtered list can answer an empty first page with a `nextLink`.
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      }),
    );
    return Array.from(assignments).filter(
      (a) => !/\/storageaccounts\/[^/]+$/.test(a.properties?.scope?.toLowerCase() ?? ""),
    );
  });

/** Every role on the Function's identity as `<data actions> <scope>`. */
const grantsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const grants: string[] = [];
    for (const assignment of yield* assignmentsOf(principalId)) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      const definition = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId: assignment.properties?.roleDefinitionId?.split("/").pop() ?? "",
      });
      const actions = (definition.properties?.permissions ?? [])
        .flatMap((p) => [...(p.actions ?? []), ...(p.dataActions ?? [])])
        .map((a) => a.replace("Microsoft.DigitalTwins/", ""))
        .sort()
        .join("+");
      grants.push(`${actions} ${scope}`);
    }
    return grants.sort();
  });

describe(
  "Digital Twins bindings on an Azure Function",
  { tags: ["provider:azure", "provider:azure:digitaltwins", "live"] },
  () => {
    describe("DigitalTwins.AddDigitalTwinModels", () => {
      test(
        "uploads the models the deployer reads back",
        Effect.gen(function* () {
          expectOk(yield* call("/models/add"));
          const room = yield* asDeployer((at) =>
            dt.GetDigitalTwinModelById({ endpoint: at, id: ROOM }),
          );
          expect(room.id).toEqual(ROOM);
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.GetDigitalTwinModel", () => {
      test(
        "reads a model with its definition; a missing one is DigitalTwinModelNotFound",
        Effect.gen(function* () {
          const body = yield* call("/models/get");
          expectOk(body);
          expect(body.result).toEqual({
            id: ROOM,
            hasDefinition: true,
            missing: "DigitalTwinModelNotFound",
          });
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.ListDigitalTwinModels", () => {
      test(
        "lists every uploaded model",
        Effect.gen(function* () {
          const body = yield* call("/models/list");
          expectOk(body);
          expect(body.result.ids).toEqual([FLOOR, ROOM, SCRATCH, THERMOSTAT].sort());
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.AddDigitalTwin", () => {
      test(
        "creates the twins the deployer reads back",
        Effect.gen(function* () {
          const body = yield* call("/twins/add");
          expectOk(body);
          expect(body.result).toEqual({ room: ROOM_ID, floor: FLOOR_ID });
          const room = yield* asDeployer((at) =>
            dt.GetDigitalTwinById({ endpoint: at, id: ROOM_ID }),
          );
          expect(room.temperature).toEqual(21);
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.GetDigitalTwin", () => {
      test(
        "reads a twin; a missing one is DigitalTwinNotFound",
        Effect.gen(function* () {
          const body = yield* call("/twins/get");
          expectOk(body);
          expect(body.result).toEqual({
            id: ROOM_ID,
            temperature: 21,
            missing: "DigitalTwinNotFound",
          });
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.UpdateDigitalTwin", () => {
      test(
        "patches a property the deployer reads back",
        Effect.gen(function* () {
          expectOk(yield* call("/twins/update"));
          const room = yield* asDeployer((at) =>
            dt.GetDigitalTwinById({ endpoint: at, id: ROOM_ID }),
          );
          expect(room.temperature).toEqual(22);
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.GetDigitalTwinComponent", () => {
      test(
        "reads the thermostat component",
        Effect.gen(function* () {
          const body = yield* call("/component/get");
          expectOk(body);
          expect(body.result).toEqual({ setpoint: 20 });
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.UpdateDigitalTwinComponent", () => {
      test(
        "patches the component the deployer reads back",
        Effect.gen(function* () {
          expectOk(yield* call("/component/update"));
          const thermostat = yield* asDeployer((at) =>
            dt.GetDigitalTwinComponent({ endpoint: at, id: ROOM_ID, componentPath: "thermostat" }),
          );
          expect(thermostat.setpoint).toEqual(19);
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.SendDigitalTwinTelemetry", () => {
      test(
        "sends telemetry for a twin; a missing twin is DigitalTwinNotFound",
        Effect.gen(function* () {
          const body = yield* call("/telemetry");
          expectOk(body);
          expect(body.result).toEqual({ sent: true, missing: "DigitalTwinNotFound" });
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.SendDigitalTwinComponentTelemetry", () => {
      test(
        "sends telemetry for a component",
        Effect.gen(function* () {
          const body = yield* call("/component-telemetry");
          expectOk(body);
          expect(body.result).toEqual({ sent: true });
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.AddDigitalTwinRelationship", () => {
      test(
        "relates the floor to the room",
        Effect.gen(function* () {
          const body = yield* call("/relationships/add");
          expectOk(body);
          expect(body.result).toEqual({ id: RELATIONSHIP_ID, target: ROOM_ID });
          const rel = yield* asDeployer((at) =>
            dt.GetDigitalTwinRelationshipById({
              endpoint: at,
              id: FLOOR_ID,
              relationshipId: RELATIONSHIP_ID,
            }),
          );
          expect(rel.$targetId).toEqual(ROOM_ID);
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.UpdateDigitalTwinRelationship", () => {
      test(
        "adds a property the deployer reads back",
        Effect.gen(function* () {
          expectOk(yield* call("/relationships/update"));
          const rel = yield* asDeployer((at) =>
            dt.GetDigitalTwinRelationshipById({
              endpoint: at,
              id: FLOOR_ID,
              relationshipId: RELATIONSHIP_ID,
            }),
          );
          expect(rel.since).toEqual("2026-01-01");
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.GetDigitalTwinRelationship", () => {
      test(
        "reads the relationship; a missing one is DigitalTwinRelationshipNotFound",
        Effect.gen(function* () {
          const body = yield* call("/relationships/get");
          expectOk(body);
          expect(body.result).toEqual({
            name: "contains",
            since: "2026-01-01",
            missing: "DigitalTwinRelationshipNotFound",
          });
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.ListDigitalTwinRelationships", () => {
      test(
        "lists the floor's relationships",
        Effect.gen(function* () {
          const body = yield* call("/relationships/list");
          expectOk(body);
          expect(body.result.ids).toEqual([RELATIONSHIP_ID]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.ListDigitalTwinIncomingRelationships", () => {
      test(
        "lists the room's incoming relationships",
        Effect.gen(function* () {
          const body = yield* call("/relationships/incoming");
          expectOk(body);
          expect(body.result.sources).toEqual([FLOOR_ID]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.QueryTwins", () => {
      test(
        "finds the room by model",
        Effect.gen(function* () {
          const body = yield* call("/query");
          expectOk(body);
          expect(body.result.ids).toEqual([ROOM_ID]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.AddEventRoute", () => {
      test(
        "routes events to the Event Grid endpoint",
        Effect.gen(function* () {
          expectOk(yield* call("/routes/add"));
          const route = yield* asDeployer((at) =>
            dt.GetEventRouteById({ endpoint: at, id: ROUTE_ID }),
          );
          expect({ endpointName: route.endpointName, filter: route.filter }).toEqual({
            endpointName: "alchemy-grid",
            filter: "true",
          });
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.GetEventRoute", () => {
      test(
        "reads the route",
        Effect.gen(function* () {
          const body = yield* call("/routes/get");
          expectOk(body);
          expect(body.result).toEqual({
            id: ROUTE_ID,
            endpointName: "alchemy-grid",
            filter: "true",
          });
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.ListEventRoutes", () => {
      test(
        "lists the route",
        Effect.gen(function* () {
          const body = yield* call("/routes/list");
          expectOk(body);
          expect(body.result.ids).toEqual([ROUTE_ID]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.DeleteEventRoute", () => {
      test(
        "deletes the route",
        Effect.gen(function* () {
          expectOk(yield* call("/routes/delete"));
          const tag = yield* deployerTag((at) =>
            dt.GetEventRouteById({ endpoint: at, id: ROUTE_ID }),
          );
          expect(tag).toEqual("DigitalTwinEventRouteNotFound");
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.AddImportJob", () => {
      test(
        "creates an import job the deployer reads back",
        Effect.gen(function* () {
          const { importBlobs } = yield* stack;
          const input = `${importBlobs}/in.ndjson`;
          const output = `${importBlobs}/out.ndjson`;
          const body = yield* call(
            `/imports/add?input=${encodeURIComponent(input)}&output=${encodeURIComponent(output)}`,
          );
          expectOk(body);
          expect(body.result.id).toEqual(IMPORT_JOB_ID);
          const job = yield* asDeployer((at) =>
            dt.GetImportJobById({ endpoint: at, id: IMPORT_JOB_ID }),
          );
          expect(job.inputBlobUri).toEqual(input);
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.GetImportJob", () => {
      test(
        "reads the import job",
        Effect.gen(function* () {
          const body = yield* call("/imports/get");
          expectOk(body);
          expect(body.result.id).toEqual(IMPORT_JOB_ID);
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.ListImportJobs", () => {
      test(
        "lists the import job",
        Effect.gen(function* () {
          const body = yield* call("/imports/list");
          expectOk(body);
          expect(body.result.ids).toEqual([IMPORT_JOB_ID]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.CancelImportJob", () => {
      test(
        "cancels the import job",
        Effect.gen(function* () {
          const body = yield* call("/imports/cancel");
          expectOk(body);
          expect(body.result.tag).toEqual("none");
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.DeleteImportJob", () => {
      test(
        "deletes the import job",
        Effect.gen(function* () {
          expectOk(yield* call("/imports/delete"));
          const tag = yield* deployerTag((at) =>
            dt.GetImportJobById({ endpoint: at, id: IMPORT_JOB_ID }),
          );
          expect(tag).toEqual("DigitalTwinJobNotFound");
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.DeleteDigitalTwinRelationship", () => {
      test(
        "deletes the relationship",
        Effect.gen(function* () {
          expectOk(yield* call("/relationships/delete"));
          const tag = yield* deployerTag((at) =>
            dt.GetDigitalTwinRelationshipById({
              endpoint: at,
              id: FLOOR_ID,
              relationshipId: RELATIONSHIP_ID,
            }),
          );
          expect(tag).toEqual("DigitalTwinRelationshipNotFound");
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.DeleteDigitalTwin", () => {
      test(
        "deletes both twins",
        Effect.gen(function* () {
          expectOk(yield* call("/twins/delete"));
          const tag = yield* deployerTag((at) =>
            dt.GetDigitalTwinById({ endpoint: at, id: ROOM_ID }),
          );
          expect(tag).toEqual("DigitalTwinNotFound");
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.UpdateDigitalTwinModel", () => {
      test(
        "decommissions the scratch model",
        Effect.gen(function* () {
          expectOk(yield* call("/models/decommission"));
          const model = yield* asDeployer((at) =>
            dt.GetDigitalTwinModelById({ endpoint: at, id: SCRATCH }),
          );
          expect(model.decommissioned).toEqual(true);
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.DeleteDigitalTwinModel", () => {
      test(
        "deletes the scratch model",
        Effect.gen(function* () {
          expectOk(yield* call("/models/delete"));
          const tag = yield* deployerTag((at) =>
            dt.GetDigitalTwinModelById({ endpoint: at, id: SCRATCH }),
          );
          expect(tag).toEqual("DigitalTwinModelNotFound");
        }),
        { timeout: 300_000 },
      );
    });

    // A delete job's ID can never be reused, so each run starts a new one.
    let deleteJobId = "";

    describe("DigitalTwins.AddDeleteJob", () => {
      test(
        "starts a delete job that removes every model",
        Effect.gen(function* () {
          deleteJobId = yield* Effect.sync(() => `alchemy-delete-${crypto.randomUUID()}`);
          expectOk(yield* call(`/deletejobs/add?id=${deleteJobId}`));
          // A delete job runs for a few minutes.
          const job = yield* asDeployer((at) =>
            dt.GetDeleteJobById({ endpoint: at, id: deleteJobId }).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("10 seconds"),
                until: (j) => j.status === "succeeded" || j.status === "failed",
                times: 36,
              }),
            ),
          );
          expect(job.status).toEqual("succeeded");
          const tag = yield* deployerTag((at) =>
            dt.GetDigitalTwinModelById({ endpoint: at, id: ROOM }),
          );
          expect(tag).toEqual("DigitalTwinModelNotFound");
        }),
        { timeout: 600_000 },
      );
    });

    describe("DigitalTwins.GetDeleteJob", () => {
      test(
        "reads the delete job",
        Effect.gen(function* () {
          const body = yield* call(`/deletejobs/get?id=${deleteJobId}`);
          expectOk(body);
          expect(body.result).toEqual({ id: deleteJobId, status: "succeeded" });
        }),
        { timeout: 300_000 },
      );
    });

    describe("DigitalTwins.ListDeleteJobs", () => {
      test(
        "lists the delete job",
        Effect.gen(function* () {
          const body = yield* call("/deletejobs/list");
          expectOk(body);
          expect(body.result.ids).toContain(deleteJobId);
        }),
        { timeout: 300_000 },
      );
    });

    describe("AzureBindings.Bind least privilege", () => {
      test(
        "assigns exactly each binding kind's data action, scoped to the instance",
        Effect.gen(function* () {
          const outputs = yield* stack;
          expect(outputs.principalId).toMatch(/^[0-9a-f-]{36}$/);
          const grants = yield* grantsOf(outputs.principalId!).pipe(Effect.provide(azure));
          const scope = outputs.instanceId.toLowerCase();
          expect(grants).toEqual(
            [
              "query/action",
              "digitaltwins/read",
              "digitaltwins/write",
              "digitaltwins/delete",
              "digitaltwins/*",
              "digitaltwins/relationships/read",
              "digitaltwins/relationships/write",
              "digitaltwins/relationships/delete",
              "models/read",
              "models/write",
              "models/delete",
              "eventroutes/read",
              "eventroutes/write",
              "eventroutes/delete",
              "jobs/imports/read",
              "jobs/imports/write",
              "jobs/imports/delete",
              "jobs/imports/cancel/action",
              "jobs/delete/read",
              "jobs/delete/write",
            ]
              .map((action) => `${action} ${scope}`)
              .sort(),
          );
        }),
        { timeout: 120_000 },
      );
    });
  },
);

// Destroy, then prove every role assigned to the Function's identity is gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    const { principalId } = yield* stack;
    yield* destroy(Stack);
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    const remaining = yield* assignmentsOf(principalId!).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (assignments) => assignments.length === 0,
        times: 12,
      }),
    );
    expect(remaining.map((a) => a.properties?.scope)).toEqual([]);
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
