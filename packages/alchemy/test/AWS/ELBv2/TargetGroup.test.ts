import * as AWS from "@/AWS";
import { TargetGroup } from "@/AWS/ELBv2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import * as EC2 from "@distilled.cloud/aws/ec2";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test for an account/region-scoped resource: a target group
// only needs a VPC id, so reuse an existing VPC in the account/region (avoids
// the per-region VPC limit), deploy a TargetGroup, resolve the provider from
// context with the typed `findProvider` helper, call `list()` (which
// exhaustively paginates describeTargetGroups in the account/region), and assert
// the deployed target group appears in the result.
test.provider(
  "list enumerates the deployed target group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Parallel EC2 suites churn VPCs in the shared account/region, so a
      // single describeVpcs can momentarily come back empty. Retry until at
      // least one VPC is visible (prefer the default) before continuing.
      const selectVpc = Effect.gen(function* () {
        const vpcResult = yield* EC2.describeVpcs({});
        const id =
          vpcResult.Vpcs?.find((v) => v.IsDefault)?.VpcId ??
          vpcResult.Vpcs?.[0]?.VpcId;
        if (!id) {
          return yield* Effect.fail(new Error("no VPC available yet"));
        }
        return id;
      }).pipe(
        Effect.retry({
          while: (e) =>
            e instanceof Error && e.message === "no VPC available yet",
          schedule: Schedule.spaced("3 seconds").pipe(
            Schedule.both(Schedule.recurs(10)),
          ),
        }),
      );

      // Select a VPC and deploy against it as one unit, retrying the pair on a
      // `ValidationError`: a non-default VPC chosen above can be deleted by a
      // parallel EC2 suite before createTargetGroup uses it, which AWS rejects
      // with a `ValidationError`. Re-selecting a fresh VPC and redeploying
      // (idempotent against the scratch state) rides out the churn.
      const deployed = yield* Effect.gen(function* () {
        const vpcId = yield* selectVpc;
        expect(vpcId).toBeDefined();
        return yield* stack.deploy(
          Effect.gen(function* () {
            const targetGroup = yield* TargetGroup("ListTargetGroup", {
              vpcId,
              port: 80,
              protocol: "HTTP",
              targetType: "ip",
            });

            return { targetGroup };
          }),
        );
      }).pipe(
        Effect.retry({
          while: (e) =>
            typeof e === "object" &&
            e !== null &&
            "_tag" in e &&
            e._tag === "ValidationError",
          schedule: Schedule.spaced("3 seconds").pipe(
            Schedule.both(Schedule.recurs(8)),
          ),
        }),
      );

      expect(deployed.targetGroup.targetGroupArn).toBeDefined();

      const provider = yield* Provider.findProvider(TargetGroup);
      const all = yield* provider.list();

      expect(
        all.some(
          (tg) => tg.targetGroupArn === deployed.targetGroup.targetGroupArn,
        ),
      ).toBe(true);

      yield* stack.destroy();
    }),
  { timeout: 240_000 },
);
