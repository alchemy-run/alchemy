import * as Azure from "@alchemy.run/azure";
import { Credentials } from "@distilled.cloud/azure";
import * as authorization from "@distilled.cloud/azure/authorization";
import * as compute from "@distilled.cloud/azure/compute";
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
import { withVcpus } from "../gates.ts";
import ComputeFunction, { RUN_COMMAND_TOKEN, ScaleSet, Vm } from "./fixtures/function.ts";
import { untilGone } from "./helpers.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureComputeBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* ComputeFunction;
    const vm = yield* Vm;
    const scaleSet = yield* ScaleSet;
    return {
      url: fn.url,
      principalId: fn.principalId,
      vmName: vm.virtualMachineName,
      vmId: vm.virtualMachineId,
      scaleSetName: scaleSet.virtualMachineScaleSetName,
      scaleSetId: scaleSet.virtualMachineScaleSetId,
      resourceGroup: vm.resourceGroup,
    };
  }),
);

// Two 1-vCPU F-series v7 VMs (~$0.04/hour each) for ~30 minutes + Flex
// Consumption: about $0.05 per run; ~6 min deploy.
const stack = beforeAll(deploy(Stack).pipe(withVcpus(2)), { timeout: 900_000 });

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
 * answer so a real failure shows its Azure error. A VM busy with an earlier
 * operation answers `OperationNotAllowed` until it finishes.
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

type Statuses = { code?: string; time?: string }[] | undefined;

const powerState = (statuses: Statuses) =>
  statuses?.find((s) => s.code?.startsWith("PowerState/"))?.code;

/** When the last operation on the VM finished (`ProvisioningState/succeeded`). */
const succeededAt = (statuses: Statuses) => {
  const time = statuses?.find((s) => s.code === "ProvisioningState/succeeded")?.time;
  return time === undefined ? undefined : Date.parse(time);
};

/** The VM's instance view, read as the deployer. */
const vmView = Effect.gen(function* () {
  const { vmName, resourceGroup } = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current;
  return yield* compute.VirtualMachinesInstanceView({
    subscriptionId,
    resourceGroupName: resourceGroup,
    vmName,
  });
}).pipe(Effect.provide(azure));

/** The scale set's instance `"0"` instance view, read as the deployer. */
const vmssView = Effect.gen(function* () {
  const { scaleSetName, resourceGroup } = yield* stack;
  const { subscriptionId } = yield* Azure.AzureEnvironment.current;
  return yield* compute.GetVirtualMachineScaleSetVMInstanceView({
    subscriptionId,
    resourceGroupName: resourceGroup,
    vmScaleSetName: scaleSetName,
    instanceId: "0",
  });
}).pipe(Effect.provide(azure));

/** Read an instance view until `until` holds (bounded: about 10 minutes). */
const viewUntil = <A extends { statuses?: Statuses }, R>(
  view: Effect.Effect<A, unknown, R>,
  until: (view: A) => boolean,
) => view.pipe(Effect.repeat({ schedule: Schedule.spaced("10 seconds"), until, times: 60 }));

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

/**
 * The result of a run command, read from its status monitor as the deployer
 * (`undefined` while it is still running).
 */
const runCommandResult = (location: string) =>
  Effect.gen(function* () {
    const config = yield* yield* Credentials;
    // `bearerToken` is the ARM token.
    const token = config.bearerToken;
    const response = yield* HttpClient.execute(
      HttpClientRequest.get(location).pipe(HttpClientRequest.bearerToken(Redacted.value(token))),
    );
    if (response.status === 202) return undefined;
    return (yield* response.json) as {
      value?: { code?: string; message?: string }[];
    };
  }).pipe(Effect.provide(azure));

/** Assert an operation route ran: the instance's last operation finished after `before`. */
const expectNewOperation = <A extends { statuses?: Statuses }, R>(
  view: Effect.Effect<A, unknown, R>,
  route: string,
) =>
  Effect.gen(function* () {
    const initial = yield* viewUntil(
      view,
      (v) =>
        powerState(v.statuses) === "PowerState/running" && succeededAt(v.statuses) !== undefined,
    );
    const before = succeededAt(initial.statuses)!;
    expectOk(yield* call(route));
    const after = yield* viewUntil(
      view,
      (v) =>
        powerState(v.statuses) === "PowerState/running" && (succeededAt(v.statuses) ?? 0) > before,
    );
    expect(succeededAt(after.statuses)!).toBeGreaterThan(before);
  });

/** Assert a route moves the instance to `state`. */
const expectPowerState = <A extends { statuses?: Statuses }, R>(
  view: Effect.Effect<A, unknown, R>,
  route: string,
  state: string,
) =>
  Effect.gen(function* () {
    expectOk(yield* call(route));
    const after = yield* viewUntil(view, (v) => powerState(v.statuses) === state);
    expect(powerState(after.statuses)).toEqual(state);
  });

