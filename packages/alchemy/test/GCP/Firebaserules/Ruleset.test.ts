import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as firebaserules from "@distilled.cloud/gcp/firebaserules_v1";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "";

const denyRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if false;
    }
  }
}`;

const authRules = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /{document=**} {
      allow read, write: if request.auth != null;
    }
  }
}`;

const waitUntilGone = (name: string) =>
  firebaserules.getProjectsRulesets({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

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
  "getProjectsRulesets on a missing ruleset fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        firebaserules.getProjectsRulesets({
          name: `projects/${project}/rulesets/alchemy-missing-xxxx`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, replace, and delete a firebaserules ruleset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAccess;
      if (access !== "ok") {
        expect(access).toEqual("Forbidden");
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firebaserules.Ruleset("Firestore", {
            source: {
              files: [{ name: "firestore.rules", content: denyRules }],
            },
          });
        }),
      );

      expect(created.name).toEqual(
        `projects/${project}/rulesets/${created.rulesetId}`,
      );
      expect(created.rulesetId).toEqual(expect.any(String));
      expect(created.project).toEqual(project);
      expect(created.source.files[0]?.name).toEqual("firestore.rules");
      expect(created.source.files[0]?.content).toEqual(denyRules);
      expect(created.source.files[0]?.content).not.toContain("[alchemy ");

      const fetched = yield* firebaserules.getProjectsRulesets({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.source?.files?.[0]?.content).toContain("alchemy-id=");
      expect(fetched.source?.files?.[0]?.content).toContain("if false");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Firebaserules.Ruleset("Firestore", {
            source: {
              files: [{ name: "firestore.rules", content: authRules }],
            },
          });
        }),
      );

      expect(replaced.name).not.toEqual(created.name);
      expect(replaced.source.files[0]?.content).toEqual(authRules);

      const fetchedReplacement = yield* firebaserules.getProjectsRulesets({
        name: replaced.name,
      });
      expect(fetchedReplacement.source?.files?.[0]?.content).toContain(
        "request.auth != null",
      );

      const previousGone = yield* waitUntilGone(created.name);
      expect(previousGone).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
