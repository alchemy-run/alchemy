import * as Convex from "@alchemy.run/convex/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as rds from "@distilled.cloud/aws/rds";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { assertDevAccount } from "./guard.ts";
import { assertRuntime, BACKEND_IMAGE, selfHostedApp, skipPaid, TEST_DOMAIN } from "./support.ts";

/** One backend on a database this stack creates, from deploy to destroy. */
export const databaseSuite = (engine: "postgres" | "mysql") => {
  const { test } = Test.make({ providers: Convex.providers() });

  const domain = {
    cloud: `convex-${engine}-cloud.${TEST_DOMAIN}`,
    site: `convex-${engine}-site.${TEST_DOMAIN}`,
  };

  const app = (rootDir: string, deletionProtection: boolean | undefined) =>
    Effect.gen(function* () {
      const backend = yield* Convex.Backend("Backend", {
        image: BACKEND_IMAGE,
        domain,
        db: { engine, instanceClass: "db.t4g.micro", storage: 20 },
        deletionProtection,
        cpu: 512,
        memory: 1024,
      });
      yield* Convex.Functions("Functions", { backend, rootDir });
      return backend;
    });

  test.provider.skipIf(skipPaid)(
    `${engine} backend end to end on AWS`,
    (stack) =>
      Effect.gen(function* () {
        yield* assertDevAccount;
        yield* stack.destroy();
        const rootDir = yield* selfHostedApp(`backend-${engine}`);

        // deletionProtection defaults on.
        const backend = yield* stack.deploy(app(rootDir, undefined));
        yield* assertRuntime({
          url: backend.url,
          siteUrl: backend.siteUrl,
          text: `written to ${engine}`,
        });

        const { services } = yield* ecs.describeServices({
          cluster: backend.service.clusterArn,
          services: [backend.service.serviceArn],
        });
        const network = services![0]!.networkConfiguration!.awsvpcConfiguration!;
        const { Subnets } = yield* ec2.describeSubnets({ SubnetIds: network.subnets });

        const { DBInstances } = yield* rds.describeDBInstances({});
        const instance = DBInstances!.find(
          (candidate) => candidate.DBSubnetGroup?.VpcId === Subnets![0]!.VpcId,
        )!;

        // Database is in the task's availability zone.
        expect(instance.AvailabilityZone).toBe(Subnets![0]!.AvailabilityZone);
        expect(instance.PubliclyAccessible).toBe(false);
        expect(instance.DeletionProtection).toBe(true);

        // Database admits only the backend security group.
        const { SecurityGroups } = yield* ec2.describeSecurityGroups({
          GroupIds: instance.VpcSecurityGroups!.map((group) => group.VpcSecurityGroupId!),
        });
        const rules = SecurityGroups!.flatMap((group) => group.IpPermissions ?? []);
        expect(rules.flatMap((rule) => rule.IpRanges ?? [])).toEqual([]);
        expect(
          rules.flatMap((rule) => rule.UserIdGroupPairs ?? []).map((pair) => pair.GroupId),
        ).toEqual(network.securityGroups ?? []);

        // A protected database refuses to go.
        const refused = yield* stack.destroy().pipe(Effect.result);
        expect(Result.isFailure(refused)).toBe(true);
        const still = yield* rds.describeDBInstances({
          DBInstanceIdentifier: instance.DBInstanceIdentifier,
        });
        expect(still.DBInstances?.length).toBe(1);

        yield* stack.deploy(app(rootDir, false));
      }).pipe(Effect.ensuring(stack.destroy().pipe(Effect.ignore))),
    { timeout: 3_000_000 },
  );
};
