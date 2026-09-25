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
  scc.getFoldersEventThreatDetectionSettingsCustomModules({ name }).pipe(
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

const configV1 = {
  metadata: { severity: "LOW" },
  ips: ["192.0.2.1"],
};

const configV2 = {
  metadata: { severity: "MEDIUM" },
  ips: ["192.0.2.2"],
};

test.provider.skipIf(!hasGcpCreds)(
  "getFoldersEventThreatDetectionSettingsCustomModules on a missing module fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const folder = (yield* folderOf()) || "folders/0";
      const error = yield* Effect.flip(
        scc.getFoldersEventThreatDetectionSettingsCustomModules({
          name: `${folder}/eventThreatDetectionSettings/customModules/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a folder Event Threat Detection custom module",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const folder = yield* folderOf();
      const parent = folder
        ? `${folder}/eventThreatDetectionSettings`
        : "folders/0/eventThreatDetectionSettings";
      if (folder.length === 0) {
        const error = yield* Effect.flip(
          scc.createFoldersEventThreatDetectionSettingsCustomModules({
            parent,
            body: {
              type: "CONFIGURABLE_BAD_IP",
              config: configV1,
              enablementState: "ENABLED",
            },
          }),
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const access = yield* scc
        .listFoldersEventThreatDetectionSettingsCustomModules({
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
          return yield* GCP.Securitycenter.FolderEventThreatDetectionSettingsCustomModule(
            "BadIp",
            {
              folder,
              type: "CONFIGURABLE_BAD_IP",
              config: configV1,
              description: "test bad ip",
            },
          );
        }),
      );

      expect(created.moduleId).toEqual(expect.any(String));
      expect(created.folder).toEqual(folder);
      expect(created.name).toContain(
        `${folder}/eventThreatDetectionSettings/customModules/`,
      );
      expect(created.description).toEqual("test bad ip");

      const fetched =
        yield* scc.getFoldersEventThreatDetectionSettingsCustomModules({
          name: created.name,
        });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Securitycenter.FolderEventThreatDetectionSettingsCustomModule(
            "BadIp",
            {
              folder,
              type: "CONFIGURABLE_BAD_IP",
              config: configV2,
              description: "updated bad ip",
            },
          );
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.description).toEqual("updated bad ip");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
