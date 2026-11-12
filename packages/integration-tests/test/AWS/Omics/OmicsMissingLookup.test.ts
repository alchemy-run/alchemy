import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:omics", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (annotation store, reference store, run group, sequence store, variant store, workflow).
// The testing account can't use Omics; an entitled account sets the gate.
test.provider.skipIf(!process.env.AWS_TEST_OMICS)(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      // Store, run group and workflow ids are numeric (10-36 and 1-18 digits): use ones never issued.
      const missingStoreId = "9999999999";
      const missingId = "999999999999999999";
      yield* expectAllMissing(stack, {
        "missing-annotation-store": AWS.Omics.AnnotationStore.lookup({ name: name })
          .annotationStoreId,
        "missing-reference-store": AWS.Omics.ReferenceStore.lookup({
          referenceStoreId: missingStoreId,
        }).referenceStoreId,
        "missing-run-group": AWS.Omics.RunGroup.lookup({ runGroupId: missingId }).runGroupId,
        "missing-sequence-store": AWS.Omics.SequenceStore.lookup({
          sequenceStoreId: missingStoreId,
        }).sequenceStoreId,
        "missing-variant-store": AWS.Omics.VariantStore.lookup({ name: name }).variantStoreId,
        "missing-workflow": AWS.Omics.Workflow.lookup({ workflowId: missingId }).workflowId,
      });
    }),
  { tags, timeout: 180_000 },
);
