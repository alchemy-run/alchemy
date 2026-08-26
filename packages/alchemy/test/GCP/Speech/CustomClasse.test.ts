import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import * as speech from "@distilled.cloud/gcp/speech_v1";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import {
  hasGcpCreds,
  location,
  logLevel,
  parent,
  project,
  runLifecycle,
} from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

const waitUntilGone = (name: string) =>
  speech.getProjectsLocationsCustomClasses({ name }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.catchTag("Forbidden", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider.skipIf(!hasGcpCreds)(
  "getProjectsLocationsCustomClasses on a missing class fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        speech.getProjectsLocationsCustomClasses({
          name: `${parent}/customClasses/alchemy-missing-class`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || process.env.GCP_TEST_SPEECH === "1")(
  "createProjectsLocationsCustomClasses without Speech API fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        speech.createProjectsLocationsCustomClasses({
          parent,
          body: {
            customClassId: "alchemy-speech-probe",
            customClass: {
              items: [{ value: "sloop" }],
            },
          },
        }),
      );
      expect(error._tag).toEqual("Forbidden");
      expect(error.message).toContain(
        "Cloud Speech-to-Text API has not been used",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!runLifecycle)(
  "create, update, and delete a custom class",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Speech.CustomClasse("Ships", {
            location,
            items: [{ value: "sloop" }, { value: "ketch" }],
          });
        }),
      );

      expect(
        created.name.startsWith(
          `projects/${project}/locations/${location}/customClasses/`,
        ),
      ).toEqual(true);
      expect(created.customClassId.length).toBeGreaterThanOrEqual(4);
      expect(created.project).toEqual(project);
      expect(created.location).toEqual(location);
      expect(created.items.map((item) => item.value).sort()).toEqual([
        "ketch",
        "sloop",
      ]);

      const fetched = yield* speech.getProjectsLocationsCustomClasses({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      const fetchedValues = (fetched.items ?? [])
        .map((item) => item.value ?? "")
        .filter((value) => value.length > 0);
      expect(fetchedValues).toContain("sloop");
      expect(fetchedValues).toContain("ketch");
      expect(fetchedValues.some((value) => value.startsWith("alc "))).toEqual(
        true,
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Speech.CustomClasse("Ships", {
            location,
            customClassId: created.customClassId,
            items: [{ value: "brig" }, { value: "barque" }],
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.items.map((item) => item.value).sort()).toEqual([
        "barque",
        "brig",
      ]);

      const fetchedUpdate = yield* speech.getProjectsLocationsCustomClasses({
        name: created.name,
      });
      const updatedValues = (fetchedUpdate.items ?? []).map(
        (item) => item.value ?? "",
      );
      expect(updatedValues).toContain("brig");
      expect(updatedValues).toContain("barque");
      expect(updatedValues).not.toContain("sloop");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