describe.sequential(
  "Compute runtime-action bindings on an Azure Function",
  { tags: ["provider:azure", "live"] },
  () => {
    describe("Compute.PowerOffVirtualMachine", () => {
      test(
        "powers off the running VM",
        Effect.gen(function* () {
          yield* viewUntil(vmView, (v) => powerState(v.statuses) === "PowerState/running");
          yield* expectPowerState(vmView, "/vm/power-off", "PowerState/stopped");
        }),
        { timeout: 900_000 },
      );
    });

    describe("Compute.StartVirtualMachine", () => {
      test("starts the stopped VM", expectPowerState(vmView, "/vm/start", "PowerState/running"), {
        timeout: 900_000,
      });
    });

    describe("Compute.RestartVirtualMachine", () => {
      test("restarts the VM", expectNewOperation(vmView, "/vm/restart"), { timeout: 900_000 });
    });

    describe("Compute.RunVirtualMachineCommand", () => {
      test(
        "runs a shell script through the VM agent",
        Effect.gen(function* () {
          const body = yield* call("/vm/run-command");
          expectOk(body);
          // The 202's status monitor carries the script's output once it finishes.
          const { location } = body.result as { location?: string };
          expect(location).toMatch(/^https:\/\/management\.azure\.com\//);
          const result = yield* runCommandResult(location!).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("10 seconds"),
              until: (r) => r !== undefined,
              times: 30,
            }),
          );
          // Linux reports `Enable succeeded: [stdout] … [stderr] …` in one status.
          const status = result?.value?.[0];
          expect({ code: status?.code, message: status?.message }).toEqual({
            code: "ProvisioningState/succeeded",
            message: `Enable succeeded: \n[stdout]\n${RUN_COMMAND_TOKEN}\n\n[stderr]\n`,
          });
        }),
        { timeout: 900_000 },
      );
    });

    describe("Compute.RedeployVirtualMachine", () => {
      test("redeploys the VM to a new host", expectNewOperation(vmView, "/vm/redeploy"), {
        timeout: 900_000,
      });
    });

    describe("Compute.DeallocateVirtualMachine", () => {
      test(
        "deallocates the VM",
        expectPowerState(vmView, "/vm/deallocate", "PowerState/deallocated"),
        { timeout: 900_000 },
      );
    });

    describe("Compute.PowerOffVirtualMachineScaleSet", () => {
      test(
        "powers off the scale set's instance",
        Effect.gen(function* () {
          yield* viewUntil(vmssView, (v) => powerState(v.statuses) === "PowerState/running");
          yield* expectPowerState(vmssView, "/vmss/power-off", "PowerState/stopped");
        }),
        { timeout: 900_000 },
      );
    });

    describe("Compute.StartVirtualMachineScaleSet", () => {
      test(
        "starts the scale set's instance",
        expectPowerState(vmssView, "/vmss/start", "PowerState/running"),
        { timeout: 900_000 },
      );
    });

    describe("Compute.RestartVirtualMachineScaleSet", () => {
      test("restarts the scale set's instance", expectNewOperation(vmssView, "/vmss/restart"), {
        timeout: 900_000,
      });
    });

    describe("Compute.RedeployVirtualMachineScaleSet", () => {
      test("redeploys the scale set's instance", expectNewOperation(vmssView, "/vmss/redeploy"), {
        timeout: 900_000,
      });
    });

    describe("Compute.DeallocateVirtualMachineScaleSet", () => {
      test(
        "deallocates the scale set's instance",
        expectPowerState(vmssView, "/vmss/deallocate", "PowerState/deallocated"),
        { timeout: 900_000 },
      );
    });

    describe("least privilege", () => {
      test(
        "each binding is one custom role with its one action, on its VM or scale set only",
        Effect.gen(function* () {
          const outputs = yield* stack;
          const vm = outputs.vmId.toLowerCase();
          const vmss = outputs.scaleSetId.toLowerCase();
          const vmActions = [
            "deallocate",
            "powerOff",
            "redeploy",
            "restart",
            "runCommand",
            "start",
          ];
          const vmssActions = ["deallocate", "powerOff", "redeploy", "restart", "start"];
          const expected = [
            ...vmActions.map((a) => `Microsoft.Compute/virtualMachines/${a}/action ${vm}`),
            ...vmssActions.map(
              (a) => `Microsoft.Compute/virtualMachineScaleSets/${a}/action ${vmss}`,
            ),
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

// Destroy, then prove (the assignment list trails deletes by a minute or more) the VMs and every role assigned to the Function's identity are gone.
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
    const { vmName, scaleSetName, resourceGroup } = yield* stack;
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    expect(
      yield* untilGone(
        compute.GetVirtualMachine({ subscriptionId, resourceGroupName: resourceGroup, vmName }),
      ),
    ).toEqual("gone");
    expect(
      yield* untilGone(
        compute.GetVirtualMachineScaleSet({
          subscriptionId,
          resourceGroupName: resourceGroup,
          vmScaleSetName: scaleSetName,
        }),
      ),
    ).toEqual("gone");
  }).pipe(Effect.provide(azure)),
  { timeout: 900_000 },
);
