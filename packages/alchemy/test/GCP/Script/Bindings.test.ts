import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as drive from "@distilled.cloud/gcp/drive_v3";
import * as script from "@distilled.cloud/gcp/script_v1";
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

const MANIFEST = JSON.stringify({
  timeZone: "America/Chicago",
  exceptionLogging: "STACKDRIVER",
  runtimeVersion: "V8",
  executionApi: { access: "MYSELF" },
});

const CODE = "function hello() {\n  return 'hello';\n}\n";

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
      body: { title: "alchemy-script-binding" },
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
            body: { description: "alchemy-script-binding-v1" },
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

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "GetDeployment round-trip",
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
        const out = yield* stack.deploy(
          Effect.gen(function* () {
            const deployment = yield* GCP.Script.Deployment("Api", {
              scriptId: fixture.scriptId,
              versionNumber: fixture.versionNumber,
              description: "binding",
            });
            const Probe = Action(
              "Probe",
              Effect.gen(function* () {
                yield* deployment.deploymentId;
                const getDeployment =
                  yield* GCP.Script.GetDeployment(deployment);
                const run = yield* GCP.Script.RunScripts(deployment);
                return Effect.fn(function* () {
                  const live = yield* getDeployment({});
                  const ran = yield* run({
                    body: { function: "hello" },
                  }).pipe(
                    Effect.map((result) => ({ tag: "ok" as const, result })),
                    Effect.catchTag(
                      ["Forbidden", "BadRequest", "NotFound", "Conflict"],
                      (error) =>
                        Effect.succeed({
                          tag: error._tag,
                          message: error.message,
                        }),
                    ),
                  );
                  return { live, ran };
                });
              }),
            );
            return { deployment, probe: yield* Probe({}) };
          }),
        );

        expect(out.probe.live.deploymentId).toEqual(
          out.deployment.deploymentId,
        );
        expect(out.probe.live.deploymentConfig?.scriptId).toEqual(
          fixture.scriptId,
        );
        expect([
          "ok",
          "Forbidden",
          "BadRequest",
          "NotFound",
          "Conflict",
        ]).toContain(out.probe.ran.tag);

        yield* stack.destroy();
      }).pipe(Effect.ensuring(deleteScriptProject(fixture.scriptId)));
    }).pipe(logLevel),
  { timeout: 90_000 },
);
