import * as Mux from "@alchemy.run/mux";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Robots from "@distilled.cloud/mux/robots";
import * as Video from "@distilled.cloud/mux/video";
import * as Drift from "alchemy/Drift";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Mux.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const DEMO_URL = "https://storage.googleapis.com/muxdemofiles/mux.mp4";
const FR_VTT = "https://tears-of-steel-subtitles.s3.amazonaws.com/tears-fr.vtt";
const EN_VTT = "https://tears-of-steel-subtitles.s3.amazonaws.com/tears-en.vtt";
const WATERMARK = "https://muxed.s3.amazonaws.com/example-watermark.png";

type Props = Mux.Video.AssetProps;

const deploy = (stack: Test.ScratchStack, props: Props) =>
  stack.deploy(Mux.Video.Asset("Asset", props));

const live = (id: string) => Video.getAsset({ ASSET_ID: id }).pipe(Effect.map((res) => res.data));

const waitUntilGone = (id: string) =>
  Video.getAsset({ ASSET_ID: id }).pipe(
    Effect.as("found" as const),
    Effect.catchTag("NotFound", () => Effect.succeed("gone" as const)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (status) => status === "gone",
      times: 15,
    }),
  );

type AssetLike = { playback_ids?: ReadonlyArray<{ id: string; policy: string }> };
type TracksLike = { tracks?: ReadonlyArray<Video.Track> };

const policies = (a: AssetLike) => (a.playback_ids ?? []).map((p) => p.policy).sort();
const idFor = (a: AssetLike, policy: string) =>
  a.playback_ids?.find((p) => p.policy === policy)?.id;
const tracksOf = (a: TracksLike, source: string, language: string) =>
  (a.tracks ?? []).filter(
    (t) => (t.text_source ?? t.type) === source && t.language_code === language,
  );
const renditions = (a: Video.Asset, resolution: string) =>
  (a.static_renditions?.files ?? []).filter((f) => f.id && f.resolution === resolution);

/** A track restored by a rollback is still preparing when the deploy fails. */
const settledTracks = (id: string, source: string, language: string) =>
  live(id).pipe(
    Effect.map((asset) => tracksOf(asset, source, language)),
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (tracks) => tracks.every((t) => t.status !== "preparing"),
      times: 60,
    }),
  );

const french = (url: string): Video.InputSettings => ({
  url,
  type: "text",
  text_type: "subtitles",
  language_code: "fr",
  name: "Français",
});
const spanish: Video.InputSettings = {
  url: DEMO_URL,
  type: "audio",
  language_code: "es",
  name: "Español",
};

const MODERATE: Mux.Robots.DirectiveProps["bindings"] = [
  { reference_id: "moderation", workflow: "moderate" },
];

/** Deploys a directive and an asset that lists it. */
const withDirective = (stack: Test.ScratchStack, name: string, props: Props) =>
  stack.deploy(
    Effect.gen(function* () {
      const directive = yield* Mux.Robots.Directive("Directive", { name, bindings: MODERATE });
      const asset = yield* Mux.Video.Asset("Asset", {
        ...props,
        directives: [{ id: directive.id }],
      });
      return { directive, asset };
    }),
  );

/** Directive runs start asynchronously. */
const runFor = (directiveId: string, assetId: string) =>
  Robots.listDirectiveRuns.items({ DIRECTIVE_ID: directiveId, limit: 100 }).pipe(
    Stream.filter((run) => run.subject_id === assetId),
    Stream.runHead,
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (run) => run._tag === "Some",
      times: 30,
    }),
  );

