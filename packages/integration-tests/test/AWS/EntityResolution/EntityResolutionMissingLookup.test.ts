import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:entityresolution", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (id mapping workflow, id namespace, matching workflow, schema mapping).
test.provider(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-id-mapping-workflow": AWS.EntityResolution.IdMappingWorkflow.lookup({
          workflowName: name,
        }).workflowName,
        "missing-id-namespace": AWS.EntityResolution.IdNamespace.lookup({ idNamespaceName: name })
          .idNamespaceName,
        "missing-matching-workflow": AWS.EntityResolution.MatchingWorkflow.lookup({
          workflowName: name,
        }).workflowName,
        "missing-schema-mapping": AWS.EntityResolution.SchemaMapping.lookup({ schemaName: name })
          .schemaName,
      });
    }),
  { tags, timeout: 180_000 },
);
