import * as AWS from "@/AWS";
import { Network } from "@/AWS/EC2/Network.ts";
import { Cluster } from "@/AWS/EKS/Cluster.ts";
import { ServerHost } from "@/AWS/EKS/ServerHost.ts";
import { Role } from "@/AWS/IAM/Role.ts";
import * as Core from "@/Test/Core";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import EksHostApi from "./fixtures/server-host.ts";

const testOptions = { providers: AWS.providers() };
const { test, beforeAll, afterAll } = Test.make(testOptions);

// Ungated probe: `ServerHost` is a composite host (ECR repo + pod-identity
// role + PodIdentityAssociation + in-cluster Deployment/Service). It has no
// faithful single-API enumeration, so `list()` is intentionally empty. This
// probe proves the provider is registered, its record type-checks (a missing /
// mistyped `list` collapses Provider.of inference), and it runs live — without
// paying the ~15-minute EKS control-plane create.
test.provider(
  "list returns an empty array (composite host, not enumerable)",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(ServerHost);
      const all = yield* provider.list();
      expect(Array.isArray(all)).toBe(true);
      expect(all).toEqual([]);
    }),
);

// Full end-to-end (gated). An EKS Auto Mode cluster takes ~10–15 min to
// provision, plus image build/push, pod scheduling, and NLB provisioning —
// well beyond the routine speed-doctrine ceiling. Gate it behind AWS_TEST_SLOW.
//
// It deploys, in two phases (refs read committed stack state, not the in-flight
// plan): (1) a public network + an Auto Mode cluster with a pod-identity access
// entry; (2) the same infra + the `ServerHost` fixture, which binds DynamoDB
// `PutItem`. The bound policy lands on the generated pod-identity role and the
// table name is injected into the pod; the pod resolves credentials via the EKS
// Pod Identity container-credentials chain. The test curls the LoadBalancer
// `/put` route, then asserts the item was written by reading it back out-of-band
// through the DynamoDB API — proving the binding, pod identity, image pipeline,
// and server-side-apply path in one shot.
//
// NOTE: this path has not been run green live in this factory wave (cluster
// create alone exceeds the 1800s agent budget). It is gated + skip-clean; run
// on an account with Auto Mode Pod Identity by setting AWS_TEST_SLOW=1.
const clusterManagedPolicyArns = [
  "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy",
  "arn:aws:iam::aws:policy/AmazonEKSComputePolicy",
  "arn:aws:iam::aws:policy/AmazonEKSBlockStoragePolicy",
  "arn:aws:iam::aws:policy/AmazonEKSLoadBalancingPolicy",
  "arn:aws:iam::aws:policy/AmazonEKSNetworkingPolicy",
];
const nodeManagedPolicyArns = [
  "arn:aws:iam::aws:policy/AmazonEKSWorkerNodeMinimalPolicy",
  "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPullOnly",
];

// Cluster + roles declared at TOP-LEVEL logical ids so the fixture can resolve
// them with `Cluster.ref("EksHostCluster")` (no namespace nesting).
const infra = Effect.gen(function* () {
  const network = yield* Network("EksHostNetwork", {
    cidrBlock: "10.84.0.0/16",
    availabilityZones: 2,
  });

  const clusterRole = yield* Role("EksHostClusterRole", {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "eks.amazonaws.com" },
          Action: ["sts:AssumeRole", "sts:TagSession"],
        },
      ],
    },
    managedPolicyArns: clusterManagedPolicyArns,
  });
  const nodeRole = yield* Role("EksHostNodeRole", {
    assumeRolePolicyDocument: {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Principal: { Service: "ec2.amazonaws.com" },
          Action: ["sts:AssumeRole"],
        },
      ],
    },
    managedPolicyArns: nodeManagedPolicyArns,
  });

  const cluster = yield* Cluster("EksHostCluster", {
    roleArn: clusterRole.roleArn,
    resourcesVpcConfig: {
      subnetIds: network.publicSubnetIds,
      endpointPublicAccess: true,
      endpointPrivateAccess: true,
    },
    accessConfig: {
      authenticationMode: "API",
      bootstrapClusterCreatorAdminPermissions: true,
    },
    computeConfig: {
      enabled: true,
      nodePools: ["system", "general-purpose"],
      nodeRoleArn: nodeRole.roleArn,
    },
    kubernetesNetworkConfig: {
      elasticLoadBalancing: { enabled: true },
    },
    storageConfig: { blockStorage: { enabled: true } },
  });

  return { cluster, network };
});

const sharedStack = Core.scratchStack(testOptions, "EksServerHost");

describe.skipIf(!process.env.AWS_TEST_SLOW)("EKS ServerHost E2E", () => {
  let baseUrl: string;

  beforeAll(
    Effect.gen(function* () {
      yield* sharedStack.destroy();
      // Phase 1: cluster + network only.
      yield* sharedStack.deploy(infra);
      // Phase 2: same infra + the ServerHost fixture (refs the cluster).
      const host = yield* sharedStack.deploy(
        Effect.gen(function* () {
          yield* infra;
          return yield* EksHostApi;
        }),
      );
      expect(host.url).toBeTruthy();
      baseUrl = `http://${host.url!.replace(/\/+$/, "")}`;

      // NLB DNS + pod readiness ramp — retry /health.
      yield* HttpClient.get(`${baseUrl}/health`).pipe(
        Effect.flatMap((res) =>
          res.status === 200
            ? Effect.succeed(res)
            : Effect.fail(new Error(`/health ${res.status}`)),
        ),
        Effect.tapError((e) => Effect.logWarning(String(e))),
        Effect.retry({ schedule: Schedule.spaced("10 seconds"), times: 60 }),
      );
    }),
    { timeout: 1_500_000 },
  );

  afterAll(sharedStack.destroy(), { timeout: 600_000 });

  test.provider(
    "bound DynamoDB PutItem writes an item from inside the pod",
    () =>
      Effect.gen(function* () {
        // Deterministic id: the table is created fresh by this suite's deploy
        // (beforeAll starts with a destroy), so no stale item can pre-exist,
        // and a stable id keeps re-runs convergent instead of accreting items.
        const itemId = "eks-serverhost-put-item";
        const res = yield* HttpClient.get(`${baseUrl}/put?id=${itemId}`).pipe(
          Effect.retry({ schedule: Schedule.spaced("5 seconds"), times: 12 }),
        );
        expect(res.status).toBe(200);
        const body = (yield* res.json) as { written: string; table: string };
        expect(body.written).toBe(itemId);

        // Prove the binding actually reached DynamoDB: read the item back
        // out-of-band via the control-plane API.
        const got = yield* dynamodb
          .getItem({ TableName: body.table, Key: { pk: { S: itemId } } })
          .pipe(
            Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 10 }),
          );
        expect(got.Item?.pk?.S).toBe(itemId);
      }),
    { timeout: 180_000 },
  );
});
