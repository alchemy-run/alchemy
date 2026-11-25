import * as Mux from "@alchemy.run/mux";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Video from "@distilled.cloud/mux/video";
import * as Drift from "alchemy/Drift";
import * as Provider from "alchemy/Provider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Mux.providers() });

/** Distilled decodes Mux secrets as `Redacted`; its types also allow a plain string. */
const reveal = (value: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const URL_A = "rtmp://example.com/simulcast-a";
const URL_B = "rtmp://example.com/simulcast-b";

const program = (props: { url: string; policy: "public" | "signed"; run: string }) =>
  Effect.gen(function* () {
    const stream = yield* Mux.Video.LiveStream("Stream", {
      playback_policies: [props.policy],
      // Mux rejects simulcast targets on test streams. It never receives video.
      test: false,
      passthrough: props.run,
    });
    const target = yield* Mux.Video.SimulcastTarget("Target", {
      live_stream_id: stream.id,
      url: props.url,
      stream_key: Redacted.make(`key-${props.run}`),
      passthrough: props.run,
    });
    return { stream, target };
  });

const getTarget = (target: { id: string; live_stream_id: string }) =>
  Video.getLiveStreamSimulcastTarget({
    LIVE_STREAM_ID: target.live_stream_id,
    SIMULCAST_TARGET_ID: target.id,
  }).pipe(
    Effect.map((res) => res.data),
    Effect.catchTag("NotFound", () => Effect.undefined),
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
  "create, replace on change, recreate after drift, follow a replaced stream, and delete a simulcast target",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const run = `alchemy-${stack.stage}-simulcast`;

      const created = yield* stack.deploy(program({ url: URL_A, policy: "public", run }));
      expect(created.target.live_stream_id).toBe(created.stream.id);
      expect(Redacted.value(created.target.url)).toBe(URL_A);
      expect(created.target.passthrough).toBe(run);
      expect("stream_key" in created.target).toBe(false);
      const live = yield* getTarget(created.target);
      expect(live === undefined ? undefined : reveal(live.url)).toBe(URL_A);
      expect(live?.passthrough).toBe(run);

      const provider = yield* Provider.findProvider(Mux.Video.SimulcastTarget);
      const listed = yield* provider.list!();
      expect(listed.map((target) => target.id)).toContain(created.target.id);

      const unchanged = yield* stack.plan(program({ url: URL_A, policy: "public", run }));
      expect(unchanged.resources.Target?.action).toBe("noop");

      // Mux has no update endpoint, so a new URL replaces the target.
      const retargeted = yield* stack.deploy(program({ url: URL_B, policy: "public", run }));
      expect(retargeted.stream.id).toBe(created.stream.id);
      expect(retargeted.target.id).not.toBe(created.target.id);
      expect(Redacted.value(retargeted.target.url)).toBe(URL_B);
      expect(yield* getTarget(created.target)).toBeUndefined();

      // A target deleted outside Alchemy is recreated by drift repair.
      yield* Video.deleteLiveStreamSimulcastTarget({
        LIVE_STREAM_ID: retargeted.target.live_stream_id,
        SIMULCAST_TARGET_ID: retargeted.target.id,
      });
      const drift = yield* Drift.detect(stack).pipe(Effect.provide(stack.state));
      expect(drift.resources.Target?.action).toBe("missing");
      yield* Drift.repair(stack).pipe(Effect.provide(stack.state));
      const repaired = yield* stack.deploy(program({ url: URL_B, policy: "public", run }));
      expect(repaired.target.id).not.toBe(retargeted.target.id);
      const recreated = yield* getTarget(repaired.target);
      expect(recreated === undefined ? undefined : reveal(recreated.url)).toBe(URL_B);

      // Replacing the stream moves the target to the new stream.
      const moved = yield* stack.deploy(program({ url: URL_B, policy: "signed", run }));
      expect(moved.stream.id).not.toBe(created.stream.id);
      expect(moved.target.live_stream_id).toBe(moved.stream.id);
      expect(yield* getTarget(moved.target)).toMatchObject({ id: moved.target.id });
      expect(yield* waitUntilGone(created.stream.id)).toBe("gone");

      yield* stack.destroy();
      expect(yield* getTarget(moved.target)).toBeUndefined();
      expect(yield* waitUntilGone(moved.stream.id)).toBe("gone");
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:video", "live"], timeout: 300_000 },
);
