import * as Mux from "@alchemy.run/mux";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Video from "@distilled.cloud/mux/video";
import * as Drift from "alchemy/Drift";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Mux.providers() });

/** Distilled decodes Mux secrets as `Redacted`; its types also allow a plain string. */
const reveal = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const SLATE = "https://muxed.s3.amazonaws.com/example-watermark.png";
const TARGET_A = "rtmp://example.com/live-a";
const TARGET_B = "rtmp://example.com/live-b";

const PHASES = [
  "create",
  "update",
  "reenable",
  "retitle",
  "slate",
  "halfway",
  "revert",
  "drift",
  "unset",
  "caption",
  "plaincaption",
  "lowlatency",
  "retarget",
  "replace",
] as const;
type Phase = (typeof PHASES)[number];

/**
 * The stack at each phase. Each phase changes a few props from the one
 * before, so the deploys walk through in-place updates, a failed update and
 * its revert, removed settings, caption changes and replacements.
 */
const program = (phase: Phase, run: string) => {
  const at = (name: Phase) => PHASES.indexOf(phase) >= PHASES.indexOf(name);
  const between = (from: Phase, to: Phase) => at(from) && !at(to);
  return Effect.gen(function* () {
    const vocab = yield* Mux.Video.TranscriptionVocabulary("Vocab", {
      name: at("update") ? `${run} v2` : run,
      phrases: at("update") ? ["Alchemy", "Mux", run] : ["Alchemy"],
    });
    const stream = yield* Mux.Video.LiveStream("Stream", {
      playback_policies: at("replace") ? ["signed"] : ["public"],
      // Mux rejects simulcast targets on test streams. It never receives video.
      test: false,
      passthrough: at("retitle") ? `${run}-v3` : run,
      latency_mode:
        phase === "halfway" || at("lowlatency") ? "low" : at("update") ? "reduced" : "low",
      meta: {
        title: at("retitle") ? `${run} v3` : at("update") ? `${run} v2` : run,
      },
      new_asset_settings: {
        playback_policies: ["public"],
        video_quality: at("update") ? "premium" : "plus",
        ...(between("slate", "unset") && { meta: { title: `recording ${run}` } }),
      },
      ...(between("slate", "unset") && {
        use_slate_for_standard_latency: true,
        reconnect_slate_url: SLATE,
        max_continuous_duration: 3600,
      }),
      ...(between("update", "unset") && { reconnect_window: 30 }),
      ...(between("update", "lowlatency") && {
        embedded_subtitles: [{ language_code: "en", language_channel: "cc1" }],
      }),
      ...(phase === "update" && { enabled: false }),
      ...(["update", "halfway", "caption"].includes(phase) && {
        generated_subtitles: [
          { language_code: "en", transcription_vocabulary_ids: [vocab.id], passthrough: run },
        ],
      }),
      ...(phase === "plaincaption" && { generated_subtitles: [{ language_code: "en" }] }),
    });
    const target = yield* Mux.Video.SimulcastTarget("Target", {
      live_stream_id: stream.id,
      url: at("retarget") ? TARGET_B : TARGET_A,
      stream_key: Redacted.make(`key-${run}`),
    });
    return { vocab, stream, target };
  });
};

const getStream = (id: string) =>
  Video.getLiveStream({ LIVE_STREAM_ID: id }).pipe(Effect.map((res) => res.data));

const targetExists = (target: { id: string; live_stream_id: string }) =>
  Video.getLiveStreamSimulcastTarget({
    LIVE_STREAM_ID: target.live_stream_id,
    SIMULCAST_TARGET_ID: target.id,
  }).pipe(
    Effect.as(true),
    Effect.catchTag("NotFound", () => Effect.succeed(false)),
  );

const waitUntilGone = (id: string) =>
  Video.getLiveStream({ LIVE_STREAM_ID: id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("1 second"),
      until: (status) => status === "gone",
      times: 10,
    }),
  );

