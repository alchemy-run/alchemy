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
      yield* expectAllMissing(stack, {
        "missing-annotation-store": AWS.Omics.AnnotationStore.lookup({ name: name })
          .annotationStoreId,
        "missing-reference-store": AWS.Omics.ReferenceStore.lookup({ referenceStoreId: name })
          .referenceStoreId,
        "missing-run-group": AWS.Omics.RunGroup.lookup({ runGroupId: name }).runGroupId,
        "missing-sequence-store": AWS.Omics.SequenceStore.lookup({ sequenceStoreId: name })
          .sequenceStoreId,
        "missing-variant-store": AWS.Omics.VariantStore.lookup({ name: name }).variantStoreId,
        "missing-workflow": AWS.Omics.Workflow.lookup({ workflowId: name }).workflowId,
      });
    }),
  { tags, timeout: 180_000 },
);
