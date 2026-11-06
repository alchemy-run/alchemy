import * as AWS from "@alchemy.run/aws";
import { Network } from "@alchemy.run/aws/EC2/Network";
import { Cluster, PodIdentityAssociation } from "@alchemy.run/aws/EKS";
import { Role } from "@alchemy.run/aws/IAM";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as eks from "@distilled.cloud/aws/eks";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated probe: `list()` enumerates every cluster, lists each cluster's pod
// identity associations, then hydrates each via `describePodIdentityAssociation`.
// It requires no deployed resource — in a clean account/region it returns `[]`,
// otherwise a well-formed array of full PodIdentityAssociation Attributes. This
// proves the enumeration wiring (listClusters -> listPodIdentityAssociations ->
// describePodIdentityAssociation) compiles and runs live without needing a
// ~10-minute cluster create.
test.provider(
  "list returns a well-formed array of pod identity associations",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const provider = yield* Provider.findProvider(PodIdentityAssociation);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const association of all) {
        expect(typeof association.associationArn).toBe("string");
        expect(typeof association.associationId).toBe("string");
        expect(typeof association.clusterName).toBe("string");
        expect(typeof association.namespace).toBe("string");
        expect(typeof association.serviceAccount).toBe("string");
        expect(typeof association.roleArn).toBe("string");
      }
    }),
  { tags: ["provider:aws", "provider:aws:eks", "live"] },
);

const podTrustPolicy = {
  Version: "2012-10-17" as const,
  Statement: [
    {
      Effect: "Allow" as const,
      Principal: { Service: "pods.eks.amazonaws.com" },
      Action: ["sts:AssumeRole", "sts:TagSession"],
    },
  ],
};

// Full deploy test on its own Auto Mode cluster (~10 min create, ~5 min
// delete), so it skips under `--fast`. Deploys an association, moves it to a
// second role and back, asserts it appears in the exhaustively-paginated
// `list()`, then tears down. Two updates in a row also cover the per-request
// clientRequestToken, though EKS applied pod identity updates even when the
// token repeated (unlike Addon, Cluster and Nodegroup updates).
test.provider.skipIf(!!process.env.FAST)(
  "updates the role and lists the deployed pod identity association",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (role: "first" | "second") =>
        stack.deploy(
          Effect.gen(function* () {
            const network = yield* Network("PodIdentityNetwork", {
              cidrBlock: "10.90.0.0/16",
              availabilityZones: 2,
            });
            const cluster = yield* Cluster("PodIdentityCluster", {
              compute: "auto",
              resourcesVpcConfig: {
                subnetIds: network.publicSubnetIds,
                endpointPublicAccess: true,
              },
            });
            const first = yield* Role("PodIdentityFirstRole", {
              assumeRolePolicyDocument: podTrustPolicy,
            });
            const second = yield* Role("PodIdentitySecondRole", {
              assumeRolePolicyDocument: podTrustPolicy,
            });
            const association = yield* PodIdentityAssociation("ListPodIdentity", {
              clusterName: cluster.clusterName,
              namespace: "default",
              serviceAccount: "alchemy-test-list-sa",
              roleArn: role === "first" ? first.roleArn : second.roleArn,
            });
            return {
              association,
              firstRoleArn: first.roleArn,
              secondRoleArn: second.roleArn,
            };
          }),
        );

      const roleArn = (association: PodIdentityAssociation["Attributes"]) =>
        eks
          .describePodIdentityAssociation({
            clusterName: association.clusterName,
            associationId: association.associationId,
          })
          .pipe(Effect.map((response) => response.association?.roleArn));

      const created = yield* deploy("first");
      expect(yield* roleArn(created.association)).toBe(created.firstRoleArn);

      const moved = yield* deploy("second");
      expect(yield* roleArn(moved.association)).toBe(moved.secondRoleArn);

      const movedBack = yield* deploy("first");
      expect(yield* roleArn(movedBack.association)).toBe(movedBack.firstRoleArn);

      const provider = yield* Provider.findProvider(PodIdentityAssociation);
      const all = yield* provider.list();
      expect(all.some((a) => a.associationId === movedBack.association.associationId)).toBe(true);

      yield* stack.destroy();
    }),
  { tags: ["provider:aws", "provider:aws:eks", "live"], timeout: 2_400_000 },
);
