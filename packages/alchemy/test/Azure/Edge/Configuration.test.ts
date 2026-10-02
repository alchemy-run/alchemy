import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as edge from "@distilled.cloud/azure/edge";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConfiguration = (
  resourceGroupName: string,
  configurationName: string,
) =>
  Effect.gen(function* () {
    return yield* edge.GetConfiguration({
      subscriptionId: yield* subscription,
      resourceGroupName,
      configurationName,
    });
  });

const program = (props: { name?: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const configuration = yield* Azure.Edge.Configuration("Configuration", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      tags: props.tags,
    });
    return { group, configuration };
  });

// Free control-plane resource; provisions in seconds.
test.provider(
  "create, update, replace, and delete a configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, configuration } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(configuration.location).toEqual(location);
      const observed = yield* getConfiguration(
        rg,
        configuration.configurationName,
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Configuration");

      // In-place: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.configuration.configurationId).toEqual(
        configuration.configurationId,
      );
      expect(
        (yield* getConfiguration(rg, configuration.configurationName)).tags
          ?.env,
      ).toEqual("prod");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({ name: "alchemy-config-renamed", tags: { env: "prod" } }),
      );
      expect(replaced.configuration.configurationName).toEqual(
        "alchemy-config-renamed",
      );
      expect(
        (yield* getConfiguration(rg, "alchemy-config-renamed")).tags?.env,
      ).toEqual("prod");
      expect(
        yield* waitGone(getConfiguration(rg, configuration.configurationName)),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(getConfiguration(rg, "alchemy-config-renamed")),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
