import * as Azure from "@alchemy.run/azure";
import * as eventgrid from "@distilled.cloud/azure/eventgrid";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, partnerChain, subscription, tags, waitGone } from "./partner.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getNamespace = (resourceGroupName: string, partnerNamespaceName: string) =>
  Effect.gen(function* () {
    return yield* eventgrid.GetPartnerNamespace({
      subscriptionId: yield* subscription,
      resourceGroupName,
      partnerNamespaceName,
    });
  });

// Partner namespaces bill per operation only; ~3 minutes.
test.provider(
  "create, update, replace, and delete an event grid partner namespace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, registration, namespace } = yield* stack.deploy(
        partnerChain({ namespace: { tags: { env: "test" } } }),
      );
      expect(namespace.partnerNamespaceName).toMatch(/^[A-Za-z0-9-]{3,50}$/);
      expect(namespace.endpoint).toMatch(/^https:\/\/.+\.eventgrid\.azure\.net\/api\/events$/);
      expect(namespace.partnerTopicRoutingMode).toEqual("ChannelNameHeader");
      expect(
        namespace.primaryKey ? Redacted.value(namespace.primaryKey).length : 0,
      ).toBeGreaterThan(40);
      expect(namespace.partnerRegistration.toLowerCase()).toEqual(
        registration.partnerRegistrationId.toLowerCase(),
      );
      const observed = yield* getNamespace(group.resourceGroupName, namespace.partnerNamespaceName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Publisher");

      // In place: minimum TLS version and tags.
      const updated = yield* stack.deploy(
        partnerChain({ namespace: { minimumTlsVersionAllowed: "1.2", tags: { env: "prod" } } }),
      );
      expect(updated.namespace.partnerNamespaceName).toEqual(namespace.partnerNamespaceName);
      const reobserved = yield* getNamespace(
        group.resourceGroupName,
        namespace.partnerNamespaceName,
      );
      expect(reobserved.properties?.minimumTlsVersionAllowed).toEqual("1.2");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the routing mode is immutable.
      const replaced = yield* stack.deploy(
        partnerChain({
          namespace: {
            minimumTlsVersionAllowed: "1.2",
            partnerTopicRoutingMode: "SourceEventAttribute",
            tags: { env: "prod" },
          },
        }),
      );
      expect(replaced.namespace.partnerNamespaceName).not.toEqual(namespace.partnerNamespaceName);
      const replacement = yield* getNamespace(
        group.resourceGroupName,
        replaced.namespace.partnerNamespaceName,
      );
      expect(replacement.properties?.partnerTopicRoutingMode).toEqual("SourceEventAttribute");
      expect(
        yield* waitGone(getNamespace(group.resourceGroupName, namespace.partnerNamespaceName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getNamespace(group.resourceGroupName, replaced.namespace.partnerNamespaceName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
