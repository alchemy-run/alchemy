import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hybridnetwork from "@distilled.cloud/azure/hybridnetwork";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const program = (props: {
  name?: string;
  description: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const publisher = yield* Azure.HybridNetwork.Publisher("Publisher", {
      resourceGroup: group.resourceGroupName,
      location,
    });
    const item = yield* Azure.HybridNetwork.NetworkServiceDesignGroup("Item", {
      resourceGroup: group.resourceGroupName,
      publisher: publisher.publisherName,
      location,
      name: props.name,
      description: props.description,
      tags: props.tags,
    });
    return { group, publisher, item };
  });

// Free metadata resources (~2 minutes).
test.provider(
  "create, update, replace, and delete a NetworkServiceDesignGroup",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, publisher, item } = yield* stack.deploy(
        program({ description: "first", tags: { env: "one" } }),
      );
      const get = (name: string) =>
        Effect.gen(function* () {
          return yield* hybridnetwork.GetNetworkServiceDesignGroup({
            subscriptionId: yield* subscription,
            resourceGroupName: group.resourceGroupName,
            publisherName: publisher.publisherName,
            networkServiceDesignGroupName: name,
          });
        });
      const observed = yield* get(item.networkServiceDesignGroupName);
      expect(observed.properties?.description).toEqual("first");
      expect(observed.tags?.env).toEqual("one");

      // In-place: description and tags.
      const updated = yield* stack.deploy(
        program({ description: "second", tags: { env: "two" } }),
      );
      expect(updated.item.networkServiceDesignGroupId).toEqual(
        item.networkServiceDesignGroupId,
      );
      const reobserved = yield* get(item.networkServiceDesignGroupName);
      expect(reobserved.properties?.description).toEqual("second");
      expect(reobserved.tags?.env).toEqual("two");

      // Replacement: the name is immutable.
      const renamed = `${item.networkServiceDesignGroupName.slice(0, 50)}-r`;
      const replaced = yield* stack.deploy(
        program({ name: renamed, description: "second", tags: { env: "two" } }),
      );
      expect(replaced.item.networkServiceDesignGroupName).toEqual(renamed);
      expect((yield* get(renamed)).properties?.description).toEqual("second");
      expect(yield* waitGone(get(item.networkServiceDesignGroupName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(yield* waitGone(get(renamed))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
