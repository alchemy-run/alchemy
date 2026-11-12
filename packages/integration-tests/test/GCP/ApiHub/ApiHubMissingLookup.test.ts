import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:apihub", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-api": GCP.ApiHub.Api.lookup({ apiId: name }).name,
        "missing-api-hub-instance": GCP.ApiHub.ApiHubInstance.lookup({ apiHubInstanceId: name })
          .name,
        "missing-apis-version": GCP.ApiHub.ApisVersion.lookup({ versionId: name, api: name }).name,
        "missing-apis-versions-operation": GCP.ApiHub.ApisVersionsOperation.lookup({
          apiOperationId: name,
          version: name,
        }).name,
        "missing-apis-versions-spec": GCP.ApiHub.ApisVersionsSpec.lookup({
          specId: name,
          version: name,
        }).name,
        "missing-curation": GCP.ApiHub.Curation.lookup({ curationId: name }).name,
        "missing-dependency": GCP.ApiHub.Dependency.lookup({ dependencyId: name }).name,
        "missing-deployment": GCP.ApiHub.Deployment.lookup({ deploymentId: name }).name,
        "missing-external-api": GCP.ApiHub.ExternalApi.lookup({ externalApiId: name }).name,
        "missing-plugins-instance": GCP.ApiHub.PluginsInstance.lookup({
          pluginInstanceId: name,
          plugin: name,
        }).name,
      });
    }),
  { tags, timeout: 210000 },
);
