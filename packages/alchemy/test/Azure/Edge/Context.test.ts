import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as edge from "@distilled.cloud/azure/edge";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  location,
  logLevel,
  subscription,
  tags,
  waitGone,
  withContext,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getContext = (resourceGroupName: string, contextName: string) =>
  Effect.gen(function* () {
    return yield* edge.GetContext({
      subscriptionId: yield* subscription,
      resourceGroupName,
      contextName,
    });
  });

const program = (props: {
  name?: string;
  capabilities: string[];
  hierarchies: string[];
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const context = yield* Azure.Edge.Context("Context", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      capabilities: props.capabilities.map((name) => ({
        name,
        description: `${name} capability`,
      })),
      hierarchies: props.hierarchies.map((name) => ({
        name,
        description: `${name} level`,
      })),
      tags: props.tags,
    });
    return { group, context };
  });

// Free control-plane resource; provisions in seconds. One context per
// subscription, so context suites run one at a time.
test.provider(
  "create, update, replace, and delete a context",
  (stack) =>
    withContext(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { group, context } = yield* stack.deploy(
          program({
            capabilities: ["soap"],
            hierarchies: ["country"],
            tags: { env: "test" },
          }),
        );
        const rg = group.resourceGroupName;
        expect(context.uniqueIdentifier).toBeDefined();
        const observed = yield* getContext(rg, context.contextName);
        expect(observed.properties?.capabilities.map((c) => c.name)).toEqual([
          "soap",
        ]);
        expect(observed.tags?.["alchemy::id"]).toEqual("Context");

        // In-place: capabilities, hierarchies, and tags.
        const updated = yield* stack.deploy(
          program({
            capabilities: ["soap", "shampoo"],
            hierarchies: ["country", "factory"],
            tags: { env: "prod" },
          }),
        );
        expect(updated.context.contextId).toEqual(context.contextId);
        const reobserved = yield* getContext(rg, context.contextName);
        expect(reobserved.properties?.capabilities.map((c) => c.name)).toEqual([
          "soap",
          "shampoo",
        ]);
        expect(reobserved.properties?.hierarchies.map((h) => h.name)).toEqual([
          "country",
          "factory",
        ]);
        expect(reobserved.tags?.env).toEqual("prod");

        // Replacement: a new name (delete first, one context per subscription).
        const replaced = yield* stack.deploy(
          program({
            name: "alchemy-context-renamed",
            capabilities: ["soap"],
            hierarchies: ["country"],
            tags: { env: "prod" },
          }),
        );
        expect(replaced.context.contextName).toEqual("alchemy-context-renamed");
        expect(
          (yield* getContext(rg, "alchemy-context-renamed")).properties
            ?.capabilities.length,
        ).toEqual(1);
        expect(yield* waitGone(getContext(rg, context.contextName))).toEqual(
          "gone",
        );

        yield* stack.destroy();
        expect(
          yield* waitGone(getContext(rg, "alchemy-context-renamed")),
        ).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
