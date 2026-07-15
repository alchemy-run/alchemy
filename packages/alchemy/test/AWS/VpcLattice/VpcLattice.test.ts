import * as AWS from "@/AWS";
import { Vpc } from "@/AWS/EC2";
import { normalizePolicyDocument } from "@/AWS/IAM/Policy.ts";
import {
  AuthPolicy,
  ResourcePolicy,
  Service,
  ServiceNetwork,
  ServiceNetworkVpcAssociation,
} from "@/AWS/VpcLattice";
import * as Test from "@/Test/Vitest";
import * as vpclattice from "@distilled.cloud/aws/vpc-lattice";
import { expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

const findServiceNetwork = (id: string) =>
  vpclattice
    .getServiceNetwork({ serviceNetworkIdentifier: id })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

class StillExists extends Data.TaggedError("StillExists")<{
  readonly id: string;
}> {}

const assertServiceNetworkDeleted = (id: string) =>
  findServiceNetwork(id).pipe(
    Effect.flatMap((sn) =>
      sn === undefined ? Effect.void : Effect.fail(new StillExists({ id })),
    ),
    Effect.retry({
      while: (e) => e._tag === "StillExists",
      schedule: Schedule.max([
        Schedule.spaced("3 seconds"),
        Schedule.recurs(15),
      ]),
    }),
  );

const assertAssociationDeleted = (id: string) =>
  vpclattice
    .getServiceNetworkVpcAssociation({
      serviceNetworkVpcAssociationIdentifier: id,
    })
    .pipe(
      Effect.flatMap((assoc) =>
        assoc.status === "DELETE_IN_PROGRESS"
          ? Effect.fail(new StillExists({ id }))
          : Effect.void,
      ),
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
      Effect.retry({
        while: (e) => e._tag === "StillExists",
        schedule: Schedule.max([
          Schedule.spaced("3 seconds"),
          Schedule.recurs(20),
        ]),
      }),
    );

test.provider(
  "create, update authType, delete a service network",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const network = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ServiceNetwork("TestServiceNetwork", {
            tags: { Environment: "test" },
          });
        }),
      );

      expect(network.serviceNetworkId).toMatch(/^sn-/);
      expect(network.serviceNetworkArn).toContain(":servicenetwork/");
      expect(network.authType).toBe("NONE");

      const live = yield* findServiceNetwork(network.serviceNetworkId);
      expect(live?.arn).toBe(network.serviceNetworkArn);
      const tags = yield* vpclattice
        .listTagsForResource({ resourceArn: network.serviceNetworkArn })
        .pipe(Effect.map((r) => r.tags ?? {}));
      expect(tags["alchemy::id"]).toBe("TestServiceNetwork");

      // Update the auth type in place.
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ServiceNetwork("TestServiceNetwork", {
            authType: "AWS_IAM",
            tags: { Environment: "test" },
          });
        }),
      );
      expect(updated.serviceNetworkId).toBe(network.serviceNetworkId);
      expect(updated.authType).toBe("AWS_IAM");
      const live2 = yield* findServiceNetwork(network.serviceNetworkId);
      expect(live2?.authType).toBe("AWS_IAM");

      yield* stack.destroy();
      yield* assertServiceNetworkDeleted(network.serviceNetworkId);
    }),
  { timeout: 180_000 },
);

test.provider(
  "create, update idle timeout, delete a service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const service = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Service("TestLatticeService", {
            idleTimeout: "60 seconds",
          });
        }),
      );

      expect(service.serviceId).toMatch(/^svc-/);
      expect(service.serviceArn).toContain(":service/");

      const live = yield* vpclattice
        .getService({ serviceIdentifier: service.serviceId })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(live?.idleTimeoutSeconds).toBe(60);

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Service("TestLatticeService", {
            idleTimeout: "120 seconds",
          });
        }),
      );
      expect(updated.serviceId).toBe(service.serviceId);
      const live2 = yield* vpclattice
        .getService({ serviceIdentifier: service.serviceId })
        .pipe(
          Effect.catchTag("ResourceNotFoundException", () =>
            Effect.succeed(undefined),
          ),
        );
      expect(live2?.idleTimeoutSeconds).toBe(120);

      yield* stack.destroy();
    }),
  { timeout: 180_000 },
);

