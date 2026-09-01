import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as stream from "@distilled.cloud/cloudflare/stream";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, declared in the distilled error union) on the test's
// own out-of-band verification calls.
const getLiveInput = (accountId: string, liveInputId: string) =>
  stream.getLiveInput({ accountId, liveInputIdentifier: liveInputId }).pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: Schedule.exponential("500 millis"),
      times: 8,
    }),
  );

const expectGone = (accountId: string, liveInputId: string) =>
  getLiveInput(accountId, liveInputId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "LiveInputNotDeleted" } as const)),
    // A missing live input surfaces as `LiveInputNotFound` (Cloudflare
    // error code 10003) — that's the success condition here.
    Effect.catchTag("LiveInputNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "LiveInputNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "create, update in place, and delete a live input",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const input = yield* stack.deploy(
        Cloudflare.Stream.LiveInput("BroadcastInput", {
          meta: { name: "alchemy-stream-live-input" },
          recording: { mode: "automatic", timeoutSeconds: 10 },
        }),
      );

      expect(input.liveInputId).toBeTruthy();
      expect(input.accountId).toEqual(accountId);
      expect(input.enabled).toBe(true);
      expect(input.meta).toMatchObject({ name: "alchemy-stream-live-input" });

      const live = yield* getLiveInput(accountId, input.liveInputId);
      expect(live.uid).toEqual(input.liveInputId);
      expect(live.enabled).toBe(true);

      // Update mutable props in place — same uid, no replacement.
      const updated = yield* stack.deploy(
        Cloudflare.Stream.LiveInput("BroadcastInput", {
          enabled: false,
          meta: { name: "alchemy-stream-live-input-v2" },
          recording: { mode: "automatic", timeoutSeconds: 10 },
        }),
      );

      expect(updated.liveInputId).toEqual(input.liveInputId);
      expect(updated.enabled).toBe(false);
      expect(updated.meta).toMatchObject({
        name: "alchemy-stream-live-input-v2",
      });

      const observed = yield* getLiveInput(accountId, updated.liveInputId);
      expect(observed.enabled).toBe(false);

      // Redeploying identical props is a no-op (still the same input).
      const noop = yield* stack.deploy(
        Cloudflare.Stream.LiveInput("BroadcastInput", {
          enabled: false,
          meta: { name: "alchemy-stream-live-input-v2" },
          recording: { mode: "automatic", timeoutSeconds: 10 },
        }),
      );
      expect(noop.liveInputId).toEqual(input.liveInputId);

      yield* stack.destroy();

      yield* expectGone(accountId, input.liveInputId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// The Stream WebRTC beta adds no separate API resource: every live input
// is simultaneously reachable over WHIP (publish) and WHEP (playback).
// This pins that alchemy surfaces those endpoints verbatim as Cloudflare
// returns them, and that they carry the documented shapes.
//
// https://developers.cloudflare.com/stream/webrtc-beta/
test.provider(
  "surfaces WHIP/WHEP and RTMPS/SRT endpoints",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const input = yield* stack.deploy(
        Cloudflare.Stream.LiveInput("WebRTCInput", {
          meta: { name: "alchemy-stream-webrtc-input" },
        }),
      );

      // WHIP — the publish URL embeds a secret, so it is Redacted.
      const whip = Redacted.value(input.webRTCUrl!);
      expect(whip).toMatch(
        /^https:\/\/customer-[a-z0-9]+\.cloudflarestream\.com\/.+\/webRTC\/publish$/,
      );
      // WHEP — the playback URL is what viewers connect to.
      expect(input.webRTCPlaybackUrl!).toMatch(
        /^https:\/\/customer-[a-z0-9]+\.cloudflarestream\.com\/.+\/webRTC\/play$/,
      );

      // Cloudflare's two docs disagree on the path segment of these URLs:
      // the WebRTC beta guide says publish is keyed by a secret and play by
      // the input uid, while the live-input API example shows BOTH keyed by
      // the same secret. That distinction decides whether handing a viewer
      // the WHEP URL also leaks publish access, so record what the live API
      // actually returns rather than asserting either reading.
      const publishSegment = new URL(whip).pathname.split("/")[1];
      const playbackSegment = new URL(input.webRTCPlaybackUrl!).pathname.split(
        "/",
      )[1];
      yield* Effect.log(
        `webRTC publish segment is uid: ${publishSegment === input.liveInputId}; ` +
          `playback segment is uid: ${playbackSegment === input.liveInputId}; ` +
          `publish === playback: ${publishSegment === playbackSegment}`,
      );

      // The other ingest protocols come back on the same response.
      expect(input.rtmps!.url).toContain("rtmps://");
      expect(Redacted.value(input.rtmps!.streamKey)).toBeTruthy();
      expect(input.rtmpsPlayback!.url).toContain("rtmps://");
      expect(input.srt!.url).toContain("srt://");
      // `srt.streamId` is its own Cloudflare-minted id, not the input uid.
      expect(input.srt!.streamId).toBeTruthy();
      expect(Redacted.value(input.srt!.passphrase)).toBeTruthy();
      expect(input.srtPlayback!.url).toBeTruthy();

      // Out-of-band: the endpoints alchemy persists are exactly what
      // Cloudflare reports for the same input.
      const observed = yield* getLiveInput(accountId, input.liveInputId);
      expect(observed.webRTC?.url).toEqual(whip);
      expect(observed.webRTCPlayback?.url).toEqual(input.webRTCPlaybackUrl);
      expect(observed.rtmps?.url).toEqual(input.rtmps!.url);

      // A no-op redeploy returns the observed (GET) response rather than an
      // update response — the endpoints must survive that path too.
      const noop = yield* stack.deploy(
        Cloudflare.Stream.LiveInput("WebRTCInput", {
          meta: { name: "alchemy-stream-webrtc-input" },
        }),
      );
      expect(noop.liveInputId).toEqual(input.liveInputId);
      expect(Redacted.value(noop.webRTCUrl!)).toEqual(whip);
      expect(noop.webRTCPlaybackUrl).toEqual(input.webRTCPlaybackUrl);

      // And the update path (dirty reconcile -> PUT response).
      const updated = yield* stack.deploy(
        Cloudflare.Stream.LiveInput("WebRTCInput", {
          meta: { name: "alchemy-stream-webrtc-input-v2" },
        }),
      );
      expect(updated.liveInputId).toEqual(input.liveInputId);
      expect(Redacted.value(updated.webRTCUrl!)).toEqual(whip);
      expect(updated.webRTCPlaybackUrl).toEqual(input.webRTCPlaybackUrl);

      yield* stack.destroy();

      yield* expectGone(accountId, input.liveInputId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

test.provider(
  "recreates after out-of-band delete",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      const input = yield* stack.deploy(
        Cloudflare.Stream.LiveInput("HealInput", {
          meta: { name: "alchemy-stream-heal-input" },
        }),
      );

      // Delete the live input out-of-band. A redeploy with identical props
      // is a planner no-op, so change a prop to force reconcile — it must
      // observe the input as missing and recreate it instead of failing.
      yield* stream
        .deleteLiveInput({ accountId, liveInputIdentifier: input.liveInputId })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "Forbidden",
            schedule: Schedule.exponential("500 millis"),
            times: 8,
          }),
        );

      const healed = yield* stack.deploy(
        Cloudflare.Stream.LiveInput("HealInput", {
          enabled: false,
          meta: { name: "alchemy-stream-heal-input" },
        }),
      );

      expect(healed.liveInputId).not.toEqual(input.liveInputId);
      expect(healed.enabled).toBe(false);

      yield* stack.destroy();

      yield* expectGone(accountId, healed.liveInputId);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Canonical `list()` test (account collection): deploy a live input, then
// resolve the typed provider and assert the deployed uid appears in the
// exhaustively-enumerated result.
//
// GATED — blocked on a distilled schema mismatch, not an entitlement: the
// account *can* create/list live inputs (the CRUD cases above pass), but
// `stream.listLiveInputs` fails to decode the live response. The Cloudflare
// REST API returns `result` as a bare array of live-input objects, while the
// upstream cloudflare-typescript SDK (and therefore distilled) types the
// `result` payload as the object `{ liveInputs, range, total }`. The decode
// throws, verbatim:
//
//   CloudflareHttpError { status: 200, statusText: "Schema decode failed" }
//   GET /accounts/{account_id}/stream/live_inputs
//   body: {"result":[{"uid":"…","created":"…",…}],"success":true,…}
//
// Needed distilled patch: model `ListLiveInputsResponse` as
// `Array<LiveInput>` decoded at ResponsePath("result") (not the wrapper
// object). The current patch DSL can't express this — `op.responsePath`
// ("result", from the SDK's `_thenUnwrap`) wins over `patch.responsePath`,
// and `responseType: "array"` wraps the wrapper object rather than the item
// — so it requires a generator/spec-level fix. Once landed, drop this gate
// and map `response` (the array) directly in LiveInput.ts's `list()`.
test.provider.skipIf(!process.env.CLOUDFLARE_TEST_STREAM_LIST)(
  "list enumerates the deployed live input",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const input = yield* stack.deploy(
        Cloudflare.Stream.LiveInput("ListInput", {
          meta: { name: "alchemy-stream-list-input" },
        }),
      );

      const provider = yield* Provider.findProvider(
        Cloudflare.Stream.LiveInput,
      );
      const all = yield* provider.list();

      expect(all.some((x) => x.liveInputId === input.liveInputId)).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);
