import * as GCP from "@alchemy.run/gcp";
import * as Effect from "effect/Effect";
import { deployProject } from "../../deployProject.ts";

/** Cloud Asset resources the generated bindings bind. */
export const ProbeFeed = Effect.gen(function* () {
  const topic = yield* GCP.PubSub.Topic("ProbeAssetEvents", {});
  return yield* GCP.CloudAsset.Feed("ProbeFeed", {
    pubsubTopic: topic.name,
    assetTypes: ["storage.googleapis.com/Bucket"],
    contentType: "RESOURCE",
  });
});
export const ProbeSavedQuery = Effect.gen(function* () {
  const project = yield* deployProject;
  return yield* GCP.CloudAsset.SavedQuery("ProbeSavedQuery", {
    content: {
      iamPolicyAnalysisQuery: {
        scope: `projects/${project}`,
        accessSelector: { permissions: ["iam.serviceAccounts.actAs"] },
      },
    },
  });
});
