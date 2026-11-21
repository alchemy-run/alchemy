import * as Conversations from "@distilled.cloud/slack/conversations";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Providers } from "./Providers.ts";

/** The channel name is held by a channel the bot can't see. */
export class ChannelNameUnavailable extends Data.TaggedError("Slack.ChannelNameUnavailable")<{
  readonly name: string;
  readonly message: string;
}> {}

export interface ChannelProps {
  /**
   * Channel name, without the leading `#`. Lowercase letters, numbers,
   * hyphens and underscores, at most 80 characters. If omitted, a unique name
   * is generated from the app, stage and logical ID.
   *
   * Changing it renames the channel in place (`conversations.rename`).
   */
  name?: string;
  /**
   * Create a private channel. Slack can't convert an existing channel
   * between public and private through the Web API, so changing it replaces
   * the channel.
   * @default false
   */
  isPrivate?: boolean;
  /**
   * The channel topic, shown in the channel header. Plain text, at most 250
   * characters. Omitted leaves whatever topic the channel has.
   */
  topic?: string;
  /**
   * The channel description (Slack's API calls it the purpose). Plain text,
   * at most 250 characters. Omitted leaves whatever description the channel has.
   */
  purpose?: string;
  /**
   * Workspace to create the channel in. Required only when the bot token is
   * an org-level (Enterprise Grid) token.
   */
  teamId?: string;
}

export interface ChannelAttributes {
  /** Channel ID (`C…`). Pass it to bindings and other resources. */
  channelId: string;
  /** Channel name, without the leading `#`. */
  name: string;
  /** Whether the channel is private. */
  isPrivate: boolean;
  /** Current topic. */
  topic: string;
  /** Current description (purpose). */
  purpose: string;
  /** Unix time the channel was created. */
  created: number;
  /** User ID of the member (or bot user) that created the channel. */
  creator: string;
}

/** Props for {@link Channel.lookup}: an existing channel, by ID or name. */
export type ChannelLookup =
  | { channelId: string; name?: never }
  | { name: string; channelId?: never };

export type Channel = Resource<
  "Slack.Channel",
  ChannelProps,
  ChannelAttributes,
  never,
  Providers,
  ChannelLookup
>;

/**
 * A Slack channel, created and managed by the bot of the app whose token the
 * Slack profile holds. The bot joins the channel it creates, so the
 * messaging bindings can post there without an invite.
 *
 * Slack has no delete for channels outside Enterprise Grid, so destroying the
 * resource **archives** the channel. An archived channel keeps its name, so a
 * channel with an explicit `name` that you destroy and deploy again is
 * unarchived and reused rather than recreated.
 *
 * Slack channels carry no labels or tags, so there is no ownership marker:
 * Alchemy only manages channels it created or adopted, and `alchemy unsafe
 * nuke` can't tell them apart from your other channels.
 *
 * Needs the bot scopes `channels:manage` and `channels:read` (and
 * `groups:write`, `groups:read` for private channels).
 *
 * ### Creating a Channel
 * **Example:** A public channel with a generated name
 * ```typescript
 * const alerts = yield* Slack.Channel("Alerts", {
 *   topic: "Production alerts",
 *   purpose: "Pages from the on-call rotation land here.",
 * });
 * ```
 *
 * **Example:** A private channel with a fixed name
 * ```typescript
 * const incidents = yield* Slack.Channel("Incidents", {
 *   name: "incidents",
 *   isPrivate: true,
 * });
 * ```
 *
 * ### Posting to the Channel
 * Bind a messaging capability to the channel inside a Worker or Function.
 *
 * **Example:** Post from a Cloudflare Worker
 * ```typescript
 * const post = yield* Slack.PostMessage(alerts);
 * yield* post({ text: "Deploy finished :rocket:" });
 * ```
 *
 * ### Looking up an existing channel
 * **Example:** Reference #general by name
 * ```typescript
 * const general = Slack.Channel.lookup({ name: "general" });
 * ```
 *
 * @resource
 * @product Channel
 */
export const Channel = Resource<Channel>("Slack.Channel");

const createChannelName = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, maxLength: 80, lowercase: true });

