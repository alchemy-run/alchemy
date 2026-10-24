import * as AWS from "@alchemy.run/aws";
import { Network } from "@alchemy.run/aws/EC2/Network";
import { AccessEntry, Cluster } from "@alchemy.run/aws/EKS";
import { Role } from "@alchemy.run/aws/IAM";
import { expect } from "@alchemy.run/test";
import * as eks from "@distilled.cloud/aws/eks";
import * as iam from "@distilled.cloud/aws/iam";
import * as Provider from "alchemy/Provider";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

// Ungated live probe: `list()` enumerates every EKS access entry across every
// cluster in the account/region. It walks `listClusters` (paginated), then
// `listAccessEntries` per cluster (paginated), and hydrates each via
// `describeAccessEntry` + `listAssociatedAccessPolicies` into the same
// Attributes shape `read` returns. We don't deploy here because a fresh EKS
// cluster takes 10+ minutes to provision (see the gated test below) — but this
// still verifies the cluster-fan-out + pagination + mapping against the live
// API and asserts every returned row is well-formed (the array is empty when
// the account has no clusters).
test.provider(
  "list returns the account/region access entries",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(AccessEntry);
      const all = yield* provider.list();

      expect(Array.isArray(all)).toBe(true);
      for (const entry of all) {
        expect(typeof entry.accessEntryArn).toBe("string");
        expect(typeof entry.clusterName).toBe("string");
        expect(typeof entry.principalArn).toBe("string");
        expect(Array.isArray(entry.kubernetesGroups)).toBe(true);
        expect(Array.isArray(entry.accessPolicies)).toBe(true);
        expect(entry.tags).toBeDefined();
      }
    }),
  { tags: ["provider:aws", "provider:aws:eks", "live"] },
);

// Full deploy-then-list assertion. SKIPPED by default because an EKS cluster
// takes 10+ minutes to create (and requires a VPC + subnets + cluster IAM
// role), which exceeds the CI budget. Set AWS_TEST_EKS_CLUSTER to the name of a
// pre-provisioned cluster to run it on an entitled account unchanged. A
// throwaway IAM role is created out-of-band to serve as the access entry's
// principal.
const clusterName = process.env.AWS_TEST_EKS_CLUSTER;

const principalRoleName = "alchemy-test-eks-accessentry-list-principal";

test.provider.skipIf(!clusterName)(
  "list enumerates the deployed access entry",
  (stack) =>
    Effect.gen(function* () {
      // Idempotent delete: safe when the role never existed (pre-clean) or was
      // already removed (post-clean after a partial prior run).
      const deletePrincipalRole = iam
        .deleteRole({ RoleName: principalRoleName })
        .pipe(Effect.catchTag("NoSuchEntityException", () => Effect.void));

      yield* stack.destroy();

      // acquireRelease guarantees the out-of-band role is deleted on success,
      // failure, AND interruption; the deterministic name + pre-clean above
      // means a re-run reclaims any orphan from a previously-killed run.
      yield* Effect.gen(function* () {
        const role = yield* Effect.acquireRelease(
          // Pre-clean a leftover from a killed run, then create.
          deletePrincipalRole.pipe(
            Effect.andThen(
              iam.createRole({
                RoleName: principalRoleName,
                AssumeRolePolicyDocument: JSON.stringify({
                  Version: "2012-10-17",
                  Statement: [
                    {
                      Effect: "Allow",
                      Principal: { Service: "ec2.amazonaws.com" },
                      Action: "sts:AssumeRole",
                    },
                  ],
                }),
              }),
            ),
          ),
          () => deletePrincipalRole.pipe(Effect.catch(() => Effect.void)),
        );

        const deployed = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* AccessEntry("ListAccessEntry", {
              clusterName: clusterName!,
              principalArn: role.Role.Arn,
            });
          }),
        );

        const provider = yield* Provider.findProvider(AccessEntry);
        const all = yield* provider.list();

        expect(all.some((entry) => entry.accessEntryArn === deployed.accessEntryArn)).toBe(true);

        yield* stack.destroy();
      }).pipe(Effect.scoped);
    }),
  {
    tags: ["provider:aws", "provider:aws:eks", "provider:aws:iam", "live"],
    timeout: 240_000,
  },
);

const viewPolicyArn = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSViewPolicy";
const editPolicyArn = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy";

