import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Convex from "@alchemy.run/convex/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as ec2 from "@distilled.cloud/aws/ec2";
import * as ecs from "@distilled.cloud/aws/ecs";
import * as rds from "@distilled.cloud/aws/rds";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import {
  assertRuntime,
  BACKEND_IMAGE,
  databaseServerGone,
  selfHostedApp,
  serviceGone,
  DelegatedZone,
  domainFor,
  skipSlow,
  testZoneId,
} from "./support.ts";

/** One backend on a database this stack creates, from deploy to destroy. */
export const databaseSuite = (engine: "postgres" | "mysql") => {
  const { test } = Test.make({
    providers: Layer.mergeAll(Convex.providers(), Cloudflare.providers()),
  });

  /** Where a deploy puts the backend: this stage's domain, and its parent zone. */
  interface Place {
    readonly domain: string;
    readonly parentZoneId: string;
  }

  const app = (place: Place, rootDir: string, deletionProtection: boolean | undefined) =>
    Effect.gen(function* () {
      const zone = yield* DelegatedZone(place.parentZoneId, place.domain);
      const domain = {
        cloud: `cloud.${place.domain}`,
        site: `site.${place.domain}`,
        hostedZoneId: zone.id,
      };
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

  const run = (stack: Test.ScratchStack, rootDir: string, place: Place) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // deletionProtection defaults on.
      const backend = yield* stack.deploy(app(place, rootDir, undefined));
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

      // Lifting protection lets it go, and nothing is left behind.
      yield* stack.deploy(app(place, rootDir, false));
      yield* stack.destroy();
      expect(yield* databaseServerGone(instance.Endpoint!.Address!)).toBe(true);
      expect(yield* serviceGone(backend.service.clusterArn, backend.service.serviceArn)).toBe(true);
    });

  test.provider.skipIf(skipSlow)(
    `${engine} backend end to end on AWS`,
    (stack) =>
      Effect.gen(function* () {
        const rootDir = yield* selfHostedApp(`backend-${engine}`);
        const place = {
          domain: yield* domainFor(engine, stack.stage),
          parentZoneId: yield* testZoneId,
        };
        yield* run(stack, rootDir, place).pipe(
          // A protected database refuses to go, so a run that stopped early
          // has to lift protection before it can clean up. A run that got
          // through has already destroyed everything itself.
          Effect.onError(() =>
            stack
              .deploy(app(place, rootDir, false))
              .pipe(Effect.ignore, Effect.andThen(stack.destroy()), Effect.ignore),
          ),
        );
      }),
    {
      tags: ["provider:convex", "provider:convex:backend", "provider:aws", "live"],
      timeout: 3_000_000,
    },
  );
};
