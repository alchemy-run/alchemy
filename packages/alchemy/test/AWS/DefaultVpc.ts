import { VpcId } from "@/AWS/EC2";
import * as EC2 from "@distilled.cloud/aws/ec2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

class DefaultVpcNotVisible extends Data.TaggedError(
  "DefaultVpcNotVisible",
)<{}> {}

class UnsupportedDefaultVpcCidr extends Data.TaggedError(
  "UnsupportedDefaultVpcCidr",
)<{
  readonly cidrBlock: string;
}> {}

export const getDefaultVpc = Effect.gen(function* () {
  const vpcs = yield* EC2.describeVpcs({});
  const vpc = (vpcs.Vpcs ?? []).find((v) => v.IsDefault);
  if (!vpc?.VpcId || !vpc.CidrBlock) {
    // The default VPC can be deleted out of band (e.g. by the account nuke
    // script). Recreate it, then fail with the retryable marker so the retry
    // loop below re-describes until it becomes visible. Concurrent test files
    // racing on the same recreate surface DefaultVpcAlreadyExists — that just
    // means someone else won the race, so fall through to the retry.
    yield* EC2.createDefaultVpc({}).pipe(
      Effect.catchTag("DefaultVpcAlreadyExists", () => Effect.void),
    );
    return yield* Effect.fail(new DefaultVpcNotVisible());
  }

  const [baseAddress, prefixString] = vpc.CidrBlock.split("/");
  if (prefixString !== "16") {
    return yield* Effect.fail(
      new UnsupportedDefaultVpcCidr({ cidrBlock: vpc.CidrBlock }),
    );
  }

  const [a, b] = baseAddress.split(".");
  return {
    vpcId: VpcId(vpc.VpcId),
    cidrBlock: vpc.CidrBlock,
    subnetCidrBlock: (thirdOctet: number) => `${a}.${b}.${thirdOctet}.0/24`,
  };
}).pipe(
  Effect.retry({
    while: (e) => e._tag === "DefaultVpcNotVisible",
    schedule: Schedule.spaced("3 seconds").pipe(
      Schedule.both(Schedule.recurs(10)),
    ),
  }),
);
