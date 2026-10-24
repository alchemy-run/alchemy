import * as Azure from "@alchemy.run/azure";
import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { caller, labNetworkFixture, logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getEnvironment = (
  resourceGroupName: string,
  labName: string,
  userName: string,
  name: string,
) =>
  Effect.gen(function* () {
    return yield* devtestlabs.GetEnvironment({
      subscriptionId: yield* subscription,
      resourceGroupName,
      labName,
      userName,
      name,
    });
  });

/**
 * Every lab gets Microsoft's "Public Environment Repo" artifact source,
 * disabled. Enable it out of band and return the ID of its `WebApp`
 * template (an S1 App Service plan + web app, no parameters).
 */
const publicWebAppTemplate = (resourceGroupName: string, labName: string) =>
  Effect.gen(function* () {
    const subscriptionId = yield* subscription;
    const sources = yield* devtestlabs.ListArtifactSources({
      subscriptionId,
      resourceGroupName,
      labName,
    });
    const source = sources.value.find(
      (s) => s.properties?.armTemplateFolderPath !== undefined && s.name !== undefined,
    );
    expect(source?.name?.toLowerCase()).toEqual("public environment repo");
    const sourceName = source!.name!;
    if (source!.properties?.status !== "Enabled") {
      yield* devtestlabs.ArtifactSourcesCreateOrUpdate({
        subscriptionId,
        resourceGroupName,
        labName,
        name: sourceName,
        location: source!.location,
        properties: { status: "Enabled" },
      });
    }
    // The repository is indexed asynchronously after it is enabled.
    const templates = yield* devtestlabs
      .ListArmTemplates({
        subscriptionId,
        resourceGroupName,
        labName,
        artifactSourceName: sourceName,
      })
      .pipe(
        Effect.repeat({
          schedule: Schedule.spaced("5 seconds"),
          until: (list) => list.value.some((t) => t.name === "WebApp"),
          times: 12,
        }),
      );
    const template = templates.value.find((t) => t.name === "WebApp");
    expect(template?.id).toMatch(/\/armtemplates\/WebApp$/i);
    return template!.id!;
  });

/**
 * Lab, lab user, and a lab VNet whose subnet allows VM creation: without
 * one every environment fails with `NoMatchingSubnetFoundAllowingVmCreation`
 * (all free).
 */
const environmentFixture = () =>
  Effect.gen(function* () {
    const { oid, tid } = yield* caller;
    const { group, lab, network } = yield* labNetworkFixture();
    const user = yield* Azure.DevTestLabs.User("LabUser", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      objectId: oid,
      tenantId: tid,
    });
    return { group, lab, network, user };
  });

const program = (props: {
  armTemplateId: string;
  name?: string;
  displayName: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group, lab, user } = yield* environmentFixture();
    const environment = yield* Azure.DevTestLabs.Environment("WebEnv", {
      resourceGroup: group.resourceGroupName,
      lab: lab.labName,
      user: user.userName,
      name: props.name,
      armTemplateId: props.armTemplateId,
      armTemplateDisplayName: props.displayName,
      tags: props.tags,
    });
    return { group, lab, user, environment };
  });

// A free lab and user, plus the template's S1 App Service plan (~$0.10/hour)
// for ~10 minutes: ~$0.02. The lab takes 2-5 minutes, each environment 1-3.
// Skipped: the environment ends in 'Failed' after ~3 minutes. The activity
// log shows InvalidTemplateDeployment: "Authorization failed for template
// resource '...-sp' of type 'Microsoft.Web/serverfarms'. The client
// '1a14be2a-e903-4cec-99cf-b2e209259a0f' [Azure Lab Services] ... does not
// have permission to perform action 'Microsoft.Web/serverfarms/write' at
// scope '<environment resource group>'" when a service principal is the lab
// user.
test.provider.skip(
  "create, update, replace, and delete a lab environment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const base = yield* stack.deploy(environmentFixture());
      const armTemplateId = yield* publicWebAppTemplate(
        base.group.resourceGroupName,
        base.lab.labName,
      );

      const { group, lab, user, environment } = yield* stack.deploy(
        program({ armTemplateId, displayName: "WebApp", tags: { env: "test" } }),
      );
      const get = (name: string) =>
        getEnvironment(group.resourceGroupName, lab.labName, user.userName, name);
      const observed = yield* get(environment.environmentName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.deploymentProperties?.armTemplateId?.toLowerCase()).toEqual(
        armTemplateId.toLowerCase(),
      );
      expect(environment.environmentResourceGroupId).toMatch(/\/resourceGroups\/[^/]+$/i);
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("WebEnv");

      // In-place: display name + tags.
      const updated = yield* stack.deploy(
        program({ armTemplateId, displayName: "Web app", tags: { env: "prod" } }),
      );
      expect(updated.environment.environmentId).toEqual(environment.environmentId);
      const reobserved = yield* get(environment.environmentName);
      expect(reobserved.properties?.armTemplateDisplayName).toEqual("Web app");
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: a new name.
      const replaced = yield* stack.deploy(
        program({
          armTemplateId,
          name: "alchemy-webenv-2",
          displayName: "Web app",
          tags: { env: "prod" },
        }),
      );
      expect(replaced.environment.environmentName).toEqual("alchemy-webenv-2");
      const moved = yield* get(replaced.environment.environmentName);
      expect(moved.properties?.provisioningState).toEqual("Succeeded");
      expect(yield* waitGone(get(environment.environmentName))).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.environment.environmentName))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_200_000 },
);
