import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as forms from "@distilled.cloud/gcp/forms_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: GCP.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const hasGcpCreds = !!(
  process.env.GOOGLE_PROJECT_ID &&
  (process.env.GOOGLE_ACCESS_TOKEN ||
    process.env.GOOGLE_APPLICATION_CREDENTIALS)
);

const runLifecycle =
  hasGcpCreds && !!process.env.GCP_TEST_FORMS && !process.env.FAST;

const waitUntilGone = (formId: string) =>
  forms.getForms({ formId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getForms on a missing form fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        forms.getForms({ formId: "alchemy-missing-form" }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || runLifecycle)(
  "createForms without Forms access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        forms.createForms({
          unpublished: true,
          body: { info: { title: "alchemy-forms-probe" } },
        }),
      );
      expect(["Forbidden", "NotFound", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a form",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Forms.Form("Survey", {
            title: "alchemy-survey",
            unpublished: true,
          });
        }),
      );

      expect(created.formId).toEqual(expect.any(String));
      expect(created.title).toEqual("alchemy-survey");

      const fetched = yield* forms.getForms({ formId: created.formId });
      expect(fetched.formId).toEqual(created.formId);
      expect(fetched.info?.title).toContain("alchemy-");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Forms.Form("Survey", {
            formId: created.formId,
            title: "alchemy-survey-v2",
            description: "updated",
            unpublished: true,
          });
        }),
      );
      expect(updated.formId).toEqual(created.formId);
      expect(updated.title).toEqual("alchemy-survey-v2");
      expect(updated.description).toEqual("updated");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.formId);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
