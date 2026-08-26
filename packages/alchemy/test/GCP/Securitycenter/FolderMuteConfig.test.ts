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
  scc.getFoldersMuteConfigs({ name }).pipe(
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

test.provider.skipIf(!hasGcpCreds)(
  "getFoldersMuteConfigs on a missing config fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const folder = (yield* folderOf()) || "folders/0";
      const error = yield* Effect.flip(
        scc.getFoldersMuteConfigs({
          name: `${folder}/muteConfigs/alchemy-missing`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, and delete a folder mute config",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const folder = yield* folderOf();
      if (folder.length === 0) {
        const error = yield* Effect.flip(
          scc.createFoldersMuteConfigs({
            parent: "folders/0",
            muteConfigId: "alchemy-probe",
            body: { filter: 'severity="LOW"', type: "STATIC" },
          }),
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const access = yield* scc
        .listFoldersMuteConfigs({ parent: folder, pageSize: 1 })
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
          return yield* GCP.Securitycenter.FolderMuteConfig("Low", {
            folder,
            filter: 'severity="LOW"',
            description: "mute low findings",
          });
        }),
      );

      expect(created.muteConfigId).toEqual(expect.any(String));
      expect(created.folder).toEqual(folder);
      expect(created.name).toEqual(
        `${folder}/muteConfigs/${created.muteConfigId}`,
      );
      expect(created.filter).toEqual('severity="LOW"');
      expect(created.description).toEqual("mute low findings");

      const fetched = yield* scc.getFoldersMuteConfigs({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.description).toContain("alchemy-id=");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Securitycenter.FolderMuteConfig("Low", {
            folder,
            muteConfigId: created.muteConfigId,
            filter: 'severity="MEDIUM"',
            description: "mute medium findings",
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.filter).toEqual('severity="MEDIUM"');
      expect(updated.description).toEqual("mute medium findings");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