const toAttrs = (channel: Conversations.Conversation): ChannelAttributes => ({
  channelId: channel.id,
  name: channel.name ?? "",
  isPrivate: channel.is_private ?? false,
  topic: channel.topic?.value ?? "",
  purpose: channel.purpose?.value ?? "",
  created: channel.created ?? 0,
  creator: channel.creator ?? "",
});

/** The channel by ID, or `undefined` when Slack no longer has it. */
const getById = (channelId: string) =>
  Conversations.conversationsInfo({ channel: channelId }).pipe(
    Effect.map((response) => response.channel),
    Effect.catchTag("ChannelNotFound", () => Effect.undefined),
  );

/** First channel (archived included) whose name is `name`. */
const findByName = (name: string) =>
  Conversations.listConversations
    .items({ types: "public_channel,private_channel", limit: 200 })
    .pipe(
      Stream.filter((channel) => channel.name === name),
      Stream.runHead,
      Effect.map((found) => (found._tag === "Some" ? found.value : undefined)),
    );

export const ChannelProvider = () =>
  Provider.succeed(Channel, {
    stables: ["channelId", "created", "creator", "isPrivate"],

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (output !== undefined && (news.isPrivate ?? false) !== output.isPrivate) {
        // A fixed name stays taken by the archived old channel, so the
        // replacement can't be created beside it.
        return {
          action: "replace",
          deleteFirst: news.name !== undefined && news.name === output.name,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      if (output?.channelId !== undefined) {
        const channel = yield* getById(output.channelId);
        return channel === undefined || channel.is_archived ? undefined : toAttrs(channel);
      }
      // State was lost after a create: look for the channel by the name this
      // resource would claim. Channels carry no ownership marker, so a found
      // channel is only adopted with `--adopt`.
      const name = yield* createChannelName(id, olds?.name);
      const channel = yield* findByName(name);
      return channel === undefined || channel.is_archived ? undefined : Unowned(toAttrs(channel));
    }),

    lookup: Effect.fn(function* (props) {
      const channel =
        props.channelId !== undefined
          ? yield* getById(props.channelId)
          : yield* findByName(props.name);
      return channel === undefined ? undefined : toAttrs(channel);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const name = yield* createChannelName(id, news.name ?? output?.name);
      const isPrivate = news.isPrivate ?? false;

      // Observe — by the cached ID first, then by name (an archived channel
      // with our name is ours from an earlier deploy).
      let channel = output?.channelId !== undefined ? yield* getById(output.channelId) : undefined;
      if (channel !== undefined && (channel.is_private ?? false) !== isPrivate) {
        channel = undefined;
      }

      // Ensure — create, or take back the archived channel the name belongs to.
      if (channel === undefined) {
        channel = yield* Conversations.createConversation({
          name,
          is_private: isPrivate,
          team_id: news.teamId,
        }).pipe(
          Effect.map((response) => response.channel),
          Effect.catchTag("NameTaken", () => findByName(name)),
        );
      }
      if (channel === undefined) {
        // `name_taken` for a channel the bot can't see (another member's
        // private channel).
        return yield* new ChannelNameUnavailable({
          name,
          message: `Slack channel name '${name}' is taken by a channel the bot can't see. Pick another name.`,
        });
      }
      if (channel.is_archived) {
        yield* Conversations.unarchiveConversation({ channel: channel.id }).pipe(
          Effect.catchTag("NotArchived", () => Effect.void),
        );
      }
      if (channel.is_member === false) {
        yield* Conversations.joinConversation({ channel: channel.id });
      }

      // Sync — compare against the observed channel, not olds.
      if (channel.name !== name) {
        yield* Conversations.renameConversation({ channel: channel.id, name });
      }
      if (news.topic !== undefined && (channel.topic?.value ?? "") !== news.topic) {
        yield* Conversations.setTopic({ channel: channel.id, topic: news.topic });
      }
      if (news.purpose !== undefined && (channel.purpose?.value ?? "") !== news.purpose) {
        yield* Conversations.setPurpose({ channel: channel.id, purpose: news.purpose });
      }

      const fresh = yield* getById(channel.id);
      return toAttrs(fresh ?? channel);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* Conversations.archiveConversation({ channel: output.channelId }).pipe(
        Effect.catchTag(["AlreadyArchived", "ChannelNotFound"], () => Effect.void),
      );
    }),
  });
