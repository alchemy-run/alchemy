import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as devcenterArm from "@distilled.cloud/azure/devcenter";
import * as devcenter from "@distilled.cloud/azure/devcenter-data";
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
import { runExpensive, runPaidOnly } from "../gates.ts";
import DcBindingsFunction, {
  Catalog,
  Center,
  DESCRIPTION,
  LIVE_DEV_BOX,
  MISSING,
  Project,
  ProjectEnvironmentType,
  TaskCatalog,
} from "./fixtures/function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

/** Built-in **DevCenter Project Admin**: the deployer's out-of-band data-plane access. */
const DEVCENTER_PROJECT_ADMIN = "331c37c6-af14-46d9-b9f4-e1909e1b95a0";

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

/**
 * The gated dev box lifecycle needs a tenant onboarded to Dev Box (closed to
 * new customers on 2025-11-01: this subscription answers
 * `DevBoxTenantNotOnboarded`, see `Pool.test.ts`) and bills compute.
 */
const runDevBoxes = runExpensive && runPaidOnly;

/** A dev box definition, pool and auto-stop schedule for the gated lifecycle. */
const DevBoxPool = Effect.gen(function* () {
  const center = yield* Center;
  const project = yield* Project;
  const definition = yield* Azure.DevCenter.DevBoxDefinition("DcBindingsDefinition", {
    devCenter: center.devCenterName,
    location: "eastus",
    imageReferenceId: Output.interpolate`${center.devCenterId}/galleries/default/images/microsoftwindowsdesktop_windows-ent-cpc_win11-24h2-ent-cpc`,
    skuName: "general_i_8c32gb256ssd_v2",
    osStorageType: "ssd_256gb",
  });
  const pool = yield* Azure.DevCenter.Pool("DcBindingsPool", {
    project: project.projectName,
    location: "eastus",
    devBoxDefinitionName: definition.devBoxDefinitionName,
  });
  yield* Azure.DevCenter.Schedule("DcBindingsSchedule", {
    project: project.projectName,
    pool: pool.poolName,
    time: "19:00",
    timeZone: "America/Los_Angeles",
  });
  return pool.poolName;
});

const Stack = Alchemy.Stack(
  "AzureDevCenterBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* DcBindingsFunction;
    const project = yield* Project;
    const catalog = yield* Catalog;
    const environmentType = yield* ProjectEnvironmentType;
    const taskCatalog = yield* TaskCatalog;
    const poolName = runDevBoxes ? yield* DevBoxPool : undefined;
    // Lets the deployer read every user's dev boxes and environments.
    const deployer = yield* callerObjectId.pipe(Effect.orDie);
    yield* Azure.Authorization.RoleAssignment("DcDeployerProjectAdmin", {
      scope: project.projectId,
      roleDefinitionId: DEVCENTER_PROJECT_ADMIN,
      principalId: deployer,
    });
    return {
      url: fn.url,
      principalId: fn.principalId,
      projectId: project.projectId,
      projectName: project.projectName,
      resourceGroup: project.resourceGroup,
      devCenterUri: project.devCenterUri,
      catalogName: catalog.catalogName,
      taskCatalogName: taskCatalog.catalogName,
      poolName,
      environmentTypeName: environmentType.environmentTypeName,
    };
  }),
);

// Dev centers, projects, catalogs and environment types are free; the
// Function is Flex Consumption (~$0.01/run). ~6 min deploy, ~6 min destroy
// (the dev center delete dominates).
const stack = beforeAll(deploy(Stack), { timeout: 1_200_000 });

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
 * cold start and role propagation (up to about 8 minutes on a new Dev Center
 * project), then return the last answer so a real failure shows its Azure
 * error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack;
    return yield* HttpClient.execute(HttpClientRequest.get(`${url}${route}`)).pipe(
      Effect.timeout("60 seconds"),
      Effect.flatMap((response) => response.json),
      Effect.map((json) => json as Body),
      Effect.flatMap((json) => (json?.ok ? Effect.succeed(json) : Effect.fail(json))),
      Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 96 }),
      Effect.catch((json) => Effect.succeed(json as Body)),
    );
  });

const expectOk = (body: Body) => expect({ ok: body.ok, error: body.error }).toEqual({ ok: true });

