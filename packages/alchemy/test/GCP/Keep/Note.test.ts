import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as keep from "@distilled.cloud/gcp/keep_v1";
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
  keep.getNotes({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

const probeAccess = () =>
  keep.listNotes({ pageSize: 1, filter: "trashed=false" }).pipe(
    Effect.as("ok" as const),
    Effect.catchTag(["Forbidden", "NotFound"], (error) =>
      Effect.succeed(error._tag),
    ),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getNotes on a missing note fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        keep.getNotes({
          name: "notes/alchemyMissingNoteId000000000000",
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds)(
  "createNotes without Keep access fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const result = yield* keep
        .createNotes({
          body: {
            title: "Alchemy Keep Probe",
            body: { text: { text: "probe" } },
          },
        })
        .pipe(
          Effect.map((note) => ({
            _tag: "ok" as const,
            name: note.name,
          })),
          Effect.catchTag(["Forbidden", "NotFound", "BadRequest"], (error) =>
            Effect.succeed({ _tag: error._tag, name: undefined }),
          ),
        );

      if (result._tag === "ok") {
        if (result.name) {
          yield* keep
            .deleteNotes({ name: result.name })
            .pipe(
              Effect.catchTag(
                ["NotFound", "Forbidden", "BadRequest"],
                () => Effect.void,
              ),
            );
        }
      } else {
        expect(["Forbidden", "NotFound", "BadRequest"]).toContain(result._tag);
      }

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || !!process.env.FAST)(
  "create, replace, and delete a note",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const access = yield* probeAccess();
      if (access !== "ok") {
        expect(["Forbidden", "NotFound"]).toContain(access);
        yield* stack.destroy();
        return;
      }

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Keep.Note("Scratch", {
            title: "Standup",
            text: "Ship the Keep provider",
          });
        }),
      );

      expect(created.name.startsWith("notes/")).toEqual(true);
      expect(created.noteId.length).toBeGreaterThan(0);
      expect(created.title).toEqual("Standup");
      expect(created.text).toEqual("Ship the Keep provider");

      const fetched = yield* keep.getNotes({ name: created.name });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.title).toContain("[alchemy ");
      expect(fetched.body?.text?.text).toEqual("Ship the Keep provider");

      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Keep.Note("Scratch", {
            title: "Retro",
            text: "Ship the Keep provider",
          });
        }),
      );

      expect(replaced.title).toEqual("Retro");
      expect(replaced.text).toEqual("Ship the Keep provider");
      expect(replaced.name).not.toEqual(created.name);

      const fetchedReplace = yield* keep.getNotes({ name: replaced.name });
      expect(fetchedReplace.title).toContain("[alchemy ");
      expect(fetchedReplace.title).toContain("Retro");

      const gonePrevious = yield* waitUntilGone(created.name);
      expect(gonePrevious).toEqual("gone");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(replaced.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