test.provider(
  "auth + resource policies deploy from PolicyDocument and re-deploy clean",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Deploy the network alone first — the policy documents below embed the
      // resolved ARN/account as plain strings (Outputs are unresolved proxies
      // during plan, so string ops on them are impossible inside the program).
      const base = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* ServiceNetwork("PolicyServiceNetwork", {
            authType: "AWS_IAM",
          });
        }),
      );
      const account = base.serviceNetworkArn.split(":")[4];
      const networkArn = base.serviceNetworkArn;

      const program = Effect.gen(function* () {
        const network = yield* ServiceNetwork("PolicyServiceNetwork", {
          authType: "AWS_IAM",
        });
        const authPolicy = yield* AuthPolicy("NetworkAuthPolicy", {
          resourceIdentifier: network.serviceNetworkId,
          policy: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { AWS: `arn:aws:iam::${account}:root` },
                Action: ["vpc-lattice-svcs:Invoke"],
                Resource: "*",
              },
            ],
          },
        });
        const resourcePolicy = yield* ResourcePolicy("NetworkResourcePolicy", {
          resourceArn: network.serviceNetworkArn,
          policy: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: { AWS: `arn:aws:iam::${account}:root` },
                Action: [
                  "vpc-lattice:CreateServiceNetworkVpcAssociation",
                  "vpc-lattice:CreateServiceNetworkServiceAssociation",
                  "vpc-lattice:GetServiceNetwork",
                ],
                Resource: networkArn,
              },
            ],
          },
        });
        return { authPolicy, network, resourcePolicy };
      });

      const first = yield* stack.deploy(program);

      expect(first.authPolicy.resourceIdentifier).toBe(
        first.network.serviceNetworkId,
      );
      expect(first.authPolicy.policy).toContain("vpc-lattice-svcs:Invoke");
      expect(first.resourcePolicy.resourceArn).toBe(
        first.network.serviceNetworkArn,
      );

      // The live documents match the PolicyDocument we deployed (canonicalized).
      const liveAuth = yield* vpclattice.getAuthPolicy({
        resourceIdentifier: first.network.serviceNetworkId,
      });
      expect(normalizePolicyDocument(liveAuth.policy!)).toBe(
        normalizePolicyDocument(first.authPolicy.policy),
      );
      const liveResource = yield* vpclattice.getResourcePolicy({
        resourceArn: first.network.serviceNetworkArn,
      });
      expect(normalizePolicyDocument(liveResource.policy!)).toBe(
        normalizePolicyDocument(first.resourcePolicy.policy),
      );

      // Re-deploy the identical program — the normalized observed-vs-desired
      // comparison must skip the puts, so the auth policy's lastUpdatedAt
      // timestamp is unchanged (a put always bumps it).
      const second = yield* stack.deploy(program);
      expect(second.authPolicy.policy).toBe(first.authPolicy.policy);
      expect(second.resourcePolicy.policy).toBe(first.resourcePolicy.policy);
      const liveAuth2 = yield* vpclattice.getAuthPolicy({
        resourceIdentifier: first.network.serviceNetworkId,
      });
      expect(liveAuth2.lastUpdatedAt?.toISOString()).toBe(
        liveAuth.lastUpdatedAt?.toISOString(),
      );

      yield* stack.destroy();
      yield* assertServiceNetworkDeleted(first.network.serviceNetworkId);
    }),
  { timeout: 240_000 },
);

test.provider(
  "associate a VPC with a service network",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { association, network } = yield* stack.deploy(
        Effect.gen(function* () {
          const vpc = yield* Vpc("LatticeVpc", { cidrBlock: "10.30.0.0/16" });
          const network = yield* ServiceNetwork("AssocServiceNetwork", {});
          const association = yield* ServiceNetworkVpcAssociation(
            "VpcAssociation",
            {
              serviceNetworkIdentifier: network.serviceNetworkId,
              vpcIdentifier: vpc.vpcId,
            },
          );
          return { association, network };
        }),
      );

      expect(association.associationId).toMatch(/^snva-/);
      expect(association.associationArn).toContain(
        ":servicenetworkvpcassociation/",
      );

      const live = yield* vpclattice.getServiceNetworkVpcAssociation({
        serviceNetworkVpcAssociationIdentifier: association.associationId,
      });
      expect(live.serviceNetworkId).toBe(network.serviceNetworkId);
      expect(["ACTIVE", "CREATE_IN_PROGRESS"]).toContain(live.status);

      yield* stack.destroy();
      yield* assertAssociationDeleted(association.associationId);
      yield* assertServiceNetworkDeleted(network.serviceNetworkId);
    }),
  { timeout: 240_000 },
);
