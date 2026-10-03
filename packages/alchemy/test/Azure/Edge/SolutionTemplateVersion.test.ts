import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as edge from "@distilled.cloud/azure/edge";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  configTemplateYaml,
  helmSpecification,
  location,
  logLevel,
  subscription,
  tags,
  waitGone,
  withContext,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getVersion = (
  resourceGroupName: string,
  solutionTemplateName: string,
  solutionTemplateVersionName: string,
) =>
  Effect.gen(function* () {
    return yield* edge.GetSolutionTemplateVersion({
      subscriptionId: yield* subscription,
      resourceGroupName,
      solutionTemplateName,
      solutionTemplateVersionName,
    });
  });

const program = (props: { version: string; chart: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const context = yield* Azure.Edge.Context("Context", {
      resourceGroup: group.resourceGroupName,
      capabilities: [{ name: "soap", description: "Soap" }],
      hierarchies: [{ name: "country", description: "Country" }],
    });
    const template = yield* Azure.Edge.SolutionTemplate("Template", {
      resourceGroup: group.resourceGroupName,
      description: "Alchemy test solution",
      capabilities: Output.map(context.capabilities, (capabilities) =>
        capabilities.map((c) => c.name),
      ),
    });
    const version = yield* Azure.Edge.SolutionTemplateVersion("Version", {
      resourceGroup: group.resourceGroupName,
      solutionTemplate: template.solutionTemplateName,
      version: props.version,
      configurations: configTemplateYaml("Greeting"),
      specification: helmSpecification(props.chart),
    });
    return { group, template, version };
  });

// Free control-plane resources; provision in seconds.
test.provider(
  "create, replace, and delete a solution template version",
  (stack) =>
    withContext(
      Effect.gen(function* () {
        yield* stack.destroy();

        const { group, template, version } = yield* stack.deploy(
          program({ version: "1.0.0", chart: "1.0.0" }),
        );
        const get = (name: string) =>
          getVersion(
            group.resourceGroupName,
            template.solutionTemplateName,
            name,
          );
        expect(version.solutionTemplateVersionId).toContain("/versions/1.0.0");
        const observed = yield* get("1.0.0");
        expect(observed.properties?.configurations).toEqual(
          configTemplateYaml("Greeting"),
        );
        expect(observed.properties?.specification).toEqual(
          helmSpecification("1.0.0"),
        );

        // Replacement under the same name: a new chart (delete first).
        yield* stack.deploy(program({ version: "1.0.0", chart: "1.0.1" }));
        expect((yield* get("1.0.0")).properties?.specification).toEqual(
          helmSpecification("1.0.1"),
        );

        // Replacement under a new name.
        yield* stack.deploy(program({ version: "1.0.1", chart: "1.0.1" }));
        expect((yield* get("1.0.1")).properties?.specification).toEqual(
          helmSpecification("1.0.1"),
        );
        expect(yield* waitGone(get("1.0.0"))).toEqual("gone");

        yield* stack.destroy();
        expect(yield* waitGone(get("1.0.1"))).toEqual("gone");
      }),
    ).pipe(logLevel),
  { tags, timeout: 600_000 },
);
