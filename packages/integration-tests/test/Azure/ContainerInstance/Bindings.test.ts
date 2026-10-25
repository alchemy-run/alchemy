import * as Azure from "@alchemy.run/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as aci from "@distilled.cloud/azure/containerinstance";
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
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import AciFunction, { Worker } from "./fixtures/function.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureContainerInstanceBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* AciFunction;
    const worker = yield* Worker;
    return {
      url: fn.url,
      principalId: fn.principalId,
      groupName: worker.containerGroupName,
      groupId: worker.containerGroupId,
      resourceGroup: worker.resourceGroup,
    };
  }),
);

// 0.5 vCPU / 0.5 GB container group (~$0.03/hour) + Flex Consumption
// (~$0.01/run); ~5 min deploy.
const stack = beforeAll(deploy(Stack), { timeout: 900_000 });

/** Deployer credentials and environment for out-of-band checks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: unknown; error?: string };

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

/** The bound group, read as the deployer. */
const getGroup = Effect.gen(function* () {
  const { groupName, resourceGroup } = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current;
  return yield* aci.GetContainerGroup({
    subscriptionId,
    resourceGroupName: resourceGroup,
    containerGroupName: groupName,
  });
}).pipe(Effect.provide(azure));

const groupState = (group: aci.GetContainerGroupResponse) => group.properties.instanceView?.state;

const containerStart = (group: aci.GetContainerGroupResponse) =>
  group.properties.containers[0]?.properties.instanceView?.currentState?.startTime;

/** Read the group until `until` holds (bounded: about 5 minutes). */
const groupUntil = (until: (group: aci.GetContainerGroupResponse) => boolean) =>
  getGroup.pipe(Effect.repeat({ schedule: Schedule.spaced("10 seconds"), until, times: 30 }));

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

/** Every role on the Function's identity as `<actions> <scope>`. */
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
        .sort()
        .join("+");
      grants.push(`${actions} ${scope}`);
    }
    return grants.sort();
  });

describe.sequential(
  "Container Instances runtime-action bindings on an Azure Function",
  { tags: ["provider:azure", "live"] },
  () => {
    describe("ContainerInstance.StopContainerGroup", () => {
      test(
        "stops the running group",
        Effect.gen(function* () {
          const running = yield* groupUntil((group) => groupState(group) === "Running");
          expect(groupState(running)).toEqual("Running");
          const body = yield* call("/stop");
          expectOk(body);
          const stopped = yield* groupUntil((group) => groupState(group) === "Stopped");
          expect(groupState(stopped)).toEqual("Stopped");
        }),
        { timeout: 900_000 },
      );
    });

    describe("ContainerInstance.StartContainerGroup", () => {
      test(
        "starts the stopped group",
        Effect.gen(function* () {
          const body = yield* call("/start");
          expectOk(body);
          const running = yield* groupUntil((group) => groupState(group) === "Running");
          expect(groupState(running)).toEqual("Running");
        }),
        { timeout: 600_000 },
      );
    });

    describe("ContainerInstance.RestartContainerGroup", () => {
      test(
        "restarts the containers in place",
        Effect.gen(function* () {
          const before = yield* groupUntil(
            (group) => groupState(group) === "Running" && containerStart(group) !== undefined,
          );
          const startedAt = containerStart(before);
          expect(startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
          const body = yield* call("/restart");
          expectOk(body);
          const after = yield* groupUntil(
            (group) =>
              groupState(group) === "Running" &&
              containerStart(group) !== undefined &&
              containerStart(group) !== startedAt,
          );
          expect(Date.parse(containerStart(after)!)).toBeGreaterThan(Date.parse(startedAt!));
        }),
        { timeout: 600_000 },
      );
    });

    describe("least privilege", () => {
      test(
        "each binding is one custom role with its one action, on the group only",
        Effect.gen(function* () {
          const outputs = yield* stack;
          const group = outputs.groupId.toLowerCase();
          const expected = [
            `Microsoft.ContainerInstance/containerGroups/restart/action ${group}`,
            `Microsoft.ContainerInstance/containerGroups/start/action ${group}`,
            `Microsoft.ContainerInstance/containerGroups/stop/action ${group}`,
          ].sort();
          // The filtered assignment list can trail the assignments by seconds.
          const grants = yield* grantsOf(outputs.principalId!).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("5 seconds"),
              until: (listed) => listed.length >= expected.length,
              times: 12,
            }),
            Effect.provide(azure),
          );
          expect(grants).toEqual(expected);
        }),
        { timeout: 120_000 },
      );
    });
  },
);

// Destroy, then prove (the assignment list trails deletes by a minute or more) the group and every role assigned to the Function's identity are gone.
afterAll.skipIf(!!process.env.NO_DESTROY)(
  Effect.gen(function* () {
    // A failed deploy yields no outputs; destroy still cleans up what it created.
    const outputs = yield* stack;
    yield* destroy(Stack);
    const principalId = outputs?.principalId;
    expect(principalId).toMatch(/^[0-9a-f-]{36}$/);
    const remaining = yield* assignmentsOf(principalId!).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("10 seconds"),
        until: (assignments) => assignments.length === 0,
        times: 24,
      }),
    );
    expect(remaining.map((a) => a.properties?.scope)).toEqual([]);
    const group = yield* getGroup.pipe(
      Effect.as("found" as const),
      Effect.catchTag(["ResourceNotFound", "ResourceGroupNotFound"], () =>
        Effect.succeed("gone" as const),
      ),
      Effect.repeat({
        schedule: Schedule.spaced("5 seconds"),
        until: (status) => status === "gone",
        times: 12,
      }),
    );
    expect(group).toEqual("gone");
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
