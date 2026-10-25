import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as devcenterArm from "@distilled.cloud/azure/devcenter";
import * as devcenter from "@distilled.cloud/azure/devcenter-data";
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
import DcBindingsFunction, {
  Catalog,
  DESCRIPTION,
  Project,
  ProjectEnvironmentType,
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

const Stack = Alchemy.Stack(
  "AzureDevCenterBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* DcBindingsFunction;
    const project = yield* Project;
    const catalog = yield* Catalog;
    const environmentType = yield* ProjectEnvironmentType;
    // Lets the deployer read every user's dev boxes and environments.
    const deployer = yield* callerObjectId;
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
const EXPECTED_GRANTS = 17;

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
        "lists the project catalog",
        Effect.gen(function* () {
          const { catalogName } = yield* stack;
          const body = yield* call("/catalogs");
          expectOk(body);
          expect(body.result).toEqual({ names: [catalogName] });
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
              "catalogs/read+read",
              "environmentTypes/read+read",
              "pools/read+read",
              "pools/read+read+users/devboxes/userWrite/action",
              "pools/schedules/read+read",
              "read",
              "read+users/devboxes/userDelete/action",
              "read+users/devboxes/userGetRemoteConnection/action",
              "read+users/devboxes/userRead/action",
              "read+users/devboxes/userStart/action",
              "read+users/devboxes/userStart/action+users/devboxes/userStop/action",
              "read+users/devboxes/userStop/action",
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
