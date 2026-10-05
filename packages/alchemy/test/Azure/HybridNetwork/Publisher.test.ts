import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as hybridnetwork from "@distilled.cloud/azure/hybridnetwork";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPublisher = (resourceGroupName: string, publisherName: string) =>
  Effect.gen(function* () {
    return yield* hybridnetwork.GetPublisher({
      subscriptionId: yield* subscription,
      resourceGroupName,
      publisherName,
    });
  });

const program = (props: { name?: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const publisher = yield* Azure.HybridNetwork.Publisher("Publisher", {
      resourceGroup: group.resourceGroupName,
      location,
      name: props.name,
      tags: props.tags,
    });
    return { group, publisher };
  });

// Publishers are free metadata resources (~1 minute).
test.provider(
  "create, update, replace, and delete a publisher",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, publisher } = yield* stack.deploy(
        program({ tags: { env: "one" } }),
      );
      const get = (name: string) => getPublisher(group.resourceGroupName, name);
      expect(publisher.scope).toEqual("Private");
      const observed = yield* get(publisher.publisherName);
      expect(observed.properties?.scope).toEqual("Private");
      expect(observed.tags?.env).toEqual("one");
      expect(observed.tags?.["alchemy::id"]).toEqual("Publisher");

      // In-place: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "two" } }));
      expect(updated.publisher.publisherId).toEqual(publisher.publisherId);
      expect(updated.publisher.tags).toEqual({ env: "two" });
      expect((yield* get(publisher.publisherName)).tags?.env).toEqual("two");

      // Replacement: the name is immutable.
      const renamed = `${publisher.publisherName.slice(0, 50)}-r`;
      const replaced = yield* stack.deploy(
        program({ name: renamed, tags: { env: "two" } }),
      );
      expect(replaced.publisher.publisherName).toEqual(renamed);
      expect((yield* get(renamed)).properties?.provisioningState).toEqual(
        "Succeeded",
      );
      expect(yield* waitGone(get(publisher.publisherName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(renamed))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
