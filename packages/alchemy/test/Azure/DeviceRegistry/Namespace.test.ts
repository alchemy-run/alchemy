import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as deviceregistry from "@distilled.cloud/azure/deviceregistry";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getNamespace = (resourceGroupName: string, namespaceName: string) =>
  Effect.gen(function* () {
    return yield* deviceregistry.GetNamespace({
      subscriptionId: yield* subscription,
      resourceGroupName,
      namespaceName,
    });
  });

const program = (props: { name?: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const namespace = yield* Azure.DeviceRegistry.Namespace("Namespace", {
      resourceGroup: group.resourceGroupName,
      location,
      name: props.name,
      tags: props.tags,
    });
    return { group, namespace };
  });

// Device Registry namespaces are free (preview); provisioning takes ~1 minute.
test.provider(
  "create, update, replace, and delete a device registry namespace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace } = yield* stack.deploy(
        program({ tags: { env: "a" } }),
      );
      const get = (name: string) =>
        getNamespace(group.resourceGroupName, name);
      const observed = yield* get(namespace.namespaceName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("a");
      expect(observed.tags?.["alchemy::id"]).toEqual("Namespace");
      expect(namespace.uuid).toBeDefined();

      // In place: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "b" } }));
      expect(updated.namespace.namespaceId).toEqual(namespace.namespaceId);
      expect((yield* get(namespace.namespaceName)).tags?.env).toEqual("b");

      // Replacement: a new name.
      const newName = `${namespace.namespaceName.slice(0, 40)}-x`;
      const replaced = yield* stack.deploy(
        program({ name: newName, tags: { env: "b" } }),
      );
      expect(replaced.namespace.namespaceName).toEqual(newName);
      expect(replaced.namespace.namespaceId).not.toEqual(
        namespace.namespaceId,
      );
      expect(yield* waitGone(get(namespace.namespaceName))).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.namespace.namespaceName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
