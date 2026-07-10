import * as AWS from "@/AWS";
import { Vpc } from "@/AWS/EC2";
import {
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
      schedule: Schedule.spaced("3 seconds").pipe(
        Schedule.both(Schedule.recurs(15)),
      ),
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
        schedule: Schedule.spaced("3 seconds").pipe(
          Schedule.both(Schedule.recurs(20)),
        ),
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
            idleTimeoutSeconds: 60,
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
            idleTimeoutSeconds: 120,
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
