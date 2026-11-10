import * as AWS from "@alchemy.run/aws";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as sd from "@distilled.cloud/aws/servicediscovery";
import * as Alchemy from "alchemy";
import * as Effect from "effect/Effect";
import { expectDeployFails, missingName } from "../../lookup.ts";
import { expectLookupConsumers } from "../lookup.ts";

const { test, beforeAll, afterAll, deploy, destroy } = Test.make({
  providers: AWS.providers(),
});

const tags = ["provider:aws", "provider:aws:cloudmap", "live"];

// The target belongs to another stack, as a lookup's target always should.
const TargetStack = Alchemy.Stack(
  "CloudMapLookupTarget",
  { providers: AWS.providers(), state: Alchemy.localState() },
  Effect.gen(function* () {
    const ns = yield* AWS.CloudMap.HttpNamespace("lookup-target");
    const service = yield* AWS.CloudMap.Service("lookup-target-service", {
      namespaceId: ns.namespaceId,
    });
    return {
      namespaceId: ns.namespaceId.as<string>(),
      namespaceName: ns.namespaceName.as<string>(),
      serviceId: service.serviceId.as<string>(),
      serviceName: service.serviceName.as<string>(),
    };
  }),
);

const target = beforeAll(deploy(TargetStack));
afterAll.skipIf(!!process.env.NO_DESTROY)(destroy(TargetStack));

test.provider(
  "a looked-up namespace resolves by name, and survives destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { namespaceId, namespaceName, serviceId, serviceName } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const ns = AWS.CloudMap.HttpNamespace.lookup({ namespaceName });
          return { id: ns.namespaceId };
        },
        {
          id: namespaceId,
        },
      );
      const survivor = yield* sd.getNamespace({ Id: namespaceId });
      expect(survivor.Namespace?.Name).toBe(namespaceName);
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a looked-up service resolves by namespace and name",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { namespaceId, namespaceName, serviceId, serviceName } = yield* target;
      yield* expectLookupConsumers(
        stack,
        () => {
          const service = AWS.CloudMap.Service.lookup({ namespaceId, serviceName });
          return { id: service.serviceId };
        },
        {
          id: serviceId,
        },
      );
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a lookup of a missing namespace fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectDeployFails(
        stack.deploy(
          AWS.SSM.Parameter("missing-namespace", {
            value: AWS.CloudMap.HttpNamespace.lookup({ namespaceName: name }).namespaceId,
          }),
        ),
        ["LookupNotFoundError", name],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a lookup of a namespace this stack manages fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const managed = () => AWS.CloudMap.HttpNamespace("lookup-managed");
      const attrs = yield* stack.deploy(managed());
      yield* expectDeployFails(
        stack.deploy(
          Effect.gen(function* () {
            yield* managed();
            yield* AWS.SSM.Parameter("managed-namespace-consumer", {
              value: AWS.CloudMap.HttpNamespace.lookup({ namespaceName: attrs.namespaceName })
                .namespaceId,
            });
          }),
        ),
        ["LookupOfManagedResourceError", "lookup-managed"],
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);
