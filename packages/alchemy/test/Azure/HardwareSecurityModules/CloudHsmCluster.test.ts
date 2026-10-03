import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import type { AzureOpError } from "@distilled.cloud/azure";
import * as hsm from "@distilled.cloud/azure/hardwaresecuritymodules";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runPaidOnly } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const tags = [
  "provider:azure",
  "provider:azure:hardwaresecuritymodules",
  "live",
];

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const subscription = Effect.map(
  Azure.AzureEnvironment.current,
  (env) => env.subscriptionId,
);

const getCluster = (resourceGroupName: string, cloudHsmClusterName: string) =>
  Effect.gen(function* () {
    return yield* hsm.GetCloudHsmCluster({
      subscriptionId: yield* subscription,
      resourceGroupName,
      cloudHsmClusterName,
    });
  });

/** Poll an out-of-band GET until it reports a typed not-found. */
const waitGone = <A, R>(get: Effect.Effect<A, AzureOpError, R>) =>
  get.pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("30 seconds"),
      until: (status) => status === "gone",
      times: 60,
    }),
  );

const program = (props: { env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const cluster = yield* Azure.HardwareSecurityModules.CloudHsmCluster(
      "Cluster",
      {
        resourceGroup: group.resourceGroupName,
        tags: { env: props.env },
      },
    );
    return { group, cluster };
  });

// Cloud HSM bills ~3 HSM partitions per cluster (several $/hour, billed per
// started hour) and takes ~20-30 minutes to provision and again to delete:
// roughly $10-15 per run. Free-trial subscriptions are not eligible.
test.provider.skipIf(!runPaidOnly)(
  "create, update tags, and delete a cloud hsm cluster",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster } = yield* stack.deploy(program({ env: "a" }));
      const get = () =>
        getCluster(group.resourceGroupName, cluster.cloudHsmClusterName);
      const observed = yield* get();
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.sku?.name).toEqual("Standard_B1");
      expect(observed.tags?.env).toEqual("a");
      expect(cluster.tags).toEqual({ env: "a" });

      // In-place: tags are patched.
      const updated = yield* stack.deploy(program({ env: "b" }));
      expect(updated.cluster.cloudHsmClusterId).toEqual(
        cluster.cloudHsmClusterId,
      );
      const reobserved = yield* get();
      expect(reobserved.tags?.env).toEqual("b");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 3_600_000 },
);

// Ungated probe (free): a missing cluster surfaces as a typed not-found,
// which the provider's read and delete treat as "absent". An invalid-SKU PUT
// is rejected by validation before any entitlement check, so the trial's
// entitlement error cannot be probed without risking a billed cluster.
test.provider(
  "a missing cloud hsm cluster is a typed not-found",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(
        subscriptionId,
        "Microsoft.HardwareSecurityModules",
      );
      const getError = yield* hsm
        .GetCloudHsmCluster({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          cloudHsmClusterName: "probe-missing",
        })
        .pipe(Effect.flip);
      expect(getError._tag).toEqual("ResourceNotFound");
      // The trial cannot create a cluster (dedicated hardware, billed per
      // HSM), so the subscription must hold no Alchemy-owned clusters.
      const page = yield* hsm.ListCloudHsmClusterBySubscription({
        subscriptionId,
      });
      expect(
        (page.value ?? []).filter((c) => c.tags?.["alchemy::stack"]),
      ).toEqual([]);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
