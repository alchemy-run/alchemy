import * as AWS from "@alchemy.run/aws";
import { Network } from "@alchemy.run/aws/EC2/Network";
import { Addon, Cluster } from "@alchemy.run/aws/EKS";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as eks from "@distilled.cloud/aws/eks";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated probe: `list()` enumerates every cluster, lists each cluster's
// add-ons, then hydrates each via `describeAddon`. It requires no deployed
// resource — in a clean account/region it returns `[]`, otherwise a
// well-formed array of full Add-on Attributes. This proves the enumeration
// wiring (listClusters -> listAddons -> describeAddon) compiles and runs live
// without needing a ~10-minute cluster create.
test.provider(
  "list returns a well-formed array of add-ons",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(Addon);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const addon of all) {
        expect(typeof addon.addonArn).toBe("string");
        expect(typeof addon.addonName).toBe("string");
        expect(typeof addon.clusterName).toBe("string");
      }
    }),
  { tags: ["provider:aws", "provider:aws:eks", "live"] },
);

// Full deploy test: an EKS cluster takes ~10+ minutes to provision, which is
// far too heavy for CI. Gate the deploy behind a pre-existing cluster supplied
// via AWS_TEST_EKS_CLUSTER; an entitled account with a standing cluster runs
// this unchanged. Deploys `metrics-server`, asserts it appears in the
// exhaustively-paginated `list()`, then tears down.
test.provider.skipIf(!process.env.AWS_TEST_EKS_CLUSTER)(
  "list enumerates the deployed add-on",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const clusterName = process.env.AWS_TEST_EKS_CLUSTER!;

      const addon = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Addon("ListAddon", {
            clusterName,
            addonName: "metrics-server",
          });
        }),
      );

      const provider = yield* Provider.findProvider(Addon);
      const all = yield* provider.list();

      expect(
        all.some((a) => a.clusterName === addon.clusterName && a.addonName === addon.addonName),
      ).toBe(true);

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:eks", "live"], timeout: 600_000 },
);

// Regression: every update sent the same clientRequestToken, so EKS answered
// the second update as a retry of the first and left the add-on unchanged.
// Provisions its own Auto Mode cluster (~10 min create, ~5 min delete), so it
// skips under `--fast`.
test.provider.skipIf(!!process.env.FAST)(
  "applies every configurationValues update",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (replicas: number) =>
        stack.deploy(
          Effect.gen(function* () {
            const network = yield* Network("AddonNetwork", {
              cidrBlock: "10.86.0.0/16",
              availabilityZones: 2,
            });
            const cluster = yield* Cluster("AddonCluster", {
              compute: "auto",
              resourcesVpcConfig: {
                subnetIds: network.publicSubnetIds,
                endpointPublicAccess: true,
              },
            });
            return yield* Addon("ConfiguredAddon", {
              clusterName: cluster.clusterName,
              addonName: "metrics-server",
              configurationValues: JSON.stringify({ replicas }),
            });
          }),
        );

      const configured = (addon: Addon["Attributes"]) =>
        eks
          .describeAddon({ clusterName: addon.clusterName, addonName: addon.addonName })
          .pipe(Effect.map((response) => response.addon?.configurationValues));

      const first = yield* deploy(1);
      expect(yield* configured(first)).toBe(JSON.stringify({ replicas: 1 }));

      const second = yield* deploy(2);
      expect(yield* configured(second)).toBe(JSON.stringify({ replicas: 2 }));

      const third = yield* deploy(1);
      expect(yield* configured(third)).toBe(JSON.stringify({ replicas: 1 }));

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:eks", "live"], timeout: 2_400_000 },
);