/** Run a `devcenter` (ARM) call as the deployer. */
const arm = <A, E>(
  f: (target: {
    subscriptionId: string;
    resourceGroupName: string;
    projectName: string;
  }) => Effect.Effect<A, E, any>,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const { resourceGroup, projectName } = yield* stack;
    return yield* f({
      subscriptionId,
      resourceGroupName: resourceGroup,
      projectName,
    }) as Effect.Effect<A, E>;
  }).pipe(Effect.provide(azure));

/** Run a `devcenter-data` call as the deployer (DevCenter Project Admin on the project). */
const asDeployer = <A, E>(
  f: (target: { endpoint: string; projectName: string }) => Effect.Effect<A, E, any>,
) =>
  Effect.gen(function* () {
    const { devCenterUri, projectName } = yield* stack;
    return yield* f({ endpoint: devCenterUri ?? "", projectName }) as Effect.Effect<A, E>;
  }).pipe(Effect.provide(azure));

/** Role assignments of the Function's identity, without its own host-storage grants. */
const assignmentsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
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

/** Number of roles the fixture's bindings assign (one per custom role). */
const EXPECTED_GRANTS = 22;

/** Every role on the Function's identity as `<permissions> <scope>`. */
const grantsOf = (principalId: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    // Lists of a new identity's assignments trail the writes by seconds.
    const assignments = yield* assignmentsOf(principalId).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (found) => found.length >= EXPECTED_GRANTS,
        times: 12,
      }),
    );
    const grants: string[] = [];
    for (const assignment of assignments) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      const definition = yield* authorization.GetRoleDefinition({
        scope: `/subscriptions/${subscriptionId}`,
        roleDefinitionId: assignment.properties?.roleDefinitionId?.split("/").pop() ?? "",
      });
      const permissions = (definition.properties?.permissions ?? [])
        .flatMap((p) => [...(p.actions ?? []), ...(p.dataActions ?? [])])
        .map((a) => a.replace(/^Microsoft\.DevCenter\/projects\//, ""))
        .sort()
        .join("+");
      grants.push(`${permissions} ${scope}`);
    }
    return grants.sort();
  });

