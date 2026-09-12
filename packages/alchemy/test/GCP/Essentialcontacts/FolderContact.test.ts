import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as essentialcontacts from "@distilled.cloud/gcp/essentialcontacts_v1";
import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
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

const waitUntilGone = (name: string) =>
  essentialcontacts.getFoldersContacts({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
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
    const parent = yield* resourcemanager
      .getProjects({ name: `projects/${project}` })
      .pipe(
        Effect.map((resource) => resource.parent ?? ""),
        Effect.catchTag(["NotFound", "Forbidden"], () => Effect.succeed("")),
      );
    return parent.startsWith("folders/") ? parent : "";
  });

test.provider.skipIf(!hasGcpCreds)(
  "getFoldersContacts on a missing contact fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const folder = (yield* folderOf()) || "folders/0";
      const error = yield* Effect.flip(
        essentialcontacts.getFoldersContacts({
          name: `${folder}/contacts/0`,
        }),
      );
      expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "create, update, replace, and delete a folder essential contact",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const folder = yield* folderOf();
      if (folder.length === 0) {
        const error = yield* Effect.flip(
          essentialcontacts.createFoldersContacts({
            parent: "folders/0",
            body: {
              email: "ops@example.com",
              languageTag: "en-US",
              notificationCategorySubscriptions: ["ALL"],
            },
          }),
        );
        expect(["NotFound", "Forbidden", "BadRequest"]).toContain(error._tag);
        yield* stack.destroy();
        return;
      }

      const access = yield* essentialcontacts
        .listFoldersContacts({ parent: folder, pageSize: 1 })
        .pipe(
          Effect.as("ok" as const),
          Effect.catchTag(["Forbidden", "NotFound"], (error) =>
            Effect.succeed(error._tag),
          ),
        );
      if (access !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Essentialcontacts.FolderContact("Ops", {
            folderId: folder,
            email: "folder-ops@example.com",
            languageTag: "en-US",
            notificationCategorySubscriptions: ["ALL"],
          });
        }),
      );

      expect(created.contactId.length).toBeGreaterThan(0);
      expect(created.parent).toEqual(folder);
      expect(created.email).toEqual("folder-ops@example.com");
      expect(created.languageTag).toEqual("en-US");

      const fetched = yield* essentialcontacts.getFoldersContacts({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.email).toContain("+alc.");

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Essentialcontacts.FolderContact("Ops", {
            folderId: folder,
            email: "folder-ops@example.com",
            languageTag: "en-GB",
            notificationCategorySubscriptions: ["TECHNICAL"],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.languageTag).toEqual("en-GB");
      expect(updated.notificationCategorySubscriptions).toEqual(["TECHNICAL"]);

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Essentialcontacts.FolderContact("Ops", {
            folderId: folder,
            email: "folder-sec@example.com",
            languageTag: "en-GB",
            notificationCategorySubscriptions: ["SECURITY"],
          });
        }),
      );

      expect(replaced.email).toEqual("folder-sec@example.com");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
