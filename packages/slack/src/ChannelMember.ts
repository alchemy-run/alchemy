import * as Conversations from "@distilled.cloud/slack/conversations";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Providers } from "./Providers.ts";

export interface ChannelMemberProps {
  /** Channel ID. Changing it replaces the membership. */
  channelId: string;
  /** Member user ID (`U…`/`W…`). Changing it replaces the membership. */
  userId: string;
}

export interface ChannelMemberAttributes {
  channelId: string;
  userId: string;
}

export type ChannelMember = Resource<
  "Slack.ChannelMember",
  ChannelMemberProps,
  ChannelMemberAttributes,
  never,
  Providers
>;

/**
 * A member of a channel: invites the user on deploy and removes them on
 * destroy.
 *
 * Needs the bot scopes `channels:write.invites` and `channels:manage` (or the
 * `groups:` equivalents for private channels), and the bot must be in the
 * channel. Workspace settings may stop bots from removing members
 * (`restricted_action`).
 *
 * ### Adding a Member
 * **Example:** Put the on-call lead in the incidents channel
 * ```typescript
 * yield* Slack.ChannelMember("Lead", {
 *   channelId: incidents.channelId,
 *   userId: "U0123456789",
 * });
 * ```
 *
 * @resource
 * @product Channel
 */
export const ChannelMember = Resource<ChannelMember>("Slack.ChannelMember");

const isMember = (channelId: string, userId: string) =>
  Conversations.conversationsMembers.items({ channel: channelId, limit: 200 }).pipe(
    Stream.filter((member) => member === userId),
    Stream.runHead,
    Effect.map(Option.isSome),
    Effect.catchTag("ChannelNotFound", () => Effect.succeed(false)),
  );

export const ChannelMemberProvider = () =>
  Provider.succeed(ChannelMember, {
    stables: ["channelId", "userId"],
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (news.channelId !== output.channelId || news.userId !== output.userId) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ output }) {
      if (output === undefined) return undefined;
      return (yield* isMember(output.channelId, output.userId)) ? output : undefined;
    }),
    reconcile: Effect.fn(function* ({ news }) {
      if (!(yield* isMember(news.channelId, news.userId))) {
        yield* Conversations.inviteConversation({
          channel: news.channelId,
          users: news.userId,
        }).pipe(Effect.catchTag("AlreadyInChannel", () => Effect.void));
      }
      return { channelId: news.channelId, userId: news.userId };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* Conversations.conversationsKick({
        channel: output.channelId,
        user: output.userId,
      }).pipe(
        Effect.catchTag(["NotInChannel", "ChannelNotFound", "UserNotFound"], () => Effect.void),
      );
    }),
  });
