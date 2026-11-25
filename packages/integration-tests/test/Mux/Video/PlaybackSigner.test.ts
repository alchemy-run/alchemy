import * as Mux from "@alchemy.run/mux";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Video from "@distilled.cloud/mux/video";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: Mux.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const status = (url: string) => HttpClient.get(url).pipe(Effect.map((response) => response.status));

const deleteAssets = (passthrough: string) =>
  Video.listAssets.items({ limit: 100 }).pipe(
    Stream.filter((asset) => asset.passthrough === passthrough),
    Stream.runForEach((asset) =>
      Video.deleteAsset({ ASSET_ID: asset.id }).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
      ),
    ),
  );

// The deployed-host path is `test/Mux/Bindings.test.ts`; this pins the
// token format itself against Mux's edge from the test process.
test.provider(
  "signPlaybackToken signs tokens that stream.mux.com and image.mux.com accept",
  (stack) =>
    Effect.gen(function* () {
      const passthrough = `alchemy-test-signer-${stack.stage}`;
      yield* stack.destroy();
      yield* deleteAssets(passthrough);

      const key = yield* stack.deploy(Mux.System.SigningKey("Key"));
      const { data: asset } = yield* Video.createAsset({
        inputs: [{ url: "https://storage.googleapis.com/muxdemofiles/mux.mp4" }],
        playback_policies: ["signed"],
        video_quality: "basic",
        test: true,
        passthrough,
      });
      const playbackId = asset.playback_ids!.find((p) => p.policy === "signed")!.id!;
      yield* Video.getAsset({ ASSET_ID: asset.id }).pipe(
        Effect.flatMap(({ data }) =>
          data.status === "ready" ? Effect.void : Effect.fail(new Error(`asset is ${data.status}`)),
        ),
        Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 90 }),
      );

      const signer = { id: key.id, privateKey: Redacted.value(key.private_key) };
      const sign = (options?: Mux.Video.SignOptions) =>
        Effect.promise(() => Mux.Video.signPlaybackToken(signer, playbackId, options));
      const hls = `https://stream.mux.com/${playbackId}.m3u8`;

      expect(yield* status(hls)).toEqual(403);
      const video = yield* sign();
      // A new signing key can take a moment to reach Mux's edge.
      const played = yield* status(`${hls}?token=${video}`).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (code) => code === 200,
          times: 30,
        }),
      );
      expect(played).toEqual(200);

      const thumbnail = yield* sign({ type: "thumbnail", claims: { time: 1 } });
      expect(
        yield* status(`https://image.mux.com/${playbackId}/thumbnail.jpg?token=${thumbnail}`),
      ).toEqual(200);
      expect(yield* status(`${hls}?token=${thumbnail}`)).toEqual(403);
      const expired = yield* sign({ expiresIn: -120 });
      expect(yield* status(`${hls}?token=${expired}`)).toEqual(403);
      const tampered = video.slice(0, -4) + (video.endsWith("AAAA") ? "BBBB" : "AAAA");
      expect(yield* status(`${hls}?token=${tampered}`)).toEqual(403);

      yield* Video.deleteAsset({ ASSET_ID: asset.id });
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:video", "live"], timeout: 300_000 },
);
