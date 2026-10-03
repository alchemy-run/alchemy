import * as Azure from "@/Azure";
import * as Output from "@/Output";
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

const getTemplate = (resourceGroupName: string, solutionTemplateName: string) =>
  Effect.gen(function* () {
    return yield* edge.GetSolutionTemplate({
      subscriptionId: yield* subscription,
      resourceGroupName,
      solutionTemplateName,
    });
  });

const program = (props: {
  name?: string;
  description: string;
  capabilityCount: number;
  state?: "active" | "inactive";
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const context = yield* Azure.Edge.Context("Context", {
      resourceGroup: group.resourceGroupName,
      capabilities: [
        { name: "soap", description: "Soap" },
        { name: "shampoo", description: "Shampoo" },
      ],
      hierarchies: [{ name: "country", description: "Country" }],
    });
    const template = yield* Azure.Edge.SolutionTemplate("Template", {
      resourceGroup: group.resourceGroupName,
      name: props.name,
      description: props.description,
      // Derived from the context so the template is deleted before it.
      capabilities: Output.map(context.capabilities, (capabilities) =>
        capabilities.slice(0, props.capabilityCount).map((c) => c.name),
      ),
      state: props.state,
      tags: props.tags,
    });
    return { group, context, template };
  });

// Free control-plane resources; provision in seconds.
test.provider(
  "create, update, replace, and delete a solution template",
  (stack) =>
    withContext(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { group, template } = yield* stack.deploy(
          program({
            description: "first",
            capabilityCount: 1,
            tags: { env: "test" },
          }),
        );
        const rg = group.resourceGroupName;
        expect(template.capabilities).toEqual(["soap"]);
        const observed = yield* getTemplate(rg, template.solutionTemplateName);
        expect(observed.properties?.description).toEqual("first");
        expect(observed.tags?.["alchemy::id"]).toEqual("Template");

        // In-place: description, capabilities, state, and tags.
        const updated = yield* stack.deploy(
          program({
            description: "second",
            capabilityCount: 2,
            state: "inactive",
            tags: { env: "prod" },
          }),
        );
        expect(updated.template.solutionTemplateId).toEqual(
          template.solutionTemplateId,
        );
        const reobserved = yield* getTemplate(
          rg,
          template.solutionTemplateName,
        );
        expect(reobserved.properties?.description).toEqual("second");
        expect(reobserved.properties?.capabilities).toEqual([
          "soap",
          "shampoo",
        ]);
        expect(reobserved.properties?.state).toEqual("inactive");
        expect(reobserved.tags?.env).toEqual("prod");

        // Replacement: a new name.
        const replaced = yield* stack.deploy(
          program({
            name: "alchemy-solution-renamed",
            description: "second",
            capabilityCount: 2,
            state: "inactive",
            tags: { env: "prod" },
          }),
        );
        expect(replaced.template.solutionTemplateName).toEqual(
          "alchemy-solution-renamed",
        );
        expect(
          (yield* getTemplate(rg, "alchemy-solution-renamed")).properties
            ?.description,
        ).toEqual("second");
        expect(
          yield* waitGone(getTemplate(rg, template.solutionTemplateName)),
        ).toEqual("gone");

        yield* stack.destroy();
        expect(
          yield* waitGone(getTemplate(rg, "alchemy-solution-renamed")),
        ).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
