import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm.ts";
import * as hybridcompute from "@distilled.cloud/azure/hybridcompute";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

export const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

export const tags = ["provider:azure", "provider:azure:azurestackhci", "live"];

export const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

/** Poll an out-of-band GET until it reports a typed not-found. */
export const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("5 seconds"),
      until: (status) => status === "gone",
      times: 48,
    }),
  );

/** Arc custom location of an Azure Local cluster (paid-only tests). */
export const customLocationId = () =>
  process.env.AZURE_TEST_HCI_CUSTOM_LOCATION ?? "";

/** ARM ID of a custom location that does not exist (probes). */
export const missingCustomLocation = (
  subscriptionId: string,
  resourceGroupName: string,
) =>
  `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.ExtendedLocation/customLocations/missing`;

/** Arc-enabled server running Azure Local's OS (paid-only tests). */
export const arcMachineId = () => process.env.AZURE_TEST_HCI_ARC_MACHINE ?? "";

/**
 * Create a bare Arc-enabled server record (`Microsoft.HybridCompute/machines`,
 * kind `HCI`) out of band for a probe, run `use` with its ID, and delete the
 * record afterwards. No agent ever connects to it, so it reports no OS.
 */
export const withArcMachineRecord = <A, E, R>(
  resourceGroupName: string,
  use: (machineId: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    yield* ensureRegistered(subscriptionId, "Microsoft.HybridCompute");
    const where = { subscriptionId, resourceGroupName, machineName: "probe" };
    return yield* Effect.acquireUseRelease(
      hybridcompute.MachinesCreateOrUpdate({
        ...where,
        location: "eastus",
        kind: "HCI",
      }),
      (machine) => use(machine.id ?? ""),
      () =>
        hybridcompute
          .DeleteMachine(where)
          .pipe(
            Effect.ignore,
            Effect.andThen(
              waitGone(hybridcompute.GetMachine(where)).pipe(Effect.ignore),
            ),
          ),
    );
  });
