import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as kusto from "@distilled.cloud/azure/azure_kusto";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { devCluster, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getImage = (
  resourceGroupName: string,
  clusterName: string,
  sandboxCustomImageName: string,
) =>
  Effect.gen(function* () {
    return yield* kusto.GetSandboxCustomImage({
      subscriptionId: yield* subscription,
      resourceGroupName,
      clusterName,
      sandboxCustomImageName,
    });
  });

const program = (props: { requirements: string }) =>
  Effect.gen(function* () {
    const { group, cluster } = yield* devCluster({
      // Sandboxes need nested virtualization, which the Dev E2a_v4 SKU
      // lacks: the cheapest supported option is 2 x Standard_E2ads_v5.
      sku: { name: "Standard_E2ads_v5", tier: "Standard", capacity: 2 },
      languageExtensions: [{ name: "PYTHON", imageName: "Python3_10_8" }],
    });
    const image = yield* Azure.Kusto.SandboxCustomImage("Image", {
      resourceGroup: group.resourceGroupName,
      cluster: cluster.clusterName,
      languageVersion: "3.10.8",
      requirementsFileContent: props.requirements,
    });
    return { group, cluster, image };
  });

// Needs a 2-node Standard_E2ads_v5 Kusto cluster with the Python extension
// (~$0.80/hour, 10-20 minutes to create plus up to an hour to enable the
// extension) and two image builds: ~$1.50 per run, up to ~2 hours.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a Kusto sandbox custom image",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, cluster, image } = yield* stack.deploy(
        program({ requirements: "six" }),
      );
      const get = () =>
        getImage(
          group.resourceGroupName,
          cluster.clusterName,
          image.sandboxCustomImageName,
        );
      const observed = yield* get();
      expect(observed.properties?.language?.toLowerCase()).toEqual("python");
      expect(observed.properties?.languageVersion).toEqual("3.10.8");
      expect(observed.properties?.requirementsFileContent).toEqual("six");

      // In place: new requirements rebuild the image. Pinned versions
      // (`six==1.16.0`) make Azure fail the build with a bare "Internal
      // Server Error", so the test uses unpinned packages.
      const updated = yield* stack.deploy(
        program({ requirements: "six\nidna" }),
      );
      expect(updated.image.sandboxCustomImageId).toEqual(
        image.sandboxCustomImageId,
      );
      expect((yield* get()).properties?.requirementsFileContent).toEqual(
        "six\nidna",
      );

      yield* stack.destroy();
      expect(yield* waitGone(get(), 60)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 10_800_000 },
);