test.provider(
  "settings update in place, a failed update reverts, drift is repaired, and new directives run",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const run = `${stack.stage}-asset-settings`;
      const moderation = `${run} moderation`;

      const base: Props = {
        inputs: [{ url: DEMO_URL }],
        test: true,
        video_quality: "basic",
        passthrough: run,
        meta: { title: `verify ${run}` },
        playback_policies: ["public"],
      };
      const { directive, asset: created } = yield* withDirective(stack, moderation, base);
      const fresh = yield* live(created.id);
      expect(fresh.status).toEqual("ready");
      expect(fresh.test).toEqual(true);
      expect(fresh.passthrough).toEqual(run);
      expect(fresh.meta?.title).toEqual(`verify ${run}`);
      expect(policies(fresh)).toEqual(["public"]);
      expect(created.public_playback_id).toEqual(idFor(fresh, "public"));
      expect(fresh.directives?.map((d) => d.id)).toContain(directive.id);
      expect((yield* runFor(directive.id, created.id))._tag).toEqual("Some");

      const { asset: updated } = yield* withDirective(stack, moderation, {
        ...base,
        passthrough: `${run}-v2`,
        meta: { title: `verify ${run} v2` },
        playback_policies: ["public", "signed"],
        thumbnail_time: 2,
        master_access: "temporary",
        static_renditions: [{ resolution: "highest" }],
      });
      expect(updated.id).toEqual(created.id);
      const v2 = yield* live(created.id);
      expect(v2.meta?.title).toEqual(`verify ${run} v2`);
      expect(v2.passthrough).toEqual(`${run}-v2`);
      expect(v2.thumbnail_time).toEqual(2);
      expect(v2.master_access).toEqual("temporary");
      expect(renditions(v2, "highest")).toHaveLength(1);
      expect(policies(v2)).toEqual(["public", "signed"]);
      expect(idFor(v2, "public")).toEqual(idFor(fresh, "public"));

      const trimmedProps: Props = {
        ...base,
        passthrough: `${run}-v2`,
        meta: { title: `verify ${run} v2` },
        playback_policies: ["signed"],
      };
      const { asset: trimmed } = yield* withDirective(stack, moderation, trimmedProps);
      expect(trimmed.id).toEqual(created.id);
      const v3 = yield* live(created.id);
      expect(policies(v3)).toEqual(["signed"]);
      expect(trimmed.public_playback_id).toBeUndefined();
      expect(trimmed.signed_playback_id).toEqual(idFor(v3, "signed"));
      expect(idFor(v3, "signed")).toEqual(idFor(v2, "signed"));
      expect(renditions(v3, "highest")).toHaveLength(0);
      expect(v3.master_access).toEqual("none");
      expect(v3.thumbnail_time).toBeUndefined();

      // Mux rejects this resolution after the title change has been applied.
      const halfway = yield* Effect.result(
        withDirective(stack, moderation, {
          ...trimmedProps,
          meta: { title: `verify ${run} halfway` },
          static_renditions: [{ resolution: "999p" }],
        }),
      );
      expect(halfway._tag).toEqual("Failure");
      if (halfway._tag === "Failure") expect(halfway.failure._tag).toEqual("BadRequest");
      expect((yield* live(created.id)).meta?.title).toEqual(`verify ${run} halfway`);

      const { asset: reverted } = yield* withDirective(stack, moderation, trimmedProps);
      expect(reverted.id).toEqual(created.id);
      const v4 = yield* live(created.id);
      expect(v4.meta?.title).toEqual(`verify ${run} v2`);
      expect(renditions(v4, "999p")).toHaveLength(0);

      const signedId = idFor(v4, "signed");
      expect(signedId).toBeTypeOf("string");
      yield* Video.updateAsset({
        ASSET_ID: created.id,
        meta: { title: "changed outside alchemy" },
      });
      yield* Video.updateAssetMasterAccess({ ASSET_ID: created.id, master_access: "temporary" });
      yield* Video.deleteAssetPlaybackId({ ASSET_ID: created.id, PLAYBACK_ID: signedId ?? "" });
      yield* Video.createAssetPlaybackId({ ASSET_ID: created.id, policy: "public" });
      const drift = yield* Drift.detect(stack).pipe(Effect.provide(stack.state));
      expect(drift.resources.Asset?.action).toEqual("drifted");
      yield* Drift.repair(stack).pipe(Effect.provide(stack.state));
      const repaired = yield* live(created.id);
      expect(repaired.meta?.title).toEqual(`verify ${run} v2`);
      expect(repaired.master_access).toEqual("none");
      expect(policies(repaired)).toEqual(["signed"]);

      const { meta: _, ...unmetaProps } = trimmedProps;
      const { asset: unset } = yield* withDirective(stack, moderation, unmetaProps);
      expect(unset.id).toEqual(created.id);
      expect((yield* live(created.id)).meta?.title ?? "").toEqual("");

      const redirected = yield* withDirective(stack, `${run} moderation v2`, unmetaProps);
      expect(redirected.directive.id).not.toEqual(directive.id);
      expect(redirected.asset.id).toEqual(created.id);
      expect((yield* runFor(redirected.directive.id, created.id))._tag).toEqual("Some");

      yield* stack.destroy();
      expect(yield* waitUntilGone(created.id)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:video", "live"], timeout: 900_000 },
);

test.provider(
  "text and audio tracks change without re-encoding, a failed track rolls back, and drift restores a deleted track",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const run = `${stack.stage}-asset-tracks`;
      const base: Props = {
        inputs: [{ url: DEMO_URL }],
        test: true,
        passthrough: run,
        meta: { title: `verify ${run}` },
        playback_policies: ["public"],
      };
      const created = yield* deploy(stack, base);

      const captioned = yield* deploy(stack, {
        ...base,
        inputs: [
          {
            url: DEMO_URL,
            generated_subtitles: [{ language_code: "en", name: "English (generated)" }],
          },
          french(FR_VTT),
          spanish,
        ],
      });
      expect(captioned.id).toEqual(created.id);
      const withTracks = yield* live(created.id);
      const [fr] = tracksOf(withTracks, "uploaded", "fr");
      expect(fr?.status).toEqual("ready");
      expect(fr?.name).toEqual("Français");
      const [es] = tracksOf(withTracks, "audio", "es");
      expect(es?.status).toEqual("ready");
      expect(es?.name).toEqual("Español");
      const [en] = tracksOf(withTracks, "generated_vod", "en");
      // Mux skips generating subtitles on test assets; the track still settles.
      expect(en?.id).toBeTypeOf("string");
      expect(en?.status).not.toEqual("preparing");
      expect(en?.status).not.toEqual("errored");

      const recaptionProps: Props = {
        ...base,
        inputs: [{ url: DEMO_URL }, french(EN_VTT), spanish],
      };
      const recaptioned = yield* deploy(stack, recaptionProps);
      expect(recaptioned.id).toEqual(created.id);
      const changed = yield* live(created.id);
      const frenchTracks = tracksOf(changed, "uploaded", "fr");
      expect(frenchTracks).toHaveLength(1);
      expect(frenchTracks[0]?.id).not.toEqual(fr?.id);
      expect(frenchTracks[0]?.status).toEqual("ready");
      expect(tracksOf(changed, "generated_vod", "en")).toHaveLength(0);
      expect(tracksOf(changed, "audio", "es")[0]?.id).toEqual(es?.id);

      const badtrack = yield* Effect.result(
        deploy(stack, {
          ...base,
          inputs: [
            { url: DEMO_URL },
            french(`https://example.com/alchemy-mux/${run}/missing.vtt`),
            spanish,
          ],
        }),
      );
      expect(badtrack._tag).toEqual("Failure");
      if (badtrack._tag === "Failure") expect(badtrack.failure._tag).toEqual("AssetTrackFailed");
      const rolledBack = yield* settledTracks(created.id, "uploaded", "fr");
      expect(rolledBack).toHaveLength(1);
      expect(rolledBack[0]?.status).toEqual("ready");

      const reverted = yield* deploy(stack, recaptionProps);
      expect(reverted.id).toEqual(created.id);

      const [doomed] = yield* settledTracks(created.id, "uploaded", "fr");
      yield* Video.deleteAssetTrack({ ASSET_ID: created.id, TRACK_ID: doomed?.id ?? "" });
      yield* Video.updateAsset({
        ASSET_ID: created.id,
        meta: { title: "changed outside alchemy" },
      });
      const drift = yield* Drift.detect(stack).pipe(Effect.provide(stack.state));
      expect(drift.resources.Asset?.action).toEqual("drifted");
      yield* Drift.repair(stack).pipe(Effect.provide(stack.state));
      const repaired = yield* live(created.id);
      expect(repaired.meta?.title).toEqual(`verify ${run}`);
      const restored = tracksOf(repaired, "uploaded", "fr");
      expect(restored).toHaveLength(1);
      expect(restored[0]?.status).toEqual("ready");
      expect(tracksOf(repaired, "audio", "es")[0]?.id).toEqual(es?.id);

      yield* stack.destroy();
      expect(yield* waitUntilGone(created.id)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:video", "live"], timeout: 1_200_000 },
);

test.provider(
  "a watermark or video quality change creates a new asset and deletes the old one",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const run = `${stack.stage}-asset-replace`;
      const base: Props = {
        inputs: [{ url: DEMO_URL }, french(FR_VTT)],
        test: true,
        video_quality: "basic",
        passthrough: run,
        playback_policies: ["public"],
        static_renditions: [{ resolution: "highest" }],
      };
      const created = yield* deploy(stack, base);
      const fresh = yield* live(created.id);
      expect(renditions(fresh, "highest")).toHaveLength(1);
      expect(tracksOf(fresh, "uploaded", "fr")[0]?.status).toEqual("ready");

      const watermarkProps: Props = {
        ...base,
        inputs: [
          ...base.inputs,
          { url: WATERMARK, overlay_settings: { horizontal_align: "right", width: "10%" } },
        ],
      };
      const watermarked = yield* deploy(stack, watermarkProps);
      expect(watermarked.id).not.toEqual(created.id);
      expect((yield* live(watermarked.id)).status).toEqual("ready");
      expect(yield* waitUntilGone(created.id)).toEqual("gone");

      const reingested = yield* deploy(stack, { ...watermarkProps, video_quality: "plus" });
      expect(reingested.id).not.toEqual(watermarked.id);
      const plus = yield* live(reingested.id);
      expect(plus.status).toEqual("ready");
      expect(plus.video_quality).toEqual("plus");
      expect(tracksOf(plus, "uploaded", "fr")[0]?.status).toEqual("ready");
      expect(yield* waitUntilGone(watermarked.id)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitUntilGone(reingested.id)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:video", "live"], timeout: 1_200_000 },
);

test.provider(
  "a failed ingest fails the deploy and deletes the errored asset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const run = `${stack.stage}-asset-broken`;
      const result = yield* Effect.result(
        deploy(stack, {
          inputs: [{ url: `https://example.com/alchemy-mux/${run}/missing.mp4` }],
          test: true,
          passthrough: run,
        }),
      );
      expect(result._tag).toEqual("Failure");
      if (result._tag === "Failure") expect(result.failure._tag).toEqual("AssetIngestFailed");
      const { data: recent } = yield* Video.listAssets({ limit: 100 });
      expect(recent.filter((asset) => asset.passthrough === run).map((a) => a.id)).toEqual([]);
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:video", "live"], timeout: 300_000 },
);
