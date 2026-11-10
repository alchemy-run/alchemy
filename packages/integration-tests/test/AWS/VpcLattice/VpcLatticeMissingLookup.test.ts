import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:vpclattice", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (listener, service, service network, target group).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-listener": AWS.VpcLattice.Listener.lookup({
          serviceId: "svc-00000000000000000",
          name,
        }).listenerId,
        "missing-service": AWS.VpcLattice.Service.lookup({ serviceId: "svc-00000000000000000" })
          .serviceId,
        "missing-service-network": AWS.VpcLattice.ServiceNetwork.lookup({
          serviceNetworkId: "sn-00000000000000000",
        }).serviceNetworkId,
        "missing-target-group": AWS.VpcLattice.TargetGroup.lookup({
          targetGroupId: "tg-00000000000000000",
        }).targetGroupId,
      });
    }),
  { tags, timeout: 180_000 },
);