test.provider(
  "live stream converges through updates, a failed update, drift, unset settings and replacement",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const run = `alchemy-${stack.stage}-livestream`;

      const deploy = (phase: Phase) => stack.deploy(program(phase, run));
      const expectPlan = (
        phase: Phase,
        actions: { vocab: string; stream: string; target: string },
      ) =>
        Effect.gen(function* () {
          const plan = yield* stack.plan(program(phase, run));
          expect({
            vocab: plan.resources.Vocab?.action,
            stream: plan.resources.Stream?.action,
            target: plan.resources.Target?.action,
          }).toEqual(actions);
        });

      // create
      const created = yield* deploy("create");
      {
        const live = yield* getStream(created.stream.id);
        expect(live.latency_mode).toBe("low");
        expect(live.test).not.toBe(true);
        expect(live.passthrough).toBe(run);
        expect(live.status).toBe("idle");
        expect(live.new_asset_settings?.video_quality).toBe("plus");
        expect(live.playback_ids?.[0]?.policy).toBe("public");
        expect(created.stream.public_playback_id).toBe(live.playback_ids?.[0]?.id);
        expect(Redacted.value(created.stream.stream_key)).toBe(reveal(live.stream_key));
        expect(Redacted.value(created.stream.srt_passphrase)).toBe(
          reveal(live.srt_passphrase ?? ""),
        );
        expect(Redacted.value(created.target.url)).toBe(TARGET_A);
        expect(yield* targetExists(created.target)).toBe(true);
        expect("stream_key" in created.target).toBe(false);
      }

      // update: in place, disabled, captions on, stream key kept
      yield* expectPlan("update", { vocab: "update", stream: "update", target: "noop" });
      const updated = yield* deploy("update");
      {
        expect(updated.stream.id).toBe(created.stream.id);
        expect(updated.vocab.id).toBe(created.vocab.id);
        expect(Redacted.value(updated.stream.stream_key)).toBe(
          Redacted.value(created.stream.stream_key),
        );
        expect(updated.stream.playback_ids).toEqual(created.stream.playback_ids);
        const live = yield* getStream(updated.stream.id);
        expect(live.latency_mode).toBe("reduced");
        expect(live.reconnect_window).toBe(30);
        expect(live.meta?.title).toBe(`${run} v2`);
        expect(live.status).toBe("disabled");
        expect(live.new_asset_settings?.video_quality).toBe("premium");
        expect(live.generated_subtitles?.[0]?.language_code).toBe("en");
        expect(live.generated_subtitles?.[0]?.transcription_vocabulary_ids).toEqual([
          updated.vocab.id,
        ]);
        expect(live.embedded_subtitles?.[0]?.language_channel).toBe("cc1");
      }

      // reenable: enabled again, generated captions removed
      yield* expectPlan("reenable", { vocab: "noop", stream: "update", target: "noop" });
      yield* deploy("reenable");
      {
        const live = yield* getStream(created.stream.id);
        expect(live.status).toBe("idle");
        expect(live.generated_subtitles ?? []).toEqual([]);
        expect(live.embedded_subtitles?.[0]?.language_channel).toBe("cc1");
      }

      // retitle
      yield* expectPlan("retitle", { vocab: "noop", stream: "update", target: "noop" });
      const retitled = yield* deploy("retitle");
      {
        expect(retitled.stream.id).toBe(created.stream.id);
        const live = yield* getStream(created.stream.id);
        expect(live.meta?.title).toBe(`${run} v3`);
        expect(live.passthrough).toBe(`${run}-v3`);
      }

      // slate: slate, max duration and recording title in place
      yield* expectPlan("slate", { vocab: "noop", stream: "update", target: "noop" });
      const slated = yield* deploy("slate");
      {
        expect(slated.stream.id).toBe(created.stream.id);
        expect(Redacted.value(slated.stream.stream_key)).toBe(
          Redacted.value(created.stream.stream_key),
        );
        const live = yield* getStream(created.stream.id);
        expect(live.use_slate_for_standard_latency).toBe(true);
        expect(live.reconnect_slate_url).toBe(SLATE);
        expect(live.max_continuous_duration).toBe(3600);
        expect(live.new_asset_settings?.meta?.title).toBe(`recording ${run}`);
      }

      // halfway: low latency is applied, then Mux rejects the captions
      const failure = yield* deploy("halfway").pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "BadRequest" });
      expect(String(failure)).toContain("Low Latency cannot be used with generated subtitles");
      expect((yield* getStream(created.stream.id)).latency_mode).toBe("low");

      // revert: the next deploy undoes the half-applied change. The stream
      // resumes its interrupted update, which hides its id from the
      // target, so the target is recreated with the same settings.
      yield* expectPlan("revert", { vocab: "noop", stream: "update", target: "replace" });
      const reverted = yield* deploy("revert");
      {
        expect(reverted.stream.id).toBe(created.stream.id);
        expect(reverted.target.live_stream_id).toBe(created.stream.id);
        expect(reverted.target.id).not.toBe(created.target.id);
        expect(Redacted.value(reverted.target.url)).toBe(TARGET_A);
        expect(yield* targetExists(reverted.target)).toBe(true);
        expect(yield* targetExists(created.target)).toBe(false);
        const live = yield* getStream(created.stream.id);
        expect(live.latency_mode).toBe("reduced");
        expect(live.generated_subtitles ?? []).toEqual([]);
      }

      // drift: settings changed outside Alchemy are put back
      yield* Video.updateLiveStream({
        LIVE_STREAM_ID: created.stream.id,
        meta: { title: "changed outside alchemy" },
        reconnect_window: 90,
        new_asset_settings: { meta: { title: "changed outside alchemy" } },
      });
      yield* Video.disableLiveStream({ LIVE_STREAM_ID: created.stream.id });
      const drift = yield* Drift.detect(stack).pipe(Effect.provide(stack.state));
      expect(drift.resources.Stream?.action).toBe("drifted");
      expect(drift.resources.Target?.action).toBe("unchanged");
      yield* Drift.repair(stack).pipe(Effect.provide(stack.state));
      {
        const live = yield* getStream(created.stream.id);
        expect(live.meta?.title).toBe(`${run} v3`);
        expect(live.reconnect_window).toBe(30);
        expect(live.status).toBe("idle");
        expect(live.new_asset_settings?.meta?.title).toBe(`recording ${run}`);
      }
      yield* expectPlan("drift", { vocab: "noop", stream: "noop", target: "noop" });

      // unset: removed settings return to Mux's defaults
      yield* expectPlan("unset", { vocab: "noop", stream: "update", target: "noop" });
      const unset = yield* deploy("unset");
      {
        expect(unset.stream.id).toBe(created.stream.id);
        const live = yield* getStream(created.stream.id);
        expect(live.use_slate_for_standard_latency ?? false).toBe(false);
        expect(live.reconnect_slate_url ?? "").toBe("");
        expect(live.max_continuous_duration).toBe(43200);
        // Absent means 0, Mux's default for a reduced latency stream.
        expect(live.reconnect_window).toBeUndefined();
        expect(live.new_asset_settings?.meta?.title ?? "").toBe("");
      }

      // caption: generated captions with the vocabulary
      yield* expectPlan("caption", { vocab: "noop", stream: "update", target: "noop" });
      yield* deploy("caption");
      {
        const [en] = (yield* getStream(created.stream.id)).generated_subtitles ?? [];
        expect(en?.transcription_vocabulary_ids).toEqual([updated.vocab.id]);
        expect(en?.passthrough).toBe(run);
      }

      // plaincaption: the same caption without vocabulary or passthrough
      yield* expectPlan("plaincaption", { vocab: "noop", stream: "update", target: "noop" });
      yield* deploy("plaincaption");
      {
        const [en] = (yield* getStream(created.stream.id)).generated_subtitles ?? [];
        expect(en?.language_code).toBe("en");
        expect(en?.transcription_vocabulary_ids ?? []).toEqual([]);
        expect(en?.passthrough ?? "").toBe("");
      }

      // lowlatency: captions are removed before the latency changes
      yield* expectPlan("lowlatency", { vocab: "noop", stream: "update", target: "noop" });
      yield* deploy("lowlatency");
      {
        const live = yield* getStream(created.stream.id);
        expect(live.latency_mode).toBe("low");
        expect(live.generated_subtitles ?? []).toEqual([]);
        expect(live.embedded_subtitles ?? []).toEqual([]);
        expect(live.reconnect_window).toBeUndefined();
      }

      // retarget: a new target URL replaces the target
      yield* expectPlan("retarget", { vocab: "noop", stream: "noop", target: "replace" });
      const retargeted = yield* deploy("retarget");
      {
        expect(retargeted.target.id).not.toBe(reverted.target.id);
        expect(Redacted.value(retargeted.target.url)).toBe(TARGET_B);
        expect(yield* targetExists(retargeted.target)).toBe(true);
        expect(yield* targetExists(reverted.target)).toBe(false);
      }

      // replace: a new playback policy replaces the stream and its target
      yield* expectPlan("replace", { vocab: "noop", stream: "replace", target: "replace" });
      const replaced = yield* deploy("replace");
      {
        expect(replaced.stream.id).not.toBe(created.stream.id);
        const live = yield* getStream(replaced.stream.id);
        expect(live.playback_ids?.[0]?.policy).toBe("signed");
        expect(replaced.stream.signed_playback_id).toBe(live.playback_ids?.[0]?.id);
        expect(replaced.target.live_stream_id).toBe(replaced.stream.id);
        expect(yield* targetExists(replaced.target)).toBe(true);
        expect(yield* waitUntilGone(created.stream.id)).toBe("gone");
      }

      yield* stack.destroy();
      expect(yield* waitUntilGone(replaced.stream.id)).toBe("gone");
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:video", "live"], timeout: 600_000 },
);

test.provider(
  "a low latency stream with captions fails to create",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const failure = yield* stack
        .deploy(
          Mux.Video.LiveStream("Rejected", {
            playback_policies: ["public"],
            test: true,
            latency_mode: "low",
            embedded_subtitles: [{ language_code: "en", language_channel: "cc1" }],
          }),
        )
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ _tag: "BadRequest" });
      expect(String(failure)).toContain("Low Latency cannot be used with embedded subtitles");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:video", "live"], timeout: 60_000 },
);
