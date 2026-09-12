import { Action } from "@/Action";
import * as GCP from "@/GCP";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { location, logLevel, runLifecycle } from "./common.ts";

const { test } = Test.make({ providers: GCP.providers() });

test.provider.skipIf(!runLifecycle)(
  "GetCustomClasse and GetPhraseSet round-trip",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const ships = yield* GCP.Speech.CustomClasse("BindShips", {
            location,
            items: [{ value: "sloop" }],
          });
          const hints = yield* GCP.Speech.PhraseSet("BindHints", {
            location,
            phrases: [{ value: "weather" }],
          });
          const Probe = Action(
            "Probe",
            Effect.gen(function* () {
              yield* ships.name;
              yield* hints.name;
              const getClass = yield* GCP.Speech.GetCustomClasse(ships);
              const getPhraseSet = yield* GCP.Speech.GetPhraseSet(hints);
              const recognize = yield* GCP.Speech.Recognize(hints);
              return Effect.fn(function* () {
                const customClass = yield* getClass();
                const phraseSet = yield* getPhraseSet();
                const recognized = yield* recognize({
                  body: {
                    config: {
                      languageCode: "en-US",
                      encoding: "LINEAR16",
                      sampleRateHertz: 16000,
                    },
                    audio: { content: "" },
                  },
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
                return { customClass, phraseSet, recognized };
              });
            }),
          );
          return yield* Probe({});
        }),
      );

      expect(out.customClass.name).toEqual(expect.any(String));
      expect(
        (out.customClass.items ?? []).some((item) => item.value === "sloop"),
      ).toEqual(true);
      expect(out.phraseSet.name).toEqual(expect.any(String));
      expect(
        (out.phraseSet.phrases ?? []).some(
          (phrase) => phrase.value === "weather",
        ),
      ).toEqual(true);
      expect([
        "ok",
        "Forbidden",
        "BadRequest",
        "NotFound",
        "Conflict",
      ]).toContain(out.recognized.tag);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 90_000 },
);
