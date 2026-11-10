import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:ecs", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (capacity provider, service).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-capacity-provider": AWS.ECS.CapacityProvider.lookup({ name: name })
          .capacityProviderArn,
        "missing-service": AWS.ECS.Service.lookup({ cluster: name, serviceName: name }).serviceArn,
      });
    }),
  { tags, timeout: 180_000 },
);
