/**
 * Resolve the Floci emulator's default VPC network (default-for-AZ subnets and
 * the default security group) for suites that read subnet and security-group
 * IDs from the environment.
 */
import * as Floci from "../packages/floci/src/index.ts";
import * as Credentials from "@distilled.cloud/aws/Credentials";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as Endpoint from "@distilled.cloud/aws/Endpoint";
import { Region } from "@distilled.cloud/aws/Region";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/unstable/http";

export interface FlociDefaultNetwork {
  readonly subnetIds: ReadonlyArray<string>;
  readonly securityGroupIds: ReadonlyArray<string>;
}

export const resolveFlociDefaultNetwork = (
  external: boolean,
): Promise<FlociDefaultNetwork> =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* Floci.ensureFloci({ port: Floci.DEFAULT_FLOCI_PORT, external });
      const vpcs = yield* EC2.describeVpcs({
        Filters: [{ Name: "is-default", Values: ["true"] }],
      });
      const vpcId = vpcs.Vpcs?.[0]?.VpcId;
      if (vpcId === undefined) {
        return yield* Effect.fail(new Error("the emulator has no default VPC"));
      }
      const subnets = yield* EC2.describeSubnets({
        Filters: [
          { Name: "vpc-id", Values: [vpcId] },
          { Name: "default-for-az", Values: ["true"] },
        ],
      });
      const groups = yield* EC2.describeSecurityGroups({
        Filters: [
          { Name: "vpc-id", Values: [vpcId] },
          { Name: "group-name", Values: ["default"] },
        ],
      });
      const subnetIds = (subnets.Subnets ?? []).flatMap((subnet) =>
        subnet.SubnetId === undefined ? [] : [subnet.SubnetId],
      );
      const securityGroupIds = (groups.SecurityGroups ?? []).flatMap(
        (group) => (group.GroupId === undefined ? [] : [group.GroupId]),
      );
      if (subnetIds.length === 0 || securityGroupIds.length === 0) {
        return yield* Effect.fail(
          new Error(`default VPC ${vpcId} has no default subnets or group`),
        );
      }
      return { subnetIds, securityGroupIds };
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Credentials.fromEnv(),
          Layer.succeed(
            Region,
            Effect.succeed((process.env.AWS_REGION ?? "us-east-1") as never),
          ),
          Endpoint.of(`http://localhost:${Floci.DEFAULT_FLOCI_PORT}`),
          FetchHttpClient.layer,
        ),
      ),
    ),
  );
