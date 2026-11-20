import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as route53 from "@distilled.cloud/aws/route-53";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { testName } from "../../names.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:route53", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "HostedZoneLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const zone = yield* AWS.Route53.HostedZone("lookup-target", {
      name: `${testName("alchemy-lookup")}.alchemy.`,
    });
    return {
      id: zone.id.as<string>(),
      zoneName: zone.name.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up hosted zone resolves by id and by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { id, zoneName } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const byName = AWS.Route53.HostedZone.lookup({ name: zoneName });
          const byId = AWS.Route53.HostedZone.lookup({ id });
          return { id: byName.id, name: byId.name };
        },
        {
          id: id,
          name: zoneName,
        },
      );
      const survivor = yield* route53.getHostedZone({ Id: id });
      expect(survivor.HostedZone.Name).toBe(zoneName);
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a missing hosted zone fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-hosted-zone", {
            value: AWS.Route53.HostedZone.lookup({ name: `${name}.alchemy.` }).id,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a lookup of a hosted zone this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () =>
        AWS.Route53.HostedZone("lookup-managed", {
          name: `${testName("alchemy-lookup-managed")}.alchemy.`,
        });
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-hosted-zone-consumer", {
              value: AWS.Route53.HostedZone.lookup({ id: attrs.id }).id,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);
