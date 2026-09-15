import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as scc from "@distilled.cloud/gcp/securitycenter_v1";
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

const project = process.env.GOOGLE_PROJECT_ID ?? "alchemy-gcp-testing-83661";

const waitUntilGone = (name: string) =>
  scc.getFoldersSecurityHealthAnalyticsSettingsCustomModules({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const folderOf = () =>
  Effect.gen(function* () {
    const fromEnv = process.env.GOOGLE_FOLDER_ID;
    if (fromEnv && fromEnv.length > 0) {
      return fromEnv.startsWith("folders/") ? fromEnv : `folders/${fromEnv}`;
    }
    let current: string | undefined = `projects/${project}`;
    for (let i = 0; i < 8; i++) {
      if (current === undefined) return "";
      current = current.startsWith("projects/")
        ? yield* resourcemanager.getProjects({ name: current }).pipe(
            Effect.map((resource) => resource.parent),
            Effect.catchTag(["NotFound", "Forbidden"], () =>
              Effect.succeed(undefined),
            ),
          )
        : current.startsWith("folders/")
          ? yield* resourcemanager.getFolders({ name: current }).pipe(
              Effect.map((folder) => folder.parent),
              Effect.catchTag(["NotFound", "Forbidden"], () =>
                Effect.succeed(undefined),
              ),
            )
          : undefined;
      if (current?.startsWith("folders/")) return current;
      if (current?.startsWith("organizations/")) return "";
    }
    return "";
  });

const customConfigV1 = {
  predicate: { expression: 'resource.name == "alchemy-nonexistent"' },
  resourceSelector: { resourceTypes: ["compute.googleapis.com/Instance"] },
  severity: "LOW" as const,
  recommendation: "No action required.",
  description: "unused detector",
};

const customConfigV2 = {
  predicate: { expression: 'resource.name == "alchemy-still-missing"' },
  resourceSelector: { resourceTypes: ["compute.googleapis.com/Instance"] },
  severity: "MEDIUM" as const,
  recommendation: "Still no action required.",
  description: "updated unused detector",
};

test.provider.skipIf(!hasGcpCreds)(
  "getFoldersSecurityHealthAnalyticsSettingsCustomModules on a missing module fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const folder = (yield* folderOf()) || "folders/0";
      const error = yield* Effect.flip(
        scc.getFoldersSecurityHealthAnalyticsSettingsCustomModules({
          name: `${folder}/securityHealthAnalyticsSettings/customModules/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a folder Security Health Analytics custom module",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const folder = yield* folderOf();
      const parent = folder
        ? `${folder}/securityHealthAnalyticsSettings`
        : "folders/0/securityHealthAnalyticsSettings";
      if (folder.length === 0) {
        const error = yield* Effect.flip(
          scc.createFoldersSecurityHealthAnalyticsSettingsCustomModules({
            parent,
            body: {
              displayName: "alchemyprobe",
              enablementState: "ENABLED",
              customConfig: customConfigV1,
            },
          }),
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const access = yield* scc
        .listFoldersSecurityHealthAnalyticsSettingsCustomModules({
          parent,
          pageSize: 1,
        })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag(["Forbidden", "NotFound"], (error) =>
            Effect.succeed(error._tag),
          ),
        );
      if (access !== "ok") {
        expect(["Forbidden", "NotFound", "BadRequest"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Securitycenter.FolderSecurityHealthAnalyticsSettingsCustomModule(
            "Unused",
            {
              folder,
              customConfig: customConfigV1,
            },
          );
        }),
      );

      expect(created.moduleId).toEqual(expect.any(String));
      expect(created.folder).toEqual(folder);
      expect(created.name).toContain(
        `${folder}/securityHealthAnalyticsSettings/customModules/`,
      );
      expect(created.customConfig?.description).toEqual("unused detector");

      const fetched =
        yield* scc.getFoldersSecurityHealthAnalyticsSettingsCustomModules({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.customConfig?.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Securitycenter.FolderSecurityHealthAnalyticsSettingsCustomModule(
            "Unused",
            {
              folder,
              displayName: created.displayName,
              customConfig: customConfigV2,
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.customConfig?.description).toEqual(
        "updated unused detector",
      );
      expect(updated.customConfig?.severity).toEqual("MEDIUM");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
