import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as firebaserules from "@distilled.cloud/gcp/firebaserules_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";

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

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const denyRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;

const probeAccess = firebaserules
  .listProjectsRulesets({
    name: `projects/${project}`,
    pageSize: 1,
  })
  .pipe(
    Effect.as("ok" as const),
    Effect.catchTag("Forbidden", () => Effect.succeed("Forbidden" as const)),
  );

test.provider.skipIf(!hasGcpCreds)(
  "TestRuleset and GetReleaseExecutable round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAccess;
      if (access !== "ok") {
        expect(access).toEqual("Forbidden");
        yield* stack.destroy();
        return;
      }

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const ruleset = yield* GCP.Firebaserules.Ruleset("Firestore", {
            source: {
              files: [{ name: "firestore.rules", content: denyRules }],
            },
          });
          const release = yield* GCP.Firebaserules.Release("Live", {
            rulesetName: ruleset.name,
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              const testRuleset = yield* GCP.Firebaserules.TestRuleset(ruleset);
              const getExecutable =
                yield* GCP.Firebaserules.GetReleaseExecutable(release);
              return Effect.fn(function* () {
                const tested = yield* testRuleset({
                  body: { testSuite: { testCases: [] } },
                });
                const executable = yield* getExecutable().pipe(
                  Effect.catchTag(["NotFound", "Forbidden"], (error) =>
                    Effect.succeed({ _tag: error._tag }),
                  ),
                );
                return { tested, executable };
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(Array.isArray(out.tested.issues ?? [])).toEqual(true);
      expect(Array.isArray(out.tested.testResults ?? [])).toEqual(true);
      if ("_tag" in out.executable) {
        expect(["NotFound", "Forbidden"]).toContain(out.executable._tag);
      } else {
        expect(out.executable.rulesetName).toEqual(expect.any(String));
        expect(out.executable.rulesetName ?? "").toContain("/rulesets/");
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
