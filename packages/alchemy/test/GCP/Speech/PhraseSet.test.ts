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
  speech.getProjectsLocationsPhraseSets({ name }).pipe(
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
  "getProjectsLocationsPhraseSets on a missing phrase set fails with a typed tag",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        speech.getProjectsLocationsPhraseSets({
          name: `${parent}/phraseSets/alchemy-missing-phrases`,
        }),
      );
      expect(["NotFound", "Forbidden"]).toContain(error._tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);

test.provider.skipIf(!hasGcpCreds || process.env.GCP_TEST_SPEECH === "1")(
  "createProjectsLocationsPhraseSets without Speech API fails with Forbidden",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* Effect.flip(
        speech.createProjectsLocationsPhraseSets({
          parent,
          body: {
            phraseSetId: "alchemy-speech-probe",
            phraseSet: {
              phrases: [{ value: "weather" }],
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
  "create, update, and delete a phrase set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Speech.PhraseSet("Hints", {
            location,
            phrases: [{ value: "weather", boost: 10 }],
            boost: 5,
          });
        }),
      );

      expect(
        created.name.startsWith(
          `projects/${project}/locations/${location}/phraseSets/`,
        ),
      ).toEqual(true);
      expect(created.phraseSetId.length).toBeGreaterThanOrEqual(4);
      expect(created.project).toEqual(project);
      expect(created.location).toEqual(location);
      expect(created.boost).toEqual(5);
      expect(
        created.phrases.some(
          (phrase) => phrase.value === "weather" && phrase.boost === 10,
        ),
      ).toEqual(true);

      const fetched = yield* speech.getProjectsLocationsPhraseSets({
        name: created.name,
      });
      expect(fetched.name).toEqual(created.name);
      expect(fetched.boost).toEqual(5);
      const fetchedValues = (fetched.phrases ?? []).map(
        (phrase) => phrase.value ?? "",
      );
      expect(fetchedValues).toContain("weather");
      expect(fetchedValues.some((value) => value.startsWith("alc "))).toEqual(
        true,
      );

      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* GCP.Speech.PhraseSet("Hints", {
            location,
            phraseSetId: created.phraseSetId,
            phrases: [{ value: "weather", boost: 15 }, { value: "forecast" }],
            boost: 8,
          });
        }),
      );

      expect(updated.name).toEqual(created.name);
      expect(updated.boost).toEqual(8);
      expect(updated.phrases.map((phrase) => phrase.value).sort()).toEqual([
        "forecast",
        "weather",
      ]);

      const fetchedUpdate = yield* speech.getProjectsLocationsPhraseSets({
        name: created.name,
      });
      expect(fetchedUpdate.boost).toEqual(8);
      const updatedValues = (fetchedUpdate.phrases ?? []).map(
        (phrase) => phrase.value ?? "",
      );
      expect(updatedValues).toContain("weather");
      expect(updatedValues).toContain("forecast");

      yield* stack.destroy();

      const gone = yield* waitUntilGone(created.name);
      expect(gone).toEqual("gone");
    }).pipe(logLevel),
  { timeout: 90_000 },
);
