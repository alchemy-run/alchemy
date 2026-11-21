import * as Slack from "@alchemy.run/slack";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Canvases from "@distilled.cloud/slack/canvases";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: Slack.providers() });

const markdownOf = (canvasId: string) =>
  Canvases.getContent({ canvas_id: canvasId, content_type: "markdown" }).pipe(
    Effect.map((r) => r.content),
    Effect.catchTag("CanvasNotFound", () => Effect.undefined),
  );

test.provider(
  "Canvas: create in a channel, rewrite the content, delete on destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (markdown: string) =>
        Effect.gen(function* () {
          const channel = yield* Slack.Channel("Handbook", {});
          return yield* Slack.Canvas("Handbook", {
            title: "Handbook",
            channelId: channel.channelId,
            markdown,
          });
        });

      const created = yield* stack.deploy(program("# Paging\n\nfirst version"));
      expect(created.canvasId).toMatch(/^F/);
      expect(yield* markdownOf(created.canvasId)).toContain("first version");

      const updated = yield* stack.deploy(program("# Paging\n\nsecond version"));
      expect(updated.canvasId).toBe(created.canvasId);
      const content = yield* markdownOf(created.canvasId);
      expect(content).toContain("second version");
      expect(content).not.toContain("first version");

      yield* stack.destroy();
      expect(yield* markdownOf(created.canvasId)).toBeUndefined();
    }),
  { tags: ["provider:slack", "provider:slack:canvas", "live"], timeout: 120_000 },
);

test.provider(
  "ChannelCanvas: the channel's own canvas, rewritten and deleted",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = (markdown: string) =>
        Effect.gen(function* () {
          const channel = yield* Slack.Channel("Team", {});
          return yield* Slack.ChannelCanvas("Agreement", {
            channelId: channel.channelId,
            markdown,
          });
        });

      const created = yield* stack.deploy(program("## How we work\n\nfirst"));
      expect(yield* markdownOf(created.canvasId)).toContain("first");
      yield* stack.deploy(program("## How we work\n\nsecond"));
      expect(yield* markdownOf(created.canvasId)).toContain("second");

      yield* stack.destroy();
      expect(yield* markdownOf(created.canvasId)).toBeUndefined();
    }),
  { tags: ["provider:slack", "provider:slack:canvas", "live"], timeout: 120_000 },
);
