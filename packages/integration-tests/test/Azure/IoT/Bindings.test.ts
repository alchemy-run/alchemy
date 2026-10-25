import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as dps from "@distilled.cloud/azure/deviceprovisioning-data";
import * as Alchemy from "alchemy";
import { describe, expect } from "alchemy-test";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import DpsFunction, { Dps, enrollmentIds } from "./fixtures/bindings-function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Built-in **Device Provisioning Service Data Contributor**: the deployer's out-of-band access. */
const DPS_DATA_CONTRIBUTOR = "dfce44e4-17b7-4bd1-a6d1-04996ec95633";

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
  "AzureDpsBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* DpsFunction;
    const service = yield* Dps;
    // Lets the deployer verify each binding's effect through the service API.
    const deployer = yield* callerObjectId;
    yield* Azure.Authorization.RoleAssignment("DpsDeployerDataContributor", {
      scope: service.provisioningServiceId,
      roleDefinitionId: DPS_DATA_CONTRIBUTOR,
      principalId: deployer,
    });
    return {
      url: fn.url,
      principalId: fn.principalId,
      serviceId: service.provisioningServiceId,
      dpsName: service.provisioningServiceName,
    };
  }),
);

// DPS S1 has no fixed fee and Flex Consumption bills per execution:
// ~$0.01/run; ~5 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Deployer credentials and environment for out-of-band checks and hooks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: any; error?: string };

/** This run's enrollment IDs (see `enrollmentIds`), chosen on first use. */
let run = "";
const ids = Effect.sync(() => {
  run ||= crypto.randomUUID().slice(0, 8);
  return { run, ...enrollmentIds(run) };
});

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation (about 4 minutes), then return the last
 * answer so a real failure shows its Azure error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    const { run } = yield* ids;
    return yield* HttpClient.execute(HttpClientRequest.get(`${url}${route}?run=${run}`)).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((json) => json as Body),
      Effect.flatMap((json) => (json?.ok ? Effect.succeed(json) : Effect.fail(json))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 48 }),
      Effect.catch((json) => Effect.succeed(json as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** Run a service-API call as the deployer (retried through role propagation). */
const asDeployer = <A, E>(f: (dpsName: string) => Effect.Effect<A, E, dps.AzureOpContext>) =>
  Effect.gen(function* () {
    const { dpsName } = yield* stack;
    return yield* f(dpsName).pipe(
      Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 18 }),
    );
  }).pipe(Effect.provide(azure));

/** The `_tag` a deployer call fails with (`"found"` when it succeeds). */
const deployerTag = <A, E extends { _tag: string }>(
  f: (dpsName: string) => Effect.Effect<A, E, dps.AzureOpContext>,
) =>
  Effect.gen(function* () {
    const { dpsName } = yield* stack;
    return yield* f(dpsName).pipe(
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
        .map((a) => a.replace("Microsoft.Devices/provisioningServices/", ""))
        .sort()
        .join("+");
      grants.push(`${actions} ${scope}`);
    }
    return grants.sort();
  });

