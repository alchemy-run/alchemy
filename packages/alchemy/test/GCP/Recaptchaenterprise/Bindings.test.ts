import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as recaptchaenterprise from "@distilled.cloud/gcp/recaptchaenterprise_v1";
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

const waitUntilGone = (name: string) =>
  recaptchaenterprise.getProjectsKeys({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "CreateAssessment on a SCORE key",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const key = yield* GCP.Recaptchaenterprise.Key("Signup", {
            displayName: "alchemy recaptcha assess",
            testingOptions: { testingScore: 0.8 },
            webSettings: {
              integrationType: "SCORE",
              allowAllDomains: true,
            },
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* key.name;
              const createAssessment =
                yield* GCP.Recaptchaenterprise.CreateAssessment(key);
              return Effect.fn(function* () {
                return yield* createAssessment({
                  body: {
                    event: {
                      token: "03AGdBq27",
                      expectedAction: "login",
                    },
                  },
                }).pipe(
                  Effect.retry({
                    while: (error) =>
                      error._tag === "BadRequest" &&
                      error.message.includes("siteKey is invalid"),
                    schedule: Schedule.spaced("1 second"),
                    times: 8,
                  }),
                );
              });
            }),
          );
          return { key, assessment: yield* Probe({}) };
        }),
      );

      expect(out.key.name).toContain("/keys/");
      expect(out.assessment.name).toContain("/assessments/");
      expect(out.assessment.event?.siteKey).toEqual(out.key.keyId);
      expect(out.assessment.tokenProperties?.valid).toEqual(false);

      yield* stack.destroy();

      const gone = yield* waitUntilGone(out.key.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