// Regression for #2192: EKS reports a cluster scope as
// `{ type: "cluster", namespaces: [] }`, which never matched the desired
// `{ type: "cluster" }`, so every reconcile re-associated and then
// disassociated the policy — leaving the principal with no access. A scope
// change took the same associate-then-disassociate path. Provisions its own
// Auto Mode cluster (~10 min create, ~10 min delete), so it skips under
// `--fast`.
test.provider.skipIf(!!process.env.FAST)(
  "reconcile keeps unchanged policies and updates scopes in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployEntry = (props: {
        tag: string;
        accessPolicies: { policyArn: string; accessScope: eks.AccessScope }[];
      }) =>
        stack.deploy(
          Effect.gen(function* () {
            const network = yield* Network("AccessEntryNetwork", {
              cidrBlock: "10.85.0.0/16",
              availabilityZones: 2,
            });
            const cluster = yield* Cluster("AccessEntryCluster", {
              compute: "auto",
              resourcesVpcConfig: {
                subnetIds: network.publicSubnetIds,
                endpointPublicAccess: true,
              },
            });
            const principal = yield* Role("AccessEntryPrincipal", {
              assumeRolePolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Principal: { Service: "ec2.amazonaws.com" },
                    Action: "sts:AssumeRole",
                  },
                ],
              },
            });
            return yield* AccessEntry("PolicyAccessEntry", {
              clusterName: cluster.clusterName,
              principalArn: principal.roleArn,
              accessPolicies: props.accessPolicies,
              tags: { revision: props.tag },
            });
          }),
        );

      const associated = (entry: AccessEntry["Attributes"]) =>
        eks
          .listAssociatedAccessPolicies({
            clusterName: entry.clusterName,
            principalArn: entry.principalArn,
          })
          .pipe(
            Effect.map((response) =>
              Object.fromEntries(
                (response.associatedAccessPolicies ?? []).map((policy) => [
                  policy.policyArn!,
                  {
                    type: policy.accessScope?.type,
                    namespaces: [...(policy.accessScope?.namespaces ?? [])].sort(),
                  },
                ]),
              ),
            ),
          );

      const created = yield* deployEntry({
        tag: "1",
        accessPolicies: [
          { policyArn: viewPolicyArn, accessScope: { type: "cluster" } },
          { policyArn: editPolicyArn, accessScope: { type: "namespace", namespaces: ["a"] } },
        ],
      });
      expect(yield* associated(created)).toEqual({
        [viewPolicyArn]: { type: "cluster", namespaces: [] },
        [editPolicyArn]: { type: "namespace", namespaces: ["a"] },
      });

      // A tag change reconciles the entry with unchanged policies — both must
      // survive.
      const retagged = yield* deployEntry({
        tag: "2",
        accessPolicies: [
          { policyArn: viewPolicyArn, accessScope: { type: "cluster" } },
          { policyArn: editPolicyArn, accessScope: { type: "namespace", namespaces: ["a"] } },
        ],
      });
      expect(yield* associated(retagged)).toEqual({
        [viewPolicyArn]: { type: "cluster", namespaces: [] },
        [editPolicyArn]: { type: "namespace", namespaces: ["a"] },
      });

      // A scope change updates the association in place.
      const rescoped = yield* deployEntry({
        tag: "2",
        accessPolicies: [
          { policyArn: viewPolicyArn, accessScope: { type: "cluster" } },
          {
            policyArn: editPolicyArn,
            accessScope: { type: "namespace", namespaces: ["b", "a"] },
          },
        ],
      });
      expect(yield* associated(rescoped)).toEqual({
        [viewPolicyArn]: { type: "cluster", namespaces: [] },
        [editPolicyArn]: { type: "namespace", namespaces: ["a", "b"] },
      });

      // Removing a policy disassociates only that policy.
      const trimmed = yield* deployEntry({
        tag: "2",
        accessPolicies: [{ policyArn: viewPolicyArn, accessScope: { type: "cluster" } }],
      });
      expect(yield* associated(trimmed)).toEqual({
        [viewPolicyArn]: { type: "cluster", namespaces: [] },
      });

      yield* stack.destroy();

      const gone = yield* eks.describeCluster({ name: trimmed.clusterName }).pipe(
        Effect.map(() => false),
        Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(true)),
      );
      expect(gone).toBe(true);
    }),
  {
    tags: ["provider:aws", "provider:aws:eks", "provider:aws:ec2", "provider:aws:iam", "live"],
    // Auto Mode cluster create (~10–18 min) + four reconciles + delete (~10 min).
    timeout: 2_700_000,
  },
);
