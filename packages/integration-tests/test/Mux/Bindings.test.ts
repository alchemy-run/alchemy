import { createHmac } from "node:crypto";
import * as Docker from "@alchemy.run/docker";
import * as Mux from "@alchemy.run/mux";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as Video from "@distilled.cloud/mux/video";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { ensureDockerSwarm, publishedUrl } from "../Docker/Runtime.ts";
import MuxBindingsHost, { Hook, Key } from "./fixtures/bindings-host.ts";

const testOptions = { providers: Layer.mergeAll(Mux.providers(), Docker.providers()) };
const { test, beforeAll, afterAll } = Test.make(testOptions);
const sharedStack = Core.scratchStack(testOptions, "MuxBindings");

const PASSTHROUGH = `alchemy-test-bindings-${Core.resolveStage({})}`;

let host: string;
let playbackId: string;
let assetId: string | undefined;
let signingSecret: Redacted.Redacted<string>;

const status = (url: string) => HttpClient.get(url).pipe(Effect.map((response) => response.status));

const fetchText = (request: HttpClientRequest.HttpClientRequest) =>
  HttpClient.execute(request).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(Effect.map((text) => ({ status: response.status, text }))),
    ),
  );

const sign = (query: Record<string, string>) =>
  fetchText(
    HttpClientRequest.get(`${host}/sign`).pipe(
      HttpClientRequest.setUrlParams({ playback_id: playbackId, ...query }),
    ),
  ).pipe(
    Effect.flatMap(({ status, text }) =>
      status === 200 ? Effect.succeed(text) : Effect.fail(new Error(`/sign ${status}: ${text}`)),
    ),
  );

const deleteTestAssets = Video.listAssets.items({ limit: 100 }).pipe(
  Stream.filter((asset) => asset.passthrough === PASSTHROUGH),
  Stream.runForEach((asset) =>
    Video.deleteAsset({ ASSET_ID: asset.id }).pipe(Effect.catchTag("NotFound", () => Effect.void)),
  ),
);

const muxSignature = (secret: string, body: string, t: number) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;

const hls = () => `https://stream.mux.com/${playbackId}.m3u8`;

describe(
  "Mux bindings in a Docker service",
  {
    tags: ["provider:mux", "provider:mux:video", "provider:mux:system", "provider:docker", "live"],
  },
  () => {
    beforeAll(
      Effect.gen(function* () {
        yield* ensureDockerSwarm;
        yield* sharedStack.destroy();
        yield* deleteTestAssets;

        const { data: asset } = yield* Video.createAsset({
          inputs: [{ url: "https://storage.googleapis.com/muxdemofiles/mux.mp4" }],
          playback_policies: ["signed"],
          video_quality: "basic",
          test: true,
          passthrough: PASSTHROUGH,
        });
        assetId = asset.id;
        playbackId = asset.playback_ids!.find((p) => p.policy === "signed")!.id!;
        yield* Effect.logInfo(`Mux bindings: asset ${asset.id}, signed playback id ${playbackId}`);
        yield* Video.getAsset({ ASSET_ID: asset.id }).pipe(
          Effect.flatMap(({ data }) =>
            data.status === "ready"
              ? Effect.void
              : Effect.fail(new Error(`asset is ${data.status}`)),
          ),
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 90 }),
        );

        const deployed = yield* sharedStack.deploy(
          Effect.gen(function* () {
            const service = yield* MuxBindingsHost;
            yield* Key;
            const hook = yield* Hook;
            return {
              ports: service.ports,
              signingSecret: hook.signing_secret,
            };
          }),
        );
        host = publishedUrl(deployed.ports);
        signingSecret = deployed.signingSecret;

        yield* HttpClient.get(`${host}/health`).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? Effect.void
              : Effect.fail(new Error(`host not ready: ${response.status}`)),
          ),
          Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 60 }),
        );
      }).pipe(Effect.provide(Mux.providers())),
      { timeout: 600_000 },
    );

    afterAll(
      Effect.gen(function* () {
        yield* sharedStack.destroy();
        if (assetId !== undefined) {
          yield* Video.deleteAsset({ ASSET_ID: assetId }).pipe(
            Effect.catchTag("NotFound", () => Effect.void),
          );
        }
      }).pipe(Effect.provide(Mux.providers())),
      { timeout: 300_000 },
    );

    describe("PlaybackSigner", () => {
      test.provider(
        "signs tokens that stream.mux.com and image.mux.com accept, and only for what they unlock",
        () =>
          Effect.gen(function* () {
            expect(yield* status(hls())).toEqual(403);

            const video = yield* sign({});
            // A new signing key can take a moment to reach Mux's edge.
            const played = yield* status(`${hls()}?token=${video}`).pipe(
              Effect.repeat({
                schedule: Schedule.spaced("2 seconds"),
                until: (code) => code === 200,
                times: 30,
              }),
            );
            expect(played).toEqual(200);

            const thumbnail = yield* sign({ type: "thumbnail", time: "1" });
            expect(
              yield* status(`https://image.mux.com/${playbackId}/thumbnail.jpg?token=${thumbnail}`),
            ).toEqual(200);
            expect(yield* status(`${hls()}?token=${thumbnail}`)).toEqual(403);

            const expired = yield* sign({ expires_in: "-120" });
            expect(yield* status(`${hls()}?token=${expired}`)).toEqual(403);

            const tampered = video.slice(0, -4) + (video.endsWith("AAAA") ? "BBBB" : "AAAA");
            expect(yield* status(`${hls()}?token=${tampered}`)).toEqual(403);
          }),
        { timeout: 120_000 },
      );
    });

    describe("WebhookVerifier", () => {
      const verify = (body: string, header: string | undefined) =>
        fetchText(
          HttpClientRequest.post(`${host}/verify`).pipe(
            HttpClientRequest.bodyText(body),
            header === undefined
              ? (request) => request
              : HttpClientRequest.setHeader("mux-signature", header),
          ),
        );

      test.provider(
        "accepts Mux's signature and rejects tampered, foreign, stale and missing ones",
        () =>
          Effect.gen(function* () {
            const secret = Redacted.value(signingSecret);
            expect(secret.length).toBeGreaterThanOrEqual(16);
            const body = JSON.stringify({ type: "video.asset.ready", data: { id: assetId } });
            const now = Math.floor(Date.now() / 1000);
            const header = muxSignature(secret, body, now);

            expect((yield* verify(body, header)).status).toEqual(204);

            const tampered = yield* verify(body.replace("ready", "errored"), header);
            expect(tampered).toEqual({ status: 401, text: "signature mismatch" });
            const foreign = yield* verify(body, muxSignature("not-the-secret", body, now));
            expect(foreign).toEqual({ status: 401, text: "signature mismatch" });
            const stale = yield* verify(body, muxSignature(secret, body, now - 600));
            expect(stale).toEqual({ status: 401, text: "timestamp outside tolerance" });
            const missing = yield* verify(body, undefined);
            expect(missing).toEqual({ status: 401, text: "missing mux-signature header" });
          }),
        { timeout: 60_000 },
      );
    });
  },
);
