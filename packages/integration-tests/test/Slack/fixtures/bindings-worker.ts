import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Slack from "@alchemy.run/slack";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";

/** The channel every channel binding targets. */
export const BindingsChannel = Slack.Channel("BindingsChannel", {
  topic: "alchemy Slack bindings test",
});

type Call = (request: any) => Effect.Effect<unknown, { _tag: string }, RuntimeContext>;

/** Every Slack runtime binding, keyed by name. */
export const bindAll = Effect.fn(function* (channel: Slack.Channel) {
  const bindings: Record<string, Call> = {
    PostMessage: yield* Slack.PostMessage(channel),
    UpdateMessage: yield* Slack.UpdateMessage(channel),
    DeleteMessage: yield* Slack.DeleteMessage(channel),
    PostEphemeral: yield* Slack.PostEphemeral(channel),
    ScheduleMessage: yield* Slack.ScheduleMessage(channel),
    DeleteScheduledMessage: yield* Slack.DeleteScheduledMessage(channel),
    ListScheduledMessages: yield* Slack.ListScheduledMessages(channel),
    GetPermalink: yield* Slack.GetPermalink(channel),
    AddReaction: yield* Slack.AddReaction(channel),
    RemoveReaction: yield* Slack.RemoveReaction(channel),
    GetReactions: yield* Slack.GetReactions(channel),
    PinMessage: yield* Slack.PinMessage(channel),
    UnpinMessage: yield* Slack.UnpinMessage(channel),
    ListPins: yield* Slack.ListPins(channel),
    GetHistory: yield* Slack.GetHistory(channel),
    GetReplies: yield* Slack.GetReplies(channel),
    GetChannelInfo: yield* Slack.GetChannelInfo(channel),
    ListChannelMembers: yield* Slack.ListChannelMembers(channel),
    InviteToChannel: yield* Slack.InviteToChannel(channel),
    RemoveFromChannel: yield* Slack.RemoveFromChannel(channel),
    SetChannelTopic: yield* Slack.SetChannelTopic(channel),
    SetChannelPurpose: yield* Slack.SetChannelPurpose(channel),
    UploadFile: yield* Slack.UploadFile(channel),
    GetUser: yield* Slack.GetUser(),
    LookupUserByEmail: yield* Slack.LookupUserByEmail(),
    ListUsers: yield* Slack.ListUsers(),
    GetUserPresence: yield* Slack.GetUserPresence(),
    OpenConversation: yield* Slack.OpenConversation(),
    ListChannels: yield* Slack.ListChannels(),
    OpenView: yield* Slack.OpenView(),
    PushView: yield* Slack.PushView(),
    UpdateView: yield* Slack.UpdateView(),
    PublishView: yield* Slack.PublishView(),
    GetTeamInfo: yield* Slack.GetTeamInfo(),
  };
  return bindings;
});

// `POST /<Binding>` calls the binding with the JSON body as its request.
// Failures answer 200 with `{ error }` so the test can assert typed tags.
export default class SlackBindingsWorker extends Cloudflare.Worker<SlackBindingsWorker>()(
  "SlackBindingsWorker",
  { main: import.meta.url },
  Effect.gen(function* () {
    const channel = yield* BindingsChannel;
    const bindings = yield* bindAll(channel);

    return {
      fetch: Effect.gen(function* () {
        const request = yield* HttpServerRequest;
        const name = new URL(request.url, "http://worker").pathname.slice(1);
        const binding = bindings[name];
        if (binding === undefined || request.method !== "POST") {
          return HttpServerResponse.text("ok");
        }
        const body = yield* request.json;
        return yield* binding(body).pipe(
          Effect.map((data) => ({ data })),
          Effect.catch((error) => Effect.succeed({ error: { _tag: error._tag } })),
          Effect.flatMap((result) => HttpServerResponse.json(result)),
        );
      }).pipe(Effect.orDie),
    };
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Slack.PostMessageHttp,
        Slack.UpdateMessageHttp,
        Slack.DeleteMessageHttp,
        Slack.PostEphemeralHttp,
        Slack.ScheduleMessageHttp,
        Slack.DeleteScheduledMessageHttp,
        Slack.ListScheduledMessagesHttp,
        Slack.GetPermalinkHttp,
        Slack.AddReactionHttp,
        Slack.RemoveReactionHttp,
        Slack.GetReactionsHttp,
        Slack.PinMessageHttp,
        Slack.UnpinMessageHttp,
        Slack.ListPinsHttp,
        Slack.GetHistoryHttp,
        Slack.GetRepliesHttp,
        Slack.GetChannelInfoHttp,
        Slack.ListChannelMembersHttp,
        Slack.InviteToChannelHttp,
        Slack.RemoveFromChannelHttp,
        Slack.SetChannelTopicHttp,
        Slack.SetChannelPurposeHttp,
        Slack.UploadFileHttp,
        Slack.GetUserHttp,
        Slack.LookupUserByEmailHttp,
        Slack.ListUsersHttp,
        Slack.GetUserPresenceHttp,
        Slack.OpenConversationHttp,
        Slack.ListChannelsHttp,
        Slack.OpenViewHttp,
        Slack.PushViewHttp,
        Slack.UpdateViewHttp,
        Slack.PublishViewHttp,
        Slack.GetTeamInfoHttp,
      ),
    ),
  ),
) {}
