import * as GCP from "@alchemy.run/gcp";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: GCP.providers() });

const tags = ["provider:gcp", "provider:gcp:artifactregistry", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError.
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-repositories-attachment": GCP.ArtifactRegistry.RepositoriesAttachment.lookup({
          attachmentId: name,
          repository: name,
        }).name,
        "missing-repositories-packages-tag": GCP.ArtifactRegistry.RepositoriesPackagesTag.lookup({
          tagId: name,
          repository: name,
          packageId: name,
        }).name,
        "missing-repositories-rule": GCP.ArtifactRegistry.RepositoriesRule.lookup({
          ruleId: name,
          repository: name,
        }).name,
      });
    }),
  { tags, timeout: 105000 },
);
