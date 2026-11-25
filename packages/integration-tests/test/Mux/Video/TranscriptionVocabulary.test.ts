import * as Mux from "@alchemy.run/mux";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Video from "@distilled.cloud/mux/video";
import * as Drift from "alchemy/Drift";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Mux.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const live = (id: string) =>
  Video.getTranscriptionVocabulary({ TRANSCRIPTION_VOCABULARY_ID: id }).pipe(
    Effect.map((res) => res.data),
  );

const waitUntilGone = (id: string) =>
  live(id).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "create, update in place, and clear removed fields of a transcription vocabulary",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const tag = `alchemy-test-vocab-${stack.stage}`;

      const created = yield* stack.deploy(
        Mux.Video.TranscriptionVocabulary("Vocab", {
          name: `${tag} v1`,
          passthrough: tag,
          phrases: ["Alchemy"],
        }),
      );
      const first = yield* live(created.id);
      expect(first.name).toEqual(`${tag} v1`);
      expect(first.passthrough).toEqual(tag);
      expect(first.phrases).toEqual(["Alchemy"]);

      const updated = yield* stack.deploy(
        Mux.Video.TranscriptionVocabulary("Vocab", {
          name: `${tag} v2`,
          passthrough: `${tag}-v2`,
          phrases: ["Alchemy", "Mux", tag],
        }),
      );
      expect(updated.id).toEqual(created.id);
      const second = yield* live(created.id);
      expect(second.name).toEqual(`${tag} v2`);
      expect(second.passthrough).toEqual(`${tag}-v2`);
      expect(second.phrases).toEqual(["Alchemy", "Mux", tag]);

      const cleared = yield* stack.deploy(
        Mux.Video.TranscriptionVocabulary("Vocab", { phrases: ["Alchemy"] }),
      );
      expect(cleared.id).toEqual(created.id);
      expect(cleared.name).toBeUndefined();
      expect(cleared.passthrough).toBeUndefined();
      const third = yield* live(created.id);
      expect(third.name || undefined).toBeUndefined();
      expect(third.passthrough || undefined).toBeUndefined();
      expect(third.phrases).toEqual(["Alchemy"]);

      yield* stack.destroy();
      expect(yield* waitUntilGone(created.id)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:video", "live"], timeout: 120_000 },
);

test.provider(
  "drift repair restores edited phrases and recreates a deleted vocabulary",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const tag = `alchemy-test-vocab-drift-${stack.stage}`;
      const vocab = Mux.Video.TranscriptionVocabulary("Vocab", {
        name: tag,
        phrases: ["Alchemy", "Mux"],
      });

      const created = yield* stack.deploy(vocab);
      yield* Video.updateTranscriptionVocabulary({
        TRANSCRIPTION_VOCABULARY_ID: created.id,
        name: "changed outside alchemy",
        phrases: ["Elsewhere"],
      });

      const drift = yield* Drift.detect(stack).pipe(Effect.provide(stack.state));
      expect(drift.resources.Vocab?.action).toBe("drifted");
      yield* Drift.repair(stack).pipe(Effect.provide(stack.state));
      const repaired = yield* live(created.id);
      expect(repaired.name).toEqual(tag);
      expect(repaired.phrases).toEqual(["Alchemy", "Mux"]);

      yield* Video.deleteTranscriptionVocabulary({ TRANSCRIPTION_VOCABULARY_ID: created.id });
      const missing = yield* Drift.detect(stack).pipe(Effect.provide(stack.state));
      expect(missing.resources.Vocab?.action).toBe("missing");
      yield* Drift.repair(stack).pipe(Effect.provide(stack.state));

      const recreated = yield* stack.deploy(vocab);
      expect(recreated.id).not.toEqual(created.id);
      expect((yield* live(recreated.id)).phrases).toEqual(["Alchemy", "Mux"]);

      yield* stack.destroy();
      expect(yield* waitUntilGone(recreated.id)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:video", "live"], timeout: 120_000 },
);
