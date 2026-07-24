import * as AWS from "@/AWS";
import { CustomVerificationEmailTemplate } from "@/AWS/SES";
import * as Test from "@/Test/Alchemy";
import * as sesv2 from "@distilled.cloud/aws/sesv2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// A custom verification email template can be created/updated/deleted on any
// account; only SENDING one requires production (out-of-sandbox) access. The
// FromEmailAddress must be a verified sending identity for the create call.
const FROM = "verify@alchemy-test.example.com";

class CvetStillExists extends Data.TaggedError("CvetStillExists")<{
  readonly name: string;
}> {}

const assertCvetDeleted = (name: string) =>
  sesv2.getCustomVerificationEmailTemplate({ TemplateName: name }).pipe(
    Effect.flatMap(() => Effect.fail(new CvetStillExists({ name }))),
    Effect.catchTag("NotFoundException", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "CvetStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "custom verification template lifecycle: create, update, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const template = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CustomVerificationEmailTemplate("Verify", {
            fromEmailAddress: FROM,
            templateSubject: "Please confirm your email",
            templateContent:
              "<html><body>Click to verify your address.</body></html>",
            successRedirectionURL: "https://example.com/verified",
            failureRedirectionURL: "https://example.com/verify-failed",
          });
        }),
      );

      expect(template.templateName).toBeDefined();

      // out-of-band verification via distilled
      const observed = yield* sesv2.getCustomVerificationEmailTemplate({
        TemplateName: template.templateName,
      });
      expect(observed.TemplateSubject).toBe("Please confirm your email");
      expect(observed.SuccessRedirectionURL).toBe(
        "https://example.com/verified",
      );

      // update subject and content in place
      yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CustomVerificationEmailTemplate("Verify", {
            fromEmailAddress: FROM,
            templateSubject: "Confirm your email address",
            templateContent: "<html><body>Verify to get started.</body></html>",
            successRedirectionURL: "https://example.com/done",
            failureRedirectionURL: "https://example.com/verify-failed",
          });
        }),
      );
      const updated = yield* sesv2.getCustomVerificationEmailTemplate({
        TemplateName: template.templateName,
      });
      expect(updated.TemplateSubject).toBe("Confirm your email address");
      expect(updated.SuccessRedirectionURL).toBe("https://example.com/done");

      yield* stack.destroy();
      yield* assertCvetDeleted(template.templateName);
    }),
  { timeout: 120_000 },
);

test.provider(
  "custom name replaces on rename",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CustomVerificationEmailTemplate("Named", {
            templateName: "alchemy-test-cvet-a",
            fromEmailAddress: FROM,
            templateSubject: "A",
            templateContent: "<html><body>A</body></html>",
            successRedirectionURL: "https://example.com/a",
            failureRedirectionURL: "https://example.com/a-fail",
          });
        }),
      );
      expect(first.templateName).toBe("alchemy-test-cvet-a");

      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* CustomVerificationEmailTemplate("Named", {
            templateName: "alchemy-test-cvet-b",
            fromEmailAddress: FROM,
            templateSubject: "B",
            templateContent: "<html><body>B</body></html>",
            successRedirectionURL: "https://example.com/b",
            failureRedirectionURL: "https://example.com/b-fail",
          });
        }),
      );
      expect(second.templateName).toBe("alchemy-test-cvet-b");
      yield* assertCvetDeleted("alchemy-test-cvet-a");

      yield* stack.destroy();
      yield* assertCvetDeleted("alchemy-test-cvet-b");
    }),
  { timeout: 120_000 },
);