describe(
  "Device Provisioning Service bindings on an Azure Function",
  { tags: ["provider:azure", "provider:azure:iot", "live"] },
  () => {
    describe("IoT.CreateOrUpdateEnrollmentGroup", () => {
      test(
        "creates an enrollment group the deployer reads back",
        Effect.gen(function* () {
          const { group } = yield* ids;
          const body = yield* call("/groups/create");
          expectOk(body);
          expect(body.result).toEqual({ id: group, type: "symmetricKey" });
          const observed = yield* asDeployer((dpsName) =>
            dps.GetEnrollmentGroup({ dpsName, id: group }),
          );
          expect(observed.provisioningStatus).toEqual("enabled");
        }),
        { timeout: 300_000 },
      );
    });

    describe("IoT.GetEnrollmentGroup", () => {
      test(
        "reads the group; a missing one fails with a typed error",
        Effect.gen(function* () {
          const { group } = yield* ids;
          const body = yield* call("/groups/get");
          expectOk(body);
          expect(body.result).toEqual({ id: group, status: "enabled", missing: "NotFound" });
        }),
        { timeout: 300_000 },
      );
    });

    describe("IoT.QueryEnrollmentGroups", () => {
      test(
        "finds the group",
        Effect.gen(function* () {
          const { group } = yield* ids;
          const body = yield* call("/groups/query");
          expectOk(body);
          // Query results trail writes and may list earlier runs' IDs.
          expect(body.result.ids).toContain(group);
        }),
        { timeout: 300_000 },
      );
    });

    describe("IoT.GetEnrollmentGroupAttestationMechanism", () => {
      test(
        "reads the group's symmetric keys",
        Effect.gen(function* () {
          const body = yield* call("/groups/attestation");
          expectOk(body);
          expect(body.result).toEqual({ type: "symmetricKey", hasKey: true });
        }),
        { timeout: 300_000 },
      );
    });

    describe("IoT.RunEnrollmentGroupBulkOperation", () => {
      test(
        "creates and deletes a group in bulk",
        Effect.gen(function* () {
          const { bulkGroup } = yield* ids;
          const created = yield* call("/groups/bulk-create");
          expectOk(created);
          expect(created.result.isSuccessful).toEqual(true);
          const observed = yield* asDeployer((dpsName) =>
            dps.GetEnrollmentGroup({ dpsName, id: bulkGroup }),
          );
          expect(observed.enrollmentGroupId).toEqual(bulkGroup);
          const deleted = yield* call("/groups/bulk-delete");
          expectOk(deleted);
          expect(deleted.result.isSuccessful).toEqual(true);
          const tag = yield* deployerTag((dpsName) =>
            dps.GetEnrollmentGroup({ dpsName, id: bulkGroup }),
          );
          expect(tag).toEqual("NotFound");
        }),
        { timeout: 300_000 },
      );
    });

    describe("IoT.CreateOrUpdateIndividualEnrollment", () => {
      test(
        "creates an enrollment the deployer reads back",
        Effect.gen(function* () {
          const { enrollment } = yield* ids;
          const body = yield* call("/enrollments/create");
          expectOk(body);
          expect(body.result).toEqual({ id: enrollment, type: "symmetricKey" });
          const observed = yield* asDeployer((dpsName) =>
            dps.GetIndividualEnrollment({ dpsName, id: enrollment }),
          );
          expect(observed.provisioningStatus).toEqual("enabled");
        }),
        { timeout: 300_000 },
      );
    });

    describe("IoT.GetIndividualEnrollment", () => {
      test(
        "reads the enrollment; a missing one fails with a typed error",
        Effect.gen(function* () {
          const { enrollment } = yield* ids;
          const body = yield* call("/enrollments/get");
          expectOk(body);
          expect(body.result).toEqual({
            id: enrollment,
            status: "enabled",
            missing: "NotFound",
          });
        }),
        { timeout: 300_000 },
      );
    });

    describe("IoT.QueryIndividualEnrollments", () => {
      test(
        "finds the enrollment",
        Effect.gen(function* () {
          const { enrollment } = yield* ids;
          const body = yield* call("/enrollments/query");
          expectOk(body);
          // Query results trail writes and may list earlier runs' IDs.
          expect(body.result.ids).toContain(enrollment);
        }),
        { timeout: 300_000 },
      );
    });

    describe("IoT.GetIndividualEnrollmentAttestationMechanism", () => {
      test(
        "reads the enrollment's symmetric keys",
        Effect.gen(function* () {
          const body = yield* call("/enrollments/attestation");
          expectOk(body);
          expect(body.result).toEqual({ type: "symmetricKey", hasKey: true });
        }),
        { timeout: 300_000 },
      );
    });

    describe("IoT.RunIndividualEnrollmentBulkOperation", () => {
      test(
        "creates and deletes an enrollment in bulk",
        Effect.gen(function* () {
          const { bulkEnrollment } = yield* ids;
          const created = yield* call("/enrollments/bulk-create");
          expectOk(created);
          expect(created.result.isSuccessful).toEqual(true);
          const observed = yield* asDeployer((dpsName) =>
            dps.GetIndividualEnrollment({ dpsName, id: bulkEnrollment }),
          );
          expect(observed.registrationId).toEqual(bulkEnrollment);
          const deleted = yield* call("/enrollments/bulk-delete");
          expectOk(deleted);
          expect(deleted.result.isSuccessful).toEqual(true);
          const tag = yield* deployerTag((dpsName) =>
            dps.GetIndividualEnrollment({ dpsName, id: bulkEnrollment }),
          );
          expect(tag).toEqual("NotFound");
        }),
        { timeout: 300_000 },
      );
    });

    describe("IoT.QueryDeviceRegistrationStates", () => {
      test(
        "lists no registrations for a group no device used",
        Effect.gen(function* () {
          const body = yield* call("/registrations/query");
          expectOk(body);
          expect(body.result.ids).toEqual([]);
        }),
        { timeout: 300_000 },
      );
    });

    describe("IoT.GetDeviceRegistrationState", () => {
      test(
        "a device that never registered has no registration state",
        Effect.gen(function* () {
          const body = yield* call("/registrations/get");
          expectOk(body);
          expect(body.result.tag).toEqual("NotFound");
        }),
        { timeout: 300_000 },
      );
    });

    describe("IoT.DeleteDeviceRegistrationState", () => {
      test(
        "deleting a missing registration state fails with a typed error",
        Effect.gen(function* () {
          const body = yield* call("/registrations/delete");
          expectOk(body);
          expect(body.result.tag).toEqual("NotFound");
        }),
        { timeout: 300_000 },
      );
    });

    describe("IoT.DeleteIndividualEnrollment", () => {
      test(
        "deletes the enrollment",
        Effect.gen(function* () {
          const { enrollment } = yield* ids;
          expectOk(yield* call("/enrollments/delete"));
          const tag = yield* deployerTag((dpsName) =>
            dps.GetIndividualEnrollment({ dpsName, id: enrollment }),
          );
          expect(tag).toEqual("NotFound");
        }),
        { timeout: 300_000 },
      );
    });

    describe("IoT.DeleteEnrollmentGroup", () => {
      test(
        "deletes the group",
        Effect.gen(function* () {
          const { group } = yield* ids;
          expectOk(yield* call("/groups/delete"));
          const tag = yield* deployerTag((dpsName) =>
            dps.GetEnrollmentGroup({ dpsName, id: group }),
          );
          expect(tag).toEqual("NotFound");
        }),
        { timeout: 300_000 },
      );
    });

    describe("AzureBindings.Bind least privilege", () => {
      test(
        "assigns exactly each binding kind's data actions, scoped to the service",
        Effect.gen(function* () {
          const outputs = yield* stack;
          expect(outputs.principalId).toMatch(/^[0-9a-f-]{36}$/);
          const grants = yield* grantsOf(outputs.principalId!).pipe(Effect.provide(azure));
          const scope = outputs.serviceId.toLowerCase();
          expect(grants).toEqual(
            [
              "enrollmentGroups/read",
              "enrollmentGroups/write",
              "enrollmentGroups/delete",
              "enrollmentGroups/delete+enrollmentGroups/write",
              "enrollments/read",
              "enrollments/write",
              "enrollments/delete",
              "enrollments/delete+enrollments/write",
              "attestationmechanism/details/action",
              "registrationStates/read",
              "registrationStates/delete",
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