describe(
  "Dev Center data-plane bindings on an Azure Function",
  { tags: ["provider:azure", "provider:azure:devcenter", "live"] },
  () => {
    describe("DevCenter.GetProject", () => {
      test(
        "reads the project",
        Effect.gen(function* () {
          const { projectName } = yield* stack;
          const body = yield* call("/project");
          expectOk(body);
          expect(body.result).toEqual({ name: projectName, description: DESCRIPTION });
          const observed = yield* arm((t) => devcenterArm.GetProject(t));
          expect(observed.properties?.description).toEqual(DESCRIPTION);
        }),
        { timeout: 900_000 },
      );
    });

    describe("DevCenter.GetProjectAbilities", () => {
      // Skipped: the data plane answers 500 `InternalServerError` ("The service
      // encountered an internal error ... (CorrelationId )") to every
      // service principal and managed identity, for `me` and for an explicit
      // object ID (live, 2026-10-25); the binding is implemented.
      test.skip(
        "reports the host's abilities from its grants",
        Effect.gen(function* () {
          const body = yield* call("/abilities");
          expectOk(body);
          expect(body.result).toEqual({
            developer: [
              "DeleteDevBoxes",
              "DeleteEnvironments",
              "ReadDevBoxes",
              "ReadEnvironmentOutputs",
              "ReadEnvironments",
              "ReadRemoteConnections",
              "StartDevBoxes",
              "StopDevBoxes",
              "WriteDevBoxes",
              "WriteEnvironments",
            ],
            admin: [],
          });
        }),
        { timeout: 900_000 },
      );
    });

    describe("DevCenter.ListPools", () => {
      test(
        "lists the project's pools (none); a missing pool fails typed",
        Effect.gen(function* () {
          const body = yield* call("/pools");
          expectOk(body);
          const observed = yield* arm((t) => devcenterArm.ListPoolByProject(t));
          expect(observed.value.map((p) => p.name)).toEqual([]);
          expect(body.result).toEqual({ names: [], missing: "PoolNotFound" });
        }),
        { timeout: 900_000 },
      );
    });

    describe("DevCenter.GetPool", () => {
      test(
        "fails typed for a pool the project does not have",
        Effect.gen(function* () {
          const body = yield* call("/pools");
          expectOk(body);
          expect(body.result.missing).toEqual("PoolNotFound");
        }),
        { timeout: 900_000 },
      );
    });

    describe("DevCenter.ListSchedules", () => {
      test(
        "lists the project's schedules (none)",
        Effect.gen(function* () {
          const body = yield* call("/schedules");
          expectOk(body);
          const observed = yield* asDeployer((t) => devcenter.ListDevBoxSchedulesByProject(t));
          expect(body.result.names).toEqual(observed.value.map((s) => s.name).sort());
        }),
        { timeout: 900_000 },
      );
    });

    describe("DevCenter.ListCatalogs", () => {
      test(
        "lists the project's and the dev center's catalogs",
        Effect.gen(function* () {
          const { catalogName, taskCatalogName } = yield* stack;
          const body = yield* call("/catalogs");
          expectOk(body);
          // The data plane lists the project's catalogs and its dev center's.
          expect(body.result).toEqual({ names: [catalogName, taskCatalogName].sort() });
          const observed = yield* arm((t) => devcenterArm.ListProjectCatalogs(t));
          expect(observed.value.map((c) => c.name)).toEqual([catalogName]);
        }),
        { timeout: 900_000 },
      );
    });

    describe("DevCenter.GetCatalog", () => {
      test(
        "reads the project catalog",
        Effect.gen(function* () {
          const { catalogName } = yield* stack;
          const body = yield* call(`/catalog?catalog=${catalogName}`);
          expectOk(body);
          expect(body.result).toEqual({ name: catalogName });
        }),
        { timeout: 900_000 },
      );
    });

    // The catalog syncs its definitions after the deploy (about a minute).
    let definition = { catalogName: "", name: "" };

    describe("DevCenter.ListEnvironmentDefinitions", () => {
      test(
        "lists the synced catalog's definitions",
        Effect.gen(function* () {
          const { catalogName } = yield* stack;
          const body = yield* call("/definitions").pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (b) => (b.result?.ids?.length ?? 0) > 0,
              times: 18,
            }),
          );
          expectOk(body);
          const observed = yield* asDeployer((t) =>
            devcenter.ListEnvironmentEnvironmentDefinitionsByProject(t),
          );
          expect(body.result.ids).toEqual(
            observed.value.map((d) => `${d.catalogName}/${d.name}`).sort(),
          );
          const [first] = body.result.ids as string[];
          expect(first?.startsWith(`${catalogName}/`)).toBe(true);
          definition = { catalogName, name: first!.slice(catalogName.length + 1) };
        }),
        { timeout: 600_000 },
      );
    });

    describe("DevCenter.GetEnvironmentDefinition", () => {
      test(
        "reads a synced definition",
        Effect.gen(function* () {
          const body = yield* call(
            `/definition?catalog=${definition.catalogName}&name=${encodeURIComponent(definition.name)}`,
          );
          expectOk(body);
          expect(body.result).toEqual(definition);
        }),
        { timeout: 900_000 },
      );
    });

    describe("DevCenter.ListEnvironmentTypes", () => {
      test(
        "lists the project environment type",
        Effect.gen(function* () {
          const { environmentTypeName } = yield* stack;
          const body = yield* call("/environment-types");
          expectOk(body);
          expect(body.result).toEqual({ types: [`${environmentTypeName}:Enabled`] });
        }),
        { timeout: 900_000 },
      );
    });

    // Dev boxes need a pool on a network connection or a Microsoft-hosted
    // network and bill compute while they run (`Azure.DevCenter.Pool` is
    // skipped for the same reason), so every dev box binding is driven
    // against a dev box that does not exist: each call reaches the data
    // plane with its role and fails with the typed error.
    const devBoxes = Effect.gen(function* () {
      const body = yield* call("/devboxes");
      expectOk(body);
      return body.result as Record<string, unknown>;
    });

    describe("DevCenter.ListDevBoxes", () => {
      test(
        "lists the host's dev boxes (none)",
        Effect.gen(function* () {
          const { principalId } = yield* stack;
          const result = yield* devBoxes;
          // The Function's own dev boxes, read as the project admin.
          const observed = yield* asDeployer((t) =>
            devcenter.ListDevBoxDevBoxesByUser({ ...t, userId: principalId! }),
          );
          expect(observed.value.map((d) => d.name)).toEqual([]);
          expect(result.names).toEqual([]);
        }),
        { timeout: 900_000 },
      );
    });

    for (const [binding, key, tag] of [
      ["GetDevBox", "get", "DevBoxNotFound"],
      ["CreateDevBox", "create", "InvalidPoolName"],
      ["StartDevBox", "start", "DevBoxNotFound"],
      ["StopDevBox", "stop", "DevBoxNotFound"],
      ["RestartDevBox", "restart", "DevBoxNotFound"],
      ["GetRemoteConnection", "remoteConnection", "DevBoxNotFound"],
    ] as const) {
      describe(`DevCenter.${binding}`, () => {
        test(
          `reaches the data plane and fails ${tag} for a missing dev box`,
          Effect.gen(function* () {
            const result = yield* devBoxes;
            expect(result[key]).toEqual(tag);
          }),
          { timeout: 900_000 },
        );
      });
    }

    describe("DevCenter.DeleteDevBox", () => {
      test(
        "succeeds for a dev box that is already gone (delete is idempotent)",
        Effect.gen(function* () {
          const result = yield* devBoxes;
          expect(result.delete).toEqual("none");
        }),
        { timeout: 900_000 },
      );
    });

    // Environments deploy Azure resources into the environment type's
    // subscription; every environment binding is driven against an
    // environment that does not exist.
    const environments = Effect.gen(function* () {
      const { catalogName } = yield* stack;
      const body = yield* call(`/environments?catalog=${catalogName}`);
      expectOk(body);
      return body.result as Record<string, unknown>;
    });

    describe("DevCenter.ListEnvironments", () => {
      test(
        "lists the host's environments (none)",
        Effect.gen(function* () {
          const result = yield* environments;
          const observed = yield* asDeployer((t) => devcenter.ListEnvironmentEnvironments(t));
          expect(observed.value.map((e) => e.name)).toEqual([]);
          expect(result.names).toEqual([]);
        }),
        { timeout: 900_000 },
      );
    });

    for (const [binding, key, tag] of [
      ["GetEnvironment", "get", "EnvironmentNotFound"],
      ["CreateOrReplaceEnvironment", "create", "EnvironmentDefinitionNotFound"],
      ["DeleteEnvironment", "delete", "EnvironmentNotFound"],
    ] as const) {
      describe(`DevCenter.${binding}`, () => {
        test(
          `reaches the data plane and fails ${tag} for a missing environment`,
          Effect.gen(function* () {
            const result = yield* environments;
            expect(result[key]).toEqual(tag);
          }),
          { timeout: 900_000 },
        );
      });
    }

    describe("DevCenter.GetEnvironmentOutputs", () => {
      test(
        "answers no outputs for an environment that does not exist",
        Effect.gen(function* () {
          const result = yield* environments;
          expect(result.outputs).toEqual({});
        }),
        { timeout: 900_000 },
      );
    });

    // Dev box actions, snapshots, customization groups and operations need a
    // dev box (see the gated lifecycle at the end of the file); ungated, every
    // such binding is driven against a dev box that does not exist.
    const devBoxExtras = Effect.gen(function* () {
      const body = yield* call("/devbox-extras");
      expectOk(body);
      return body.result as Record<string, any>;
    });

    /** The Function's own dev box `MISSING`, as the deployer (project admin) sees it. */
    const missingDevBox = (t: { endpoint: string; projectName: string }) =>
      Effect.map(stack, ({ principalId }) => ({
        ...t,
        userId: principalId!,
        devBoxName: MISSING,
      }));

    describe("DevCenter.ListDevBoxActions", () => {
      test(
        "lists no actions for a dev box that does not exist",
        Effect.gen(function* () {
          const result = yield* devBoxExtras;
          const observed = yield* asDeployer((t) =>
            Effect.flatMap(missingDevBox(t), (input) => devcenter.ListDevBoxActions(input)),
          );
          expect(observed.value.map((a) => a.name)).toEqual([]);
          expect(result.actions).toEqual([]);
        }),
        { timeout: 900_000 },
      );
    });

    describe("DevCenter.ListDevBoxSnapshots", () => {
      test(
        "lists no snapshots for a dev box that does not exist",
        Effect.gen(function* () {
          const result = yield* devBoxExtras;
          const observed = yield* asDeployer((t) =>
            Effect.flatMap(missingDevBox(t), (input) => devcenter.ListDevBoxSnapshots(input)),
          );
          expect(observed.value.map((s) => s.snapshotId)).toEqual([]);
          expect(result.snapshots).toEqual([]);
        }),
        { timeout: 900_000 },
      );
    });

    describe("DevCenter.ListDevBoxOperations", () => {
      test(
        "lists no operations for a dev box that does not exist",
        Effect.gen(function* () {
          const result = yield* devBoxExtras;
          const observed = yield* asDeployer((t) =>
            Effect.flatMap(missingDevBox(t), (input) => devcenter.ListDevBoxOperations(input)),
          );
          expect(observed.value.map((o) => o.operationId)).toEqual([]);
          expect(result.operations).toEqual([]);
        }),
        { timeout: 900_000 },
      );
    });

    for (const [binding, key, tag] of [
      ["GetDevBoxAction", "getAction", "DevBoxActionNotFound"],
      ["SkipDevBoxAction", "skipAction", "DevBoxActionNotFound"],
      ["DelayDevBoxAction", "delayAction", "DevBoxActionNotFound"],
      ["DelayDevBoxActions", "delayActions", "DevBoxActionNotFound"],
      ["GetDevBoxSnapshot", "getSnapshot", "DevBoxSnapshotNotFound"],
      ["RepairDevBox", "repair", "DevBoxNotFound"],
      ["ListCustomizationGroups", "listGroups", "DevBoxNotFound"],
      ["GetCustomizationGroup", "getGroup", "CustomizationGroupNotFound"],
      ["CreateCustomizationGroup", "createGroup", "DevBoxNotFound"],
      ["GetCustomizationTaskLog", "taskLog", "DevBoxNotFound"],
      ["GetDevBoxOperation", "getOperation", "DevBoxOperationNotFound"],
    ] as const) {
      describe(`DevCenter.${binding}`, () => {
        test(
          `reaches the data plane and fails ${tag} for a missing dev box`,
          Effect.gen(function* () {
            const result = yield* devBoxExtras;
            expect(result[key]).toEqual(tag);
          }),
          { timeout: 900_000 },
        );
      });
    }

    /** Read an operation status as the deployer. */
    const operationStatus = (operationId: string) =>
      asDeployer((t) => devcenter.GetOperationStatus({ ...t, operationId }));

    const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    /** The Function's snapshots of its missing dev box, read by the deployer. */
    const observedSnapshots = asDeployer((t) =>
      Effect.flatMap(missingDevBox(t), (input) => devcenter.ListDevBoxSnapshots(input)),
    );

    describe("DevCenter.CaptureDevBoxSnapshot", () => {
      test(
        "is accepted (204, no operation) for a dev box that does not exist",
        Effect.gen(function* () {
          const result = yield* devBoxExtras;
          expect(result.capture).toEqual("");
          const observed = yield* observedSnapshots;
          expect(observed.value).toEqual([]);
        }),
        { timeout: 900_000 },
      );
    });

    describe("DevCenter.RestoreDevBoxSnapshot", () => {
      test(
        "is accepted (204, no operation) for a dev box that does not exist",
        Effect.gen(function* () {
          const result = yield* devBoxExtras;
          expect(result.restore).toEqual("");
          const observed = yield* observedSnapshots;
          expect(observed.value).toEqual([]);
        }),
        { timeout: 900_000 },
      );
    });

    // The task catalog syncs its tasks after the deploy (about a minute).
    const customizationTasks = Effect.gen(function* () {
      const { taskCatalogName } = yield* stack;
      const body = yield* call(`/customization-tasks?catalog=${taskCatalogName}`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 seconds"),
          until: (b) => b.ok && b.result?.read !== "none",
          times: 18,
        }),
      );
      expectOk(body);
      return body.result as Record<string, any>;
    });

    describe("DevCenter.ListCustomizationTaskDefinitions", () => {
      test(
        "lists the customization tasks the project offers",
        Effect.gen(function* () {
          const result = yield* customizationTasks;
          const observed = yield* asDeployer((t) =>
            devcenter.ListDevBoxCustomizationTaskDefinitionsByProject(t),
          );
          const { taskCatalogName } = yield* stack;
          expect(result.tasks).toContain(`${taskCatalogName}/winget`);
          expect(result.tasks).toEqual(
            observed.value.map((task) => `${task.catalogName}/${task.name}`).sort(),
          );
        }),
        { timeout: 900_000 },
      );
    });

    describe("DevCenter.GetCustomizationTaskDefinition", () => {
      test(
        "fails CustomizationTaskNotFound for a task the catalog does not publish",
        Effect.gen(function* () {
          const result = yield* customizationTasks;
          expect(result.missing).toEqual("CustomizationTaskNotFound");
        }),
        { timeout: 900_000 },
      );

      // Skipped: the data plane answers 404 with an empty body (typed
      // `CustomizationTaskNotFound`) for every task the project lists from a
      // dev center catalog (`<catalog>/winget`, `choco`, ...), with the task
      // name alone, `<catalog>%2F<task>`, `<catalog>/<task>`, the listed `uri`,
      // and api-versions 2025-02-01 and 2025-04-01-preview (live, 2026-10-26);
      // intrinsic tasks (`__INTRINSIC__`) answer the same. The binding is
      // implemented.
      test.skip(
        "reads a task the project lists",
        Effect.gen(function* () {
          const { taskCatalogName } = yield* stack;
          const result = yield* customizationTasks;
          expect(result.read.startsWith(`${taskCatalogName}/`)).toBe(true);
          expect(result.tasks).toContain(result.read);
        }),
        { timeout: 900_000 },
      );
    });

    describe("DevCenter.ValidateCustomizationTasks", () => {
      test(
        "starts a validation operation the project tracks",
        Effect.gen(function* () {
          const result = yield* customizationTasks;
          expect(result.validation.operationId).toMatch(GUID);
          const observed = yield* operationStatus(result.validation.operationId);
          expect(observed.name).toEqual(result.validation.operationId);
        }),
        { timeout: 900_000 },
      );
    });

    describe("DevCenter.GetOperationStatus", () => {
      test(
        "reads the validation's status; a missing operation fails OperationStatusNotFound",
        Effect.gen(function* () {
          const result = yield* customizationTasks;
          expect(result.validation.statusName).toEqual(result.validation.operationId);
          expect(result.missingStatus).toEqual("OperationStatusNotFound");
        }),
        { timeout: 900_000 },
      );
    });

    describe("DevCenter.GetImagingTaskLog", () => {
      test(
        "reaches the data plane and fails ImageBuildLogNotFound for a missing log",
        Effect.gen(function* () {
          const result = yield* customizationTasks;
          expect(result.imagingLog).toEqual("ImageBuildLogNotFound");
        }),
        { timeout: 900_000 },
      );
    });

    const poolSchedules = Effect.gen(function* () {
      const body = yield* call("/pool-schedules");
      expectOk(body);
      return body.result as Record<string, any>;
    });

    describe("DevCenter.ListSchedulesByPool", () => {
      test(
        "lists no schedules for a pool the project does not have",
        Effect.gen(function* () {
          const result = yield* poolSchedules;
          const observed = yield* asDeployer((t) =>
            devcenter.ListDevBoxSchedulesByPool({ ...t, poolName: MISSING }),
          );
          expect(observed.value.map((s) => s.name)).toEqual([]);
          expect(result.names).toEqual([]);
        }),
        { timeout: 900_000 },
      );
    });

    describe("DevCenter.GetScheduleByPool", () => {
      test(
        "fails DevBoxScheduleNotFound for a pool the project does not have",
        Effect.gen(function* () {
          const result = yield* poolSchedules;
          expect(result.get).toEqual("DevBoxScheduleNotFound");
        }),
        { timeout: 900_000 },
      );
    });

    describe("DevCenter.ListEnvironmentDefinitionsByCatalog", () => {
      test(
        "lists the synced catalog's definitions",
        Effect.gen(function* () {
          const { catalogName } = yield* stack;
          const body = yield* call(`/definitions-by-catalog?catalog=${catalogName}`).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (b) => (b.result?.ids?.length ?? 0) > 0,
              times: 18,
            }),
          );
          expectOk(body);
          const observed = yield* asDeployer((t) =>
            devcenter.ListEnvironmentEnvironmentDefinitionsByCatalog({ ...t, catalogName }),
          );
          expect(body.result.ids.length).toBeGreaterThan(0);
          expect(body.result.ids).toEqual(
            observed.value.map((d) => `${d.catalogName}/${d.name}`).sort(),
          );
        }),
        { timeout: 600_000 },
      );
    });

    // Gated (see `runDevBoxes`): one live dev box drives every dev box
    // binding through its real effect. ~$3/run (an 8 vCPU dev box for about
    // 1.5 h plus a snapshot), ~90 min (provisioning takes 25-65 min; snapshot
    // capture, restore and repair take several minutes each).
    describe.skipIf(!runDevBoxes)("Dev box lifecycle (onboarded tenant)", () => {
      /** Call a `/live` step once (no retry: steps are not idempotent). */
      const live = (query: string) =>
        Effect.gen(function* () {
          const { url } = yield* stack;
          const body = yield* HttpClient.execute(
            HttpClientRequest.get(`${url}/live?${query}`),
          ).pipe(
            Effect.timeout("120 seconds"),
            Effect.flatMap((response) => response.json),
            Effect.map((json) => json as Body),
          );
          expectOk(body);
          return body.result as Record<string, any>;
        });

      /** Repeat a read-only step every 30 s until `done` (at most `times` reads). */
      const poll = (query: string, done: (r: Record<string, any>) => boolean, times: number) =>
        live(query).pipe(
          Effect.repeat({ schedule: Schedule.spaced("30 seconds"), until: done, times }),
        );

      /** Wait for a long-running operation the binding started. */
      const settle = (operationId: string) =>
        poll(
          `step=status&id=${operationId}`,
          (r) => r.status !== "NotStarted" && r.status !== "Running",
          60,
        );

      /** The Function's live dev box, as the deployer sees it. */
      const observedBox = Effect.flatMap(stack, ({ principalId }) =>
        asDeployer((t) =>
          devcenter.GetDevBoxDevBoxByUser({
            ...t,
            userId: principalId!,
            devBoxName: LIVE_DEV_BOX,
          }),
        ),
      );

      test(
        "create, act on, customize, snapshot, restore, repair, and delete a dev box",
        Effect.gen(function* () {
          const { poolName, taskCatalogName, principalId } = yield* stack;
          // Role propagation: the first read retries through 403s.
          yield* call("/project");

          // CreateDevBox + GetDevBox
          expect(yield* live(`step=create&pool=${poolName}`)).toEqual({ name: LIVE_DEV_BOX });
          const provisioned = yield* poll(
            "step=get",
            (r) => r.provisioningState !== "Creating" && r.provisioningState !== "Provisioning",
            140,
          );
          expect(provisioned.provisioningState).toEqual("Succeeded");
          expect((yield* observedBox).provisioningState).toEqual("Succeeded");

          // ListDevBoxActions + GetDevBoxAction + DelayDevBoxAction(s) + SkipDevBoxAction
          const actions = yield* live("step=actions");
          expect(actions.actions).toContain("schedule-default");
          expect(actions.read).toEqual(actions.actions[0]);
          expect(typeof actions.suspendedUntil).toEqual("string");
          expect(actions.delayed).toEqual(
            (actions.actions as string[]).map((name) => `${name}:Succeeded`),
          );
          const observedActions = yield* asDeployer((t) =>
            devcenter.ListDevBoxActions({ ...t, userId: principalId!, devBoxName: LIVE_DEV_BOX }),
          );
          expect(observedActions.value.map((a) => a.name)).toEqual(actions.actions);

          // ListDevBoxOperations + GetDevBoxOperation
          const operations = yield* live("step=operations");
          expect(operations.operations.length).toBeGreaterThan(0);
          expect(operations.read).toEqual(operations.operations[0]);

          // CreateCustomizationGroup + GetCustomizationGroup + ListCustomizationGroups
          // + GetCustomizationTaskLog
          expect(yield* live(`step=customize&catalog=${taskCatalogName}`)).toEqual({
            name: "alchemy",
          });
          const group = yield* poll(
            "step=group",
            (r) => r.status !== "NotStarted" && r.status !== "Running",
            40,
          );
          expect(group).toEqual({ status: "Succeeded", groups: ["alchemy"], log: true });
          const observedGroup = yield* asDeployer((t) =>
            devcenter.GetDevBoxCustomizationGroup({
              ...t,
              userId: principalId!,
              devBoxName: LIVE_DEV_BOX,
              customizationGroupName: "alchemy",
            }),
          );
          expect(observedGroup.status).toEqual("Succeeded");

          // CaptureDevBoxSnapshot + GetOperationStatus + ListDevBoxSnapshots + GetDevBoxSnapshot
          const capture = yield* live("step=capture");
          expect(capture.operationId).toMatch(GUID);
          expect((yield* settle(capture.operationId)).status).toEqual("Succeeded");
          const snapshots = yield* live("step=snapshots");
          expect(snapshots.snapshots.length).toBeGreaterThan(0);
          expect(snapshots.read).toEqual(snapshots.snapshots[0]);
          const observedSnapshots = yield* asDeployer((t) =>
            devcenter.ListDevBoxSnapshots({ ...t, userId: principalId!, devBoxName: LIVE_DEV_BOX }),
          );
          expect(observedSnapshots.value.map((x) => x.snapshotId)).toEqual(snapshots.snapshots);

          // RestoreDevBoxSnapshot
          const restore = yield* live(`step=restore&id=${snapshots.snapshots[0]}`);
          expect((yield* settle(restore.operationId)).status).toEqual("Succeeded");

          // RepairDevBox
          const repair = yield* live("step=repair");
          expect((yield* settle(repair.operationId)).status).toEqual("Succeeded");

          // DeleteDevBox
          expect(yield* live("step=delete")).toEqual({ deleted: true });
          expect(yield* poll("step=get", (r) => r.gone === true, 40)).toEqual({ gone: true });
          const missing = yield* observedBox.pipe(Effect.flip);
          expect(missing._tag).toEqual("DevBoxNotFound");
        }).pipe(
          // A failed step must not leave a billed dev box (or block the pool's delete).
          Effect.ensuring(
            live("step=delete").pipe(
              Effect.andThen(poll("step=get", (r) => r.gone === true, 40)),
              Effect.ignore,
            ),
          ),
        ),
        { timeout: 7_200_000 },
      );
    });

    describe("AzureBindings.Bind least privilege", () => {
      test(
        "assigns exactly each binding's permissions, scoped to the bound project",
        Effect.gen(function* () {
          const outputs = yield* stack;
          expect(outputs.principalId).toMatch(/^[0-9a-f-]{36}$/);
          const grants = yield* grantsOf(outputs.principalId!).pipe(Effect.provide(azure));
          const project = outputs.projectId.toLowerCase();
          expect(grants).toEqual(
            [
              "catalogs/environmentDefinitions/read+catalogs/read+environmentTypes/read+read+users/environments/userWrite/action",
              "catalogs/environmentDefinitions/read+read",
              "catalogs/imageDefinitions/builds/read+read",
              "catalogs/read+read+users/devboxes/userCustomize/action",
              "catalogs/read+read",
              "environmentTypes/read+read",
              "pools/read+read",
              "pools/read+read+users/devboxes/userWrite/action",
              "pools/schedules/read+read",
              "read",
              "read+users/devboxes/userActionManage/action",
              "read+users/devboxes/userActionRead/action",
              "read+users/devboxes/userDelete/action",
              "read+users/devboxes/userGetRemoteConnection/action",
              "read+users/devboxes/userRead/action",
              "read+users/devboxes/userStart/action",
              "read+users/devboxes/userStart/action+users/devboxes/userStop/action",
              "read+users/devboxes/userStop/action",
              "read+users/devboxes/userWrite/action",
              "read+users/environments/userDelete/action",
              "read+users/environments/userOutputsRead/action",
              "read+users/environments/userRead/action",
            ]
              .map((p) => `${p} ${project}`)
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
  { timeout: 1_200_000 },
);
