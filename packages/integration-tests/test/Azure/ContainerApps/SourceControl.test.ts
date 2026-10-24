import * as Azure from "@alchemy.run/azure";
import { ensureRegistered } from "@alchemy.run/azure/Arm";
import * as app from "@distilled.cloud/azure/app";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { runPaidOnly } from "../gates.ts";
import { probeGroup } from "./fixtures/connected.ts";
import { logLevel, QUICKSTART_IMAGE, waitGone } from "./fixtures/shared.ts";

/*
 * Source control commits a GitHub Actions workflow to a real repository,
 * so the lifecycle needs an external GitHub repository and credentials:
 *
 *   AZURE_TEST_CONTAINERAPPS_GITHUB_REPO      https://github.com/<owner>/<repo>
 *   AZURE_TEST_CONTAINERAPPS_GITHUB_TOKEN     PAT with repo + workflow scopes
 *   AZURE_TEST_CONTAINERAPPS_SP_CLIENT_ID     service principal the workflow deploys with
 *   AZURE_TEST_CONTAINERAPPS_SP_SECRET
 *   AZURE_TEST_CONTAINERAPPS_REGISTRY_URL     registry the workflow pushes to
 *   AZURE_TEST_CONTAINERAPPS_REGISTRY_USER
 *   AZURE_TEST_CONTAINERAPPS_REGISTRY_PASSWORD
 *
 * The repository needs `main` and `alchemy-test` branches with a Dockerfile.
 */
const env = (name: string) => process.env[`AZURE_TEST_CONTAINERAPPS_${name}`] ?? "";

// Express environment: provisions in seconds.
const LOCATION = "eastus";

/** Name of a container app that does not exist (probes). */
const MISSING_APP = "alchemy-missing-app";

const { test } = Test.make({ providers: Azure.providers() });

const tags = ["provider:azure", "provider:azure:containerapps", "live"];

const getSourceControl = (resourceGroupName: string, containerAppName: string) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* app.GetContainerAppsSourceControl({
      subscriptionId,
      resourceGroupName,
      containerAppName,
      sourceControlName: "current",
    });
  });

const program = (props: { branch: string }) =>
  Effect.gen(function* () {
    const { tenantId, subscriptionId } = yield* Azure.AzureEnvironment.current;
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    const environment = yield* Azure.ContainerApps.ManagedEnvironment("Env", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      environmentMode: "Express",
    });
    const api = yield* Azure.ContainerApps.ContainerApp("Api", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
      environmentId: environment.environmentId,
      configuration: { ingress: { external: true, targetPort: 80 } },
      template: {
        containers: [{ name: "api", image: QUICKSTART_IMAGE }],
        scale: { minReplicas: 0, maxReplicas: 1 },
      },
    });
    const ci = yield* Azure.ContainerApps.SourceControl("Ci", {
      resourceGroup: group.resourceGroupName,
      containerApp: api.containerAppName,
      repoUrl: env("GITHUB_REPO"),
      branch: props.branch,
      githubActionConfiguration: {
        githubPersonalAccessToken: Redacted.make(env("GITHUB_TOKEN")),
        registryInfo: {
          registryUrl: env("REGISTRY_URL"),
          registryUserName: env("REGISTRY_USER"),
          registryPassword: Redacted.make(env("REGISTRY_PASSWORD")),
        },
        azureCredentials: {
          clientId: env("SP_CLIENT_ID"),
          clientSecret: Redacted.make(env("SP_SECRET")),
          tenantId,
          subscriptionId,
        },
        contextPath: "./",
        image: "alchemy/source-control-test",
      },
    });
    return { group, api, ci };
  });

// ~$0 Azure (Express environment, scale-to-zero app), 10 min; needs the
// external GitHub repository and credentials listed above.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a container app source control",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, api, ci } = yield* stack.deploy(program({ branch: "main" }));
      expect(ci.branch).toEqual("main");
      expect(ci.repoUrl?.toLowerCase()).toEqual(env("GITHUB_REPO").toLowerCase());
      const get = getSourceControl(group.resourceGroupName, api.containerAppName);
      expect((yield* get).properties?.operationState).toEqual("Succeeded");

      // In-place update: the deployment branch.
      const updated = yield* stack.deploy(program({ branch: "alchemy-test" }));
      expect(updated.ci.sourceControlId).toEqual(ci.sourceControlId);
      expect((yield* get).properties?.branch).toEqual("alchemy-test");

      yield* stack.destroy();
      expect(yield* waitGone(get)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 1_200_000 },
);

// Ungated probe (free, a resource group only): source control on a
// missing container app is rejected with the typed error.
test.provider(
  "a missing container app rejects the source control with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(probeGroup);
      const { subscriptionId } = yield* Azure.AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.App");
      const error = yield* app
        .ContainerAppsSourceControlsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          containerAppName: MISSING_APP,
          sourceControlName: "current",
          properties: { repoUrl: "https://github.com/alchemy-run/missing", branch: "main" },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("ResourceNotFound");

      // Through the provider: reconcile observes nothing, PUTs, and
      // surfaces the same typed error.
      const deployError = yield* stack
        .deploy(
          Effect.gen(function* () {
            const probe = yield* probeGroup;
            const ci = yield* Azure.ContainerApps.SourceControl("Ci", {
              resourceGroup: probe.group.resourceGroupName,
              containerApp: MISSING_APP,
              repoUrl: "https://github.com/alchemy-run/missing",
              branch: "main",
            });
            return { ci };
          }),
        )
        .pipe(Effect.flip);
      expect(JSON.stringify(deployError)).toContain("ResourceNotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
