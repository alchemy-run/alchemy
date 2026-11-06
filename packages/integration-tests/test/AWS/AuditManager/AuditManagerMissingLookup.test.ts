import * as AWS from "@alchemy.run/aws";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Effect from "effect/Effect";
import { missingName } from "../../lookup.ts";
import { expectAllMissing } from "../lookup.ts";

const { test } = Test.make({ providers: AWS.providers() });

const tags = ["provider:aws", "provider:aws:auditmanager", "live"];

// A lookup of a resource that doesn't exist fails the deploy with
// LookupNotFoundError (assessment, control, framework).
// The testing account can't use AuditManager; an entitled account sets the gate.
test.provider.skipIf(!process.env.AWS_TEST_AUDITMANAGER)(
  "a lookup of a missing resource fails the deploy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const name = missingName(stack.stage);
      yield* expectAllMissing(stack, {
        "missing-assessment": AWS.AuditManager.Assessment.lookup({
          assessmentId: "11111111-1111-4111-8111-111111111111",
        }).assessmentId,
        "missing-control": AWS.AuditManager.Control.lookup({
          controlId: "11111111-1111-4111-8111-111111111111",
        }).controlId,
        "missing-framework": AWS.AuditManager.Framework.lookup({
          frameworkId: "11111111-1111-4111-8111-111111111111",
        }).frameworkId,
      });
    }),
  { tags, timeout: 180_000 },
);
