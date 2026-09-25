import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as drive from "@distilled.cloud/gcp/drive_v3";
import * as script from "@distilled.cloud/gcp/script_v1";
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

const MANIFEST = JSON.stringify({
  timeZone: "America/Chicago",
  exceptionLogging: "STACKDRIVER",
  runtimeVersion: "V8",
});

const CODE = "function hello() {\n  return 'hello';\n}\n";

const waitUntilGone = (scriptId: string, deploymentId: string) =>
  script.getProjectsDeployments({ scriptId, deploymentId }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const deleteScriptProject = (scriptId: string | undefined) =>
  scriptId
    ? drive.deleteFiles({ fileId: scriptId, supportsAllDrives: true }).pipe(
        Effect.catchTag(
          ["NotFound", "Forbidden", "BadRequest", "Conflict"],
          () => Effect.void,
        ),
        Effect.ignore,
      )
    : Effect.void;

type FixtureDeniedTag = "Forbidden" | "NotFound" | "BadRequest" | "Conflict";
type FixtureOk = { _tag: "ok"; scriptId: string; versionNumber: number };
type FixtureDenied = { _tag: FixtureDeniedTag; scriptId?: string };
type Fixture = FixtureOk | FixtureDenied;

const denied = (tag: FixtureDeniedTag): FixtureDenied => ({
  _tag: tag,
  scriptId: undefined,
});

const createFixture = () =>
  script
    .createProjects({
      body: { title: "alchemy-script-deployment" },
    })
    .pipe(
      Effect.flatMap((project) => {
        const scriptId = project.scriptId ?? "";
        return Effect.gen(function* () {
          yield* script.updateContentProjects({
            scriptId,
            body: {
              files: [
                { name: "appsscript", type: "JSON", source: MANIFEST },
                { name: "Code", type: "SERVER_JS", source: CODE },
              ],
            },
          });
          const version = yield* script.createProjectsVersions({
            scriptId,
            body: { description: "alchemy-script-v1" },
          });
          return {
            _tag: "ok" as const,
            scriptId,
            versionNumber: version.versionNumber ?? 1,
          } satisfies FixtureOk;
        }).pipe(
          Effect.catchTag(
            ["Forbidden", "NotFound", "BadRequest", "Conflict"],
            (error) =>
              deleteScriptProject(scriptId).pipe(Effect.as(denied(error._tag))),
          ),
        );
      }),
      Effect.catchTag(
        ["Forbidden", "NotFound", "BadRequest", "Conflict"],
        (error) => Effect.succeed(denied(error._tag)),
      ),
    );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsDeployments on a missing deployment fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        script.getProjectsDeployments({
          scriptId: "alchemy-missing-script",
          deploymentId: "alchemy-missing-deployment",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "createProjects without Apps Script access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* script
        .createProjects({
          body: { title: "alchemy-script-probe" },
        })
        .pipe(
          Effect.map((project) => ({
            _tag: "ok" as const,
            scriptId: project.scriptId,
          })),
          Effect.catchTag(["Forbidden", "NotFound", "BadRequest"], (error) =>
            Effect.succeed({ _tag: error._tag, scriptId: undefined }),
          ),
        );

      if (result._tag === "ok") {
        yield* deleteScriptProject(result.scriptId);
      } else {
        expect(["Forbidden", "NotFound", "BadRequest"]).toContain(result._tag);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, update, and delete a deployment",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const fixture: Fixture = yield* createFixture();
      if (fixture._tag !== "ok") {
        expect(["Forbidden", "NotFound", "BadRequest", "Conflict"]).toContain(
          fixture._tag,
        );
        yield* stack.destroy();
        return;
      }

      yield* Effect.gen(function* () {
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Script.Deployment("Api", {
              scriptId: fixture.scriptId,
              versionNumber: fixture.versionNumber,
              description: "v1",
            });
          }),
        );

        expect(created.deploymentId.length).toBeGreaterThan(0);
        expect(created.scriptId).toEqual(fixture.scriptId);
        expect(created.versionNumber).toEqual(fixture.versionNumber);
        expect(created.description).toEqual("v1");

        const fetched = yield* script.getProjectsDeployments({
          scriptId: created.scriptId,
          deploymentId: created.deploymentId,
        });
        expect(fetched.deploymentId).toEqual(created.deploymentId);
        expect(fetched.deploymentConfig?.description).toContain("[alchemy ");
        expect(fetched.deploymentConfig?.versionNumber).toEqual(
          fixture.versionNumber,
        );

        const version = yield* script.createProjectsVersions({
          scriptId: fixture.scriptId,
          body: { description: "alchemy-script-v2" },
        });

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* GCP.Script.Deployment("Api", {
              scriptId: created.scriptId,
              deploymentId: created.deploymentId,
              versionNumber: version.versionNumber ?? created.versionNumber,
              description: "v2",
            });
          }),
        );

        expect(updated.deploymentId).toEqual(created.deploymentId);
        expect(updated.description).toEqual("v2");
        expect(updated.versionNumber).toEqual(
          version.versionNumber ?? created.versionNumber,
        );

        const fetchedUpdate = yield* script.getProjectsDeployments({
          scriptId: updated.scriptId,
          deploymentId: updated.deploymentId,
        });
        expect(fetchedUpdate.deploymentConfig?.description).toContain("v2");
        expect(fetchedUpdate.deploymentConfig?.description).toContain(
          "[alchemy ",
        );

        yield* stack.destroy();

        const gone = yield* waitUntilGone(
          created.scriptId,
          created.deploymentId,
        );
        expect(gone).toEqual("gone");
      }).pipe(Effect.ensuring(deleteScriptProject(fixture.scriptId)));
    }).pipe(logLevel),
  { timeout: 90_000 },
);
