import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as eventhub from "@distilled.cloud/azure/eventhub";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getNamespace = (resourceGroupName: string, namespaceName: string) =>
  Effect.gen(function* () {
    return yield* eventhub.GetNamespace({
      subscriptionId: yield* subscription,
      resourceGroupName,
      namespaceName,
    });
  });

const program = (props: {
  name?: string;
  sku: Azure.EventHub.NamespaceSkuName;
  disableLocalAuth: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const namespace = yield* Azure.EventHub.Namespace("Events", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      sku: props.sku,
      disableLocalAuth: props.disableLocalAuth,
      tags: props.tags,
    });
    return { group, namespace };
  });

// Basic/Standard namespaces bill ~$0.015-0.03/hour; the test runs a few
// minutes (~$0.06 worst case including the replacement namespace).
test.provider(
  "create, update, upgrade, replace, and delete an event hubs namespace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        program({ sku: "Basic", disableLocalAuth: false, tags: { env: "test" } }),
      );
      const { group, namespace } = created;
      expect(namespace.namespaceName).toMatch(/^[a-z][a-z0-9-]{4,48}[a-z0-9]$/);
      expect(namespace.sku).toEqual("Basic");
      expect(namespace.status).toEqual("Active");
      expect(namespace.serviceBusEndpoint).toContain(
        `${namespace.namespaceName}.servicebus.windows.net`,
      );
      expect(namespace.tags).toEqual({ env: "test" });
      expect(namespace.primaryConnectionString).toBeDefined();
      expect(Redacted.value(namespace.primaryConnectionString!)).toContain(
        "SharedAccessKeyName=RootManageSharedAccessKey",
      );

      const observed = yield* getNamespace(
        group.resourceGroupName,
        namespace.namespaceName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.sku?.name).toEqual("Basic");
      expect(observed.properties?.minimumTlsVersion).toEqual("1.2");
      expect(observed.properties?.disableLocalAuth).toEqual(false);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Events");

      // In-place: tags, local (SAS) auth, and Basic -> Standard upgrade.
      const updated = yield* stack.deploy(
        program({
          sku: "Standard",
          disableLocalAuth: true,
          tags: { env: "prod" },
        }),
      );
      expect(updated.namespace.namespaceName).toEqual(namespace.namespaceName);
      expect(updated.namespace.sku).toEqual("Standard");
      const reobserved = yield* getNamespace(
        group.resourceGroupName,
        namespace.namespaceName,
      );
      expect(reobserved.sku?.name).toEqual("Standard");
      expect(reobserved.properties?.disableLocalAuth).toEqual(true);
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: an explicit new name creates a new namespace and
      // deletes the old one.
      const renamedName = `${namespace.namespaceName.slice(0, 44)}-r2`;
      const replaced = yield* stack.deploy(
        program({
          name: renamedName,
          sku: "Standard",
          disableLocalAuth: true,
          tags: { env: "prod" },
        }),
      );
      expect(replaced.namespace.namespaceName).toEqual(renamedName);
      expect(replaced.namespace.namespaceId).not.toEqual(namespace.namespaceId);
      expect(
        yield* waitGone(
          getNamespace(group.resourceGroupName, namespace.namespaceName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(getNamespace(group.resourceGroupName, renamedName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
