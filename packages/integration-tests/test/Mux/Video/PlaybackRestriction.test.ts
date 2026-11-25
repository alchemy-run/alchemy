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
  Video.getPlaybackRestriction({ PLAYBACK_RESTRICTION_ID: id }).pipe(Effect.map((res) => res.data));

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

const STRICT = {
  referrer: { allowed_domains: ["example.com", "*.example.com"], allow_no_referrer: true },
  user_agent: { allow_no_user_agent: false, allow_high_risk_user_agent: false },
};

test.provider(
  "create, update in place, and return removed settings to Mux defaults",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Mux.Video.PlaybackRestriction("Restriction", {
          referrer: { allowed_domains: ["example.com"] },
        }),
      );
      const first = yield* live(created.id);
      expect(first.referrer.allowed_domains).toEqual(["example.com"]);
      expect(first.referrer.allow_no_referrer ?? false).toEqual(false);
      expect(first.user_agent).toEqual({
        allow_no_user_agent: true,
        allow_high_risk_user_agent: true,
      });
      expect(created.user_agent).toEqual(first.user_agent);

      const updated = yield* stack.deploy(Mux.Video.PlaybackRestriction("Restriction", STRICT));
      expect(updated.id).toEqual(created.id);
      const second = yield* live(created.id);
      expect(second.referrer.allowed_domains).toEqual(["example.com", "*.example.com"]);
      expect(second.referrer.allow_no_referrer).toEqual(true);
      expect(second.user_agent).toEqual(STRICT.user_agent);

      const reverted = yield* stack.deploy(
        Mux.Video.PlaybackRestriction("Restriction", {
          referrer: { allowed_domains: ["example.com"] },
        }),
      );
      expect(reverted.id).toEqual(created.id);
      const third = yield* live(created.id);
      expect(third.referrer.allowed_domains).toEqual(["example.com"]);
      expect(third.referrer.allow_no_referrer ?? false).toEqual(false);
      expect(third.user_agent).toEqual(first.user_agent);

      yield* stack.destroy();
      expect(yield* waitUntilGone(created.id)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:video", "live"], timeout: 120_000 },
);

test.provider(
  "drift repair puts back rules edited outside Alchemy and recreates a deleted restriction",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const restriction = Mux.Video.PlaybackRestriction("Restriction", STRICT);

      const created = yield* stack.deploy(restriction);
      yield* Video.updateReferrerDomainRestriction({
        PLAYBACK_RESTRICTION_ID: created.id,
        allowed_domains: ["*"],
      });
      yield* Video.updateUserAgentRestriction({
        PLAYBACK_RESTRICTION_ID: created.id,
        allow_no_user_agent: true,
        allow_high_risk_user_agent: true,
      });

      const drift = yield* Drift.detect(stack).pipe(Effect.provide(stack.state));
      expect(drift.resources.Restriction?.action).toBe("drifted");
      yield* Drift.repair(stack).pipe(Effect.provide(stack.state));
      const repaired = yield* live(created.id);
      expect(repaired.referrer.allowed_domains).toEqual(STRICT.referrer.allowed_domains);
      expect(repaired.referrer.allow_no_referrer).toEqual(true);
      expect(repaired.user_agent).toEqual(STRICT.user_agent);

      yield* Video.deletePlaybackRestriction({ PLAYBACK_RESTRICTION_ID: created.id });
      const missing = yield* Drift.detect(stack).pipe(Effect.provide(stack.state));
      expect(missing.resources.Restriction?.action).toBe("missing");
      yield* Drift.repair(stack).pipe(Effect.provide(stack.state));

      const recreated = yield* stack.deploy(restriction);
      expect(recreated.id).not.toEqual(created.id);
      expect((yield* live(recreated.id)).user_agent).toEqual(STRICT.user_agent);

      yield* stack.destroy();
      expect(yield* waitUntilGone(recreated.id)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:video", "live"], timeout: 120_000 },
);
