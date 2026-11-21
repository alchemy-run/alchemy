import * as Canvases from "@distilled.cloud/slack/canvases";
import * as Conversations from "@distilled.cloud/slack/conversations";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "./Providers.ts";

export interface CanvasProps {
  /** Title shown at the top of the canvas. */
  title?: string;
  /**
   * The canvas content, as Slack-flavored markdown (at most 1 MiB).
   *
   * Slack rewrites markdown into its own form, so the deployed content can't
   * be compared with this text. It is written when it differs from the last
   * deploy; edits people make in Slack stay until then.
   */
  markdown?: string;
  /**
   * Channel ID to add the canvas to as a tab. Free workspaces can't create
   * standalone canvases, so it is required there. Changing it replaces the
   * canvas.
   */
  channelId?: string;
}

export interface CanvasAttributes {
  /** Canvas ID (`F…`; canvases are files). */
  canvasId: string;
  title: string | undefined;
  markdown: string | undefined;
  channelId: string | undefined;
}

export type Canvas = Resource<"Slack.Canvas", CanvasProps, CanvasAttributes, never, Providers>;

/**
 * A Slack canvas: a document that lives in the workspace, optionally added
 * to a channel as a tab.
 *
 * Needs the bot scope `canvases:write` (and `canvases:read` to detect a
 * canvas deleted outside the stack). Free workspaces can only create
 * canvases in a channel (`free_teams_cannot_create_standalone_canvases`).
 *
 * ### Creating a Canvas
 * **Example:** An on-call handbook tabbed into a channel
 * ```typescript
 * yield* Slack.Canvas("Handbook", {
 *   title: "On-call handbook",
 *   channelId: incidents.channelId,
 *   markdown: "# Paging\n\nAcknowledge within 5 minutes.",
 * });
 * ```
 *
 * @resource
 * @product Canvas
 */
export const Canvas = Resource<Canvas>("Slack.Canvas");

export interface ChannelCanvasProps {
  /** The channel whose canvas this is. Changing it replaces the canvas. */
  channelId: string;
  /** Title shown at the top of the canvas. */
  title?: string;
  /**
   * The canvas content, as Slack-flavored markdown. Written when it differs
   * from the last deploy (see {@link CanvasProps.markdown}).
   */
  markdown?: string;
}

export type ChannelCanvas = Resource<
  "Slack.ChannelCanvas",
  ChannelCanvasProps,
  CanvasAttributes,
  never,
  Providers
>;

/**
 * A channel's own canvas — the one Slack shows at the top of the channel.
 * Each channel has at most one.
 *
 * Needs the bot scope `canvases:write`, and the bot must be a member of the
 * channel.
 *
 * ### Creating a Channel Canvas
 * **Example:** Pin the channel's working agreement
 * ```typescript
 * yield* Slack.ChannelCanvas("Agreement", {
 *   channelId: team.channelId,
 *   markdown: "## How we work\n\n- Threads for discussion\n- :eyes: means on it",
 * });
 * ```
 *
 * @resource
 * @product Canvas
 */
export const ChannelCanvas = Resource<ChannelCanvas>("Slack.ChannelCanvas");

const content = (markdown: string | undefined) =>
  markdown === undefined ? undefined : { type: "markdown", markdown };

/** Whether the canvas still exists. */
const exists = (canvasId: string) =>
  Canvases.getContent({ canvas_id: canvasId }).pipe(
    Effect.as(true),
    Effect.catchTag("CanvasNotFound", () => Effect.succeed(false)),
  );

/** Bring title and content in line with the props. */
const syncCanvas = (
  canvasId: string,
  news: { title?: string; markdown?: string },
  olds: { title?: string; markdown?: string } | undefined,
) =>
  Effect.gen(function* () {
    if (news.title !== undefined && news.title !== olds?.title) {
      yield* Canvases.editCanvase({
        canvas_id: canvasId,
        changes: [
          { operation: "rename", title_content: { type: "markdown", markdown: news.title } },
        ],
      });
    }
    if (news.markdown !== undefined && news.markdown !== olds?.markdown) {
      yield* Canvases.editCanvase({
        canvas_id: canvasId,
        changes: [
          { operation: "replace", document_content: { type: "markdown", markdown: news.markdown } },
        ],
      });
    }
  });

const deleteCanvas = (canvasId: string) =>
  Canvases.deleteCanvase({ canvas_id: canvasId }).pipe(
    Effect.catchTag("CanvasNotFound", () => Effect.void),
  );

const replaceOnChannelChange = Effect.fn(function* ({
  news,
  output,
}: {
  news: unknown;
  output: CanvasAttributes | undefined;
}) {
  if (!isResolved(news)) return undefined;
  const channelId = (news as { channelId?: string }).channelId;
  if (output !== undefined && channelId !== output.channelId) {
    return { action: "replace" } as const;
  }
  return undefined;
});

export const CanvasProvider = () =>
  Provider.succeed(Canvas, {
    stables: ["canvasId", "channelId"],
    diff: replaceOnChannelChange,
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      return (yield* exists(output.canvasId)) ? output : undefined;
    }),
    reconcile: Effect.fn(function* ({ news, olds, output }) {
      const present = output !== undefined && (yield* exists(output.canvasId));
      if (!present) {
        const created = yield* Canvases.createCanvase({
          title: news.title,
          channel_id: news.channelId,
          document_content: content(news.markdown),
        });
        return {
          canvasId: created.canvas_id,
          title: news.title,
          markdown: news.markdown,
          channelId: news.channelId,
        };
      }
      yield* syncCanvas(output.canvasId, news, olds);
      return { ...output, title: news.title, markdown: news.markdown };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* deleteCanvas(output.canvasId);
    }),
  });

export const ChannelCanvasProvider = () =>
  Provider.succeed(ChannelCanvas, {
    stables: ["canvasId", "channelId"],
    diff: replaceOnChannelChange,
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      return (yield* exists(output.canvasId)) ? output : undefined;
    }),
    reconcile: Effect.fn(function* ({ news, olds, output }) {
      const present = output !== undefined && (yield* exists(output.canvasId));
      if (!present) {
        const created = yield* Conversations.createCanvase({
          channel_id: news.channelId,
          title: news.title,
          document_content: content(news.markdown),
        });
        return {
          canvasId: created.canvas_id,
          title: news.title,
          markdown: news.markdown,
          channelId: news.channelId,
        };
      }
      yield* syncCanvas(output.canvasId, news, olds);
      return { ...output, title: news.title, markdown: news.markdown };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* deleteCanvas(output.canvasId);
    }),
  });
