import * as Mux from "@alchemy.run/mux";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Robots from "@distilled.cloud/mux/robots";
import * as Drift from "alchemy/Drift";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Mux.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const live = (id: string) =>
  Robots.getDirective({ DIRECTIVE_ID: id }).pipe(Effect.map((res) => res.data));

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

const captions = (name: string) =>
  Mux.Robots.Directive("Captions", {
    name,
    resources: [
      {
        reference_id: "captions_en",
        type: "video.asset.track",
        kind: "subtitles",
        language_code: "en",
        source: { via: "workflow", binding: "premium_captions" },
      },
    ],
    bindings: [
      {
        reference_id: "premium_captions",
        workflow: "generate-premium-captions",
        parameters: { language_code: "en" },
      },
      {
        reference_id: "translate_es",
        workflow: "translate-captions",
        inputs: ["captions_en"],
        parameters: { output_language_code: "es" },
      },
    ],
  });

test.provider(
  "create a directive, keep it on redeploy, and replace it when its configuration changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const tag = `alchemy-test-directive-${stack.stage}`;

      const created = yield* stack.deploy(captions(`${tag} v1`));
      const first = yield* live(created.id);
      expect(first.name).toEqual(`${tag} v1`);
      expect(first.subject).toEqual({ type: "video.asset" });
      expect(first.bindings.map((b) => b.reference_id)).toEqual([
        "premium_captions",
        "translate_es",
      ]);
      expect(first.resources).toEqual(created.resources);
      expect(JSON.stringify(first.resources)).toContain('"binding":"premium_captions"');

      const again = yield* stack.deploy(captions(`${tag} v1`));
      expect(again.id).toEqual(created.id);

      const renamed = yield* stack.deploy(captions(`${tag} v2`));
      expect(renamed.id).not.toEqual(created.id);
      expect((yield* live(renamed.id)).name).toEqual(`${tag} v2`);
      expect(yield* waitUntilGone(created.id)).toEqual("gone");

      yield* stack.destroy();
      expect(yield* waitUntilGone(renamed.id)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:robots", "live"], timeout: 120_000 },
);

test.provider(
  "drift repair recreates a directive deleted outside Alchemy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const moderation = Mux.Robots.Directive("Moderation", {
        name: `alchemy-test-directive-drift-${stack.stage}`,
        bindings: [{ reference_id: "moderation", workflow: "moderate" }],
      });

      const first = yield* stack.deploy(moderation);
      yield* Robots.deleteDirective({ DIRECTIVE_ID: first.id });

      const drift = yield* Drift.detect(stack).pipe(Effect.provide(stack.state));
      expect(drift.resources.Moderation?.action).toBe("missing");
      yield* Drift.repair(stack).pipe(Effect.provide(stack.state));

      const second = yield* stack.deploy(moderation);
      expect(second.id).not.toEqual(first.id);
      // Mux fills in the workflow's default parameters.
      expect((yield* live(second.id)).bindings).toMatchObject([
        { reference_id: "moderation", workflow: "moderate" },
      ]);

      yield* stack.destroy();
      expect(yield* waitUntilGone(second.id)).toEqual("gone");
    }).pipe(logLevel),
  { tags: ["provider:mux", "provider:mux:robots", "live"], timeout: 120_000 },
);
