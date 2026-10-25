import * as Azure from "@alchemy.run/azure";
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
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { runExpensive } from "../gates.ts";
import DevTestLabsFunction, { LabVm } from "./fixtures/function.ts";
import { tags } from "./util.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: Azure.providers(),
  state: Alchemy.localState(),
});

const Stack = Alchemy.Stack(
  "AzureDevTestLabsBindings",
  { providers: Azure.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const fn = yield* DevTestLabsFunction;
    const vm = yield* LabVm;
    return {
      url: fn.url,
      principalId: fn.principalId,
      hostStorageAccount: fn.storageAccountName,
      vmId: vm.virtualMachineId,
      computeId: vm.computeId,
    };
  }),
);

// ~$0.10/run, 30 min: one 2-vCPU lab VM (~$0.10/hour) for ~30 minutes
// (create ~5, stop/start/restart/redeploy ~15, delete ~5) plus a Flex
// Consumption app. Gated like the lab VM's own suite.
const stack = runExpensive ? beforeAll(deploy(Stack), { timeout: 1_800_000 }) : undefined;
if (runExpensive) afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(Stack));

/** Deployer credentials and environment for out-of-band checks and hooks. */
const azure = Layer.mergeAll(Azure.environmentFromAuthProvider(), Azure.fromAuthProvider()).pipe(
  Layer.provideMerge(Azure.AzureAuth),
  Layer.provideMerge(ProfileStoreLive),
  Layer.provideMerge(CredentialsStoreLive),
  Layer.provideMerge(FetchHttpClient.layer),
);

type Body = { ok: boolean; result?: unknown; error?: string };

/**
 * Call a binding route until it answers `ok`, through the Flex Consumption
 * cold start and role propagation, then return the last answer so a real
 * failure shows its ARM error.
 */
const call = (route: string) =>
  Effect.gen(function* () {
    const { url } = yield* stack!;
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

/** The lab VM's compute power state, e.g. `PowerState/running` (deployer credentials). */
const powerState = Effect.gen(function* () {
  const { computeId } = yield* stack!;
  const parts = (computeId ?? "").split("/");
  const vm = yield* compute.GetVirtualMachine({
    subscriptionId: parts[2] ?? "",
    resourceGroupName: parts[4] ?? "",
    vmName: parts[8] ?? "",
    _expand: "instanceView",
  });
  return vm.properties?.instanceView?.statuses?.find((s) => s.code?.startsWith("PowerState/"))
    ?.code;
}).pipe(Effect.provide(azure));

/** Poll the power state until it is `state` (VM operations take minutes). */
const untilPowerState = (state: string) =>
  powerState.pipe(
    Effect.repeat({
      schedule: Schedule.spaced("15 seconds"),
      until: (observed) => observed === state,
      times: 40,
    }),
  );

/** Every role on the Function's identity as `<actions> <scope>`, without its host-storage grants. */
const grantsOf = (principalId: string, hostStorageAccount: string | undefined) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    const assignments = yield* Stream.runCollect(
      authorization.ListRoleAssignmentForSubscription.items({
        subscriptionId,
        _filter: `principalId eq '${principalId}'`,
      }),
    );
    const host = `/storageaccounts/${(hostStorageAccount ?? "").toLowerCase()}`;
    const grants: string[] = [];
    for (const assignment of assignments) {
      const scope = assignment.properties?.scope?.toLowerCase() ?? "";
      if (scope.endsWith(host)) continue;
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
  }).pipe(Effect.provide(azure));

// Sequential: every binding acts on the one lab VM, in this order.
describe.skipIf(!runExpensive)(
  "Azure DevTest Labs bindings on an Azure Function",
  { tags, sequential: true },
  () => {
    test(
      "each binding grants exactly its action on the lab VM",
      Effect.gen(function* () {
        const { principalId, hostStorageAccount, vmId } = yield* stack!;
        const actions = "Microsoft.DevTestLab/labs/virtualMachines";
        const expected = ["Start", "Stop", "Restart", "Redeploy"]
          .map((action) => `${actions}/${action}/action ${vmId.toLowerCase()}`)
          .sort();
        // Role-assignment lists trail the deploy by a few seconds.
        const grants = yield* grantsOf(principalId ?? "", hostStorageAccount).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 seconds"),
            until: (grants) => grants.length >= expected.length,
            times: 24,
          }),
        );
        expect(grants).toEqual(expected);
      }),
      { timeout: 600_000 },
    );

    describe("DevTestLabs.StopVirtualMachine", () => {
      test(
        "stops the bound lab VM",
        Effect.gen(function* () {
          expectOk(yield* call("/stop"));
          expect(yield* untilPowerState("PowerState/deallocated")).toEqual(
            "PowerState/deallocated",
          );
        }),
        { timeout: 900_000 },
      );
    });

    describe("DevTestLabs.StartVirtualMachine", () => {
      test(
        "starts the bound lab VM",
        Effect.gen(function* () {
          expectOk(yield* call("/start"));
          expect(yield* untilPowerState("PowerState/running")).toEqual("PowerState/running");
        }),
        { timeout: 900_000 },
      );
    });

    describe("DevTestLabs.RestartVirtualMachine", () => {
      test(
        "restarts the bound lab VM",
        Effect.gen(function* () {
          expectOk(yield* call("/restart"));
          expect(yield* untilPowerState("PowerState/running")).toEqual("PowerState/running");
        }),
        { timeout: 900_000 },
      );
    });

    describe("DevTestLabs.RedeployVirtualMachine", () => {
      test(
        "redeploys the bound lab VM",
        Effect.gen(function* () {
          expectOk(yield* call("/redeploy"));
          expect(yield* untilPowerState("PowerState/running")).toEqual("PowerState/running");
        }),
        { timeout: 900_000 },
      );
    });
  },
);
