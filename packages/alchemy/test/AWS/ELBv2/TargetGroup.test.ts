import * as AWS from "@/AWS";
import { TargetGroup } from "@/AWS/ELBv2";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Vitest";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { getDefaultVpc } from "../DefaultVpc.ts";

const { test } = Test.make({ providers: AWS.providers() });

// Canonical `list()` test for an account/region-scoped resource: a target group
// only needs a VPC id, so reuse the default VPC in the account/region (avoids
// the per-region VPC limit), deploy a TargetGroup, resolve the provider from
// context with the typed `findProvider` helper, call `list()` (which
// exhaustively paginates describeTargetGroups in the account/region), and assert
// the deployed target group appears in the result.
test.provider(
  "list enumerates the deployed target group",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const defaultVpc = yield* getDefaultVpc;
      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const targetGroup = yield* TargetGroup("ListTargetGroup", {
            vpcId: defaultVpc.vpcId,
            port: 80,
            protocol: "HTTP",
            targetType: "ip",
          });

          return { targetGroup };
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
