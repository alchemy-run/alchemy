import { expect } from "@alchemy.run/test";

/** State the scenario threads through the cases, in order. */
export interface Ctx {
  guildId: string;
  channelId: string;
  webhookId: string;
  botId: string;
  appId: string;
  messageId: string;
  pollMessageId: string;
  webhookMessageId: string;
  threadId: string;
  inviteCode: string;
  dmChannelId: string;
  soundId: string;
}
export const ctx = {} as Ctx;

/** A snowflake no object has. */
const NONE = "1";

interface Case {
  /** Request body, built from what earlier cases recorded. */
  readonly request: (ctx: Ctx) => unknown;
  /** `"ok"`, or the one typed tag the call must fail with. */
  readonly expect: "ok" | string;
  /** Assertions on the success value; may record into `ctx`. */
  readonly check?: (data: any, ctx: Ctx) => void;
  /** Why this case asserts a failure instead of success. */
  readonly why?: string;
}

const ok = (request: Case["request"], check?: Case["check"]): Case => ({
  request,
  expect: "ok",
  check,
});
const fails = (tag: string, request: Case["request"], why: string): Case => ({
  request,
  expect: tag,
  why,
});

export const cases: Record<string, Case> = {
  // Identity first: later cases need these ids.
  GetBotUser: ok(
    () => ({}),
    (data, c) => {
      expect(data.bot).toBe(true);
      c.botId = data.id;
    },
  ),
  GetApplication: ok(
    () => ({}),
    (data, c) => {
      c.appId = data.id;
      expect(data.bot?.id).toBe(c.botId);
    },
  ),
  ListBotGuilds: ok(
    () => ({ limit: 200 }),
    (data, c) => expect(data.some((g: { id: string }) => g.id === c.guildId)).toBe(true),
  ),
  GetUser: ok(
    (c) => ({ user_id: c.botId }),
    (data, c) => expect(data.id).toBe(c.botId),
  ),
  GetGateway: ok(
    () => ({}),
    (data) => expect(data.url).toMatch(/^wss:\/\//),
  ),
  GetBotGateway: ok(
    () => ({}),
    (data) => expect(data.shards).toBeGreaterThan(0),
  ),
  ListVoiceRegions: ok(
    () => ({}),
    (data) => expect(data.length).toBeGreaterThan(0),
  ),
  ListStickerPacks: ok(
    () => ({}),
    (data) => expect(Array.isArray(data.sticker_packs)).toBe(true),
  ),
  GetStickerPack: fails("NotFound", () => ({ pack_id: NONE }), "no pack has id 1"),
  GetSticker: fails("NotFound", () => ({ sticker_id: NONE }), "no sticker has id 1"),
  ListDefaultSoundboardSounds: ok(
    () => ({}),
    (data) => expect(data.length).toBeGreaterThan(0),
  ),

  // Channel reads.
  GetChannel: ok(
    () => ({}),
    (data, c) => expect(data.id).toBe(c.channelId),
  ),
  GetChannelMemberPermissions: ok(
    (c) => ({ user_id: c.botId }),
    (data) => expect(typeof data.permissions).toBe("string"),
  ),
  GetChannelRolePermissions: ok(
    (c) => ({ role_id: c.guildId }),
    (data) => expect(typeof data.permissions).toBe("string"),
  ),

  // Messages.
  SendMessage: ok(
    () => ({ content: "alchemy bindings: SendMessage" }),
    (data, c) => {
      expect(data.content).toBe("alchemy bindings: SendMessage");
      c.messageId = data.id;
    },
  ),
  GetMessage: ok(
    (c) => ({ message_id: c.messageId }),
    (data, c) => expect(data.id).toBe(c.messageId),
  ),
  EditMessage: ok(
    (c) => ({ message_id: c.messageId, content: "alchemy bindings: edited" }),
    (data) => expect(data.content).toBe("alchemy bindings: edited"),
  ),
  ListMessages: ok(
    () => ({ limit: 10 }),
    (data, c) => expect(data.some((m: { id: string }) => m.id === c.messageId)).toBe(true),
  ),
  TriggerTyping: ok(() => ({})),
  CrosspostMessage: fails(
    "UnknownDiscordError",
    (c) => ({ message_id: c.messageId }),
    "the bindings channel is a text channel; crossposting needs an announcement channel (50068)",
  ),

  // Reactions.
  AddReaction: ok((c) => ({ message_id: c.messageId, emoji_name: "👍" })),
  ListReactions: ok(
    (c) => ({ message_id: c.messageId, emoji_name: "👍" }),
    (data, c) => expect(data.map((u: { id: string }) => u.id)).toContain(c.botId),
  ),
  RemoveReaction: ok((c) => ({ message_id: c.messageId, emoji_name: "👍" })),
  RemoveUserReaction: ok((c) => ({
    message_id: c.messageId,
    emoji_name: "👍",
    user_id: c.botId,
  })),
  RemoveEmojiReactions: ok((c) => ({ message_id: c.messageId, emoji_name: "👍" })),
  RemoveAllReactions: ok((c) => ({ message_id: c.messageId })),

  // Pins.
  PinMessage: ok((c) => ({ message_id: c.messageId })),
  ListPins: ok(
    () => ({}),
    (data, c) =>
      expect(
        data.items.some((p: { message: { id: string } }) => p.message.id === c.messageId),
      ).toBe(true),
  ),
  UnpinMessage: ok((c) => ({ message_id: c.messageId })),

  // Polls.
  EndPoll: ok(
    (c) => ({ message_id: c.pollMessageId }),
    (data) => expect(data.poll?.results?.is_finalized ?? true).toBe(true),
  ),
  GetPollVoters: ok(
    (c) => ({ message_id: c.pollMessageId, answer_id: 1 }),
    (data) => expect(data.users).toEqual([]),
  ),

  // Threads.
  StartThreadFromMessage: ok(
    (c) => ({ message_id: c.messageId, name: "alchemy bindings thread" }),
    (data, c) => {
      c.threadId = data.id;
      expect(data.name).toBe("alchemy bindings thread");
    },
  ),
  JoinThread: ok((c) => ({ channel_id: c.threadId })),
  GetThreadMember: ok(
    (c) => ({ channel_id: c.threadId, user_id: c.botId }),
    (data, c) => expect(data.user_id).toBe(c.botId),
  ),
  ListThreadMembers: ok(
    (c) => ({ channel_id: c.threadId }),
    (data, c) => expect(data.map((m: { user_id: string }) => m.user_id)).toContain(c.botId),
  ),
  AddThreadMember: ok((c) => ({ channel_id: c.threadId, user_id: c.botId })),
  RemoveThreadMember: ok((c) => ({ channel_id: c.threadId, user_id: c.botId })),
  LeaveThread: ok((c) => ({ channel_id: c.threadId })),
  ListActiveThreads: ok(
    () => ({}),
    (data, c) => expect(data.threads.some((t: { id: string }) => t.id === c.threadId)).toBe(true),
  ),
  EditThread: ok(
    (c) => ({ channel_id: c.threadId, body: { archived: true } }),
    (data) => expect(data.thread_metadata?.archived).toBe(true),
  ),
  ListPublicArchivedThreads: ok(
    () => ({}),
    (data, c) => expect(data.threads.some((t: { id: string }) => t.id === c.threadId)).toBe(true),
  ),
  ListPrivateArchivedThreads: ok(() => ({})),
  ListJoinedPrivateArchivedThreads: ok(() => ({})),
  CreateThread: ok(
    () => ({ body: { name: "alchemy bindings private thread", type: 12 } }),
    (data) => expect(data.type).toBe(12),
  ),
  SearchThreads: fails(
    "UnknownDiscordError",
    () => ({ name: "alchemy" }),
    "thread search only works on forum and media channels",
  ),
  DeleteThread: ok((c) => ({ channel_id: c.threadId })),

  // Webhook (token only).
  ExecuteWebhook: ok(
    () => ({ wait: true, body: { content: "alchemy bindings: ExecuteWebhook" } }),
    (data, c) => {
      c.webhookMessageId = data.id;
      expect(data.webhook_id).toBe(c.webhookId);
    },
  ),
  GetWebhookMessage: ok(
    (c) => ({ message_id: c.webhookMessageId }),
    (data, c) => expect(data.id).toBe(c.webhookMessageId),
  ),
  EditWebhookMessage: ok(
    (c) => ({ message_id: c.webhookMessageId, content: "edited by webhook" }),
    (data) => expect(data.content).toBe("edited by webhook"),
  ),
  DeleteWebhookMessage: ok((c) => ({ message_id: c.webhookMessageId })),
  ExecuteSlackWebhook: ok(() => ({ wait: true, text: "alchemy bindings: slack" })),
  ExecuteGitHubWebhook: ok(() => ({
    wait: true,
    sender: {
      id: 1,
      login: "alchemy",
      html_url: "https://github.com/alchemy-run",
      avatar_url: "https://github.com/alchemy-run.png",
    },
    repository: {
      id: 1,
      name: "alchemy",
      full_name: "alchemy-run/alchemy",
      html_url: "https://github.com/alchemy-run/alchemy",
    },
    ref: "refs/heads/main",
    ref_type: "branch",
  })),
  GetWebhookWithToken: ok(
    () => ({}),
    (data, c) => expect(data.id).toBe(c.webhookId),
  ),
  ListChannelWebhooks: ok(
    () => ({}),
    (data, c) => expect(data.some((w: { id: string }) => w.id === c.webhookId)).toBe(true),
  ),
  ListGuildWebhooks: ok(
    () => ({}),
    (data, c) => expect(data.some((w: { id: string }) => w.id === c.webhookId)).toBe(true),
  ),

  // Invites.
  CreateInvite: ok(
    () => ({ body: { max_uses: 1, max_age: 600, unique: true } }),
    (data, c) => {
      c.inviteCode = data.code;
    },
  ),
  GetInvite: ok(
    (c) => ({ code: c.inviteCode }),
    (data, c) => expect(data.code).toBe(c.inviteCode),
  ),
  ListChannelInvites: ok(
    () => ({}),
    (data, c) => expect(data.some((i: { code: string }) => i.code === c.inviteCode)).toBe(true),
  ),
  ListGuildInvites: ok(
    () => ({}),
    (data, c) => expect(data.some((i: { code: string }) => i.code === c.inviteCode)).toBe(true),
  ),
  GetInviteTargetUsers: fails(
    "NotFound",
    (c) => ({ code: c.inviteCode }),
    "the invite has no target users",
  ),
  AddInviteTargetUser: fails(
    "UnknownDiscordError",
    (c) => ({ code: c.inviteCode, user_id: c.botId }),
    "target users only apply to invites created with target_user_ids",
  ),
  RemoveInviteTargetUser: fails(
    "UnknownDiscordError",
    (c) => ({ code: c.inviteCode, user_id: c.botId }),
    "target users only apply to invites created with target_user_ids",
  ),
  BulkAddInviteTargetUsers: fails(
    "UnknownDiscordError",
    (c) => ({ code: c.inviteCode, user_ids: [c.botId] }),
    "target users only apply to invites created with target_user_ids",
  ),
  BulkRemoveInviteTargetUsers: fails(
    "UnknownDiscordError",
    (c) => ({ code: c.inviteCode, user_ids: [c.botId] }),
    "target users only apply to invites created with target_user_ids",
  ),
  SetInviteTargetUsers: fails(
    "UnknownDiscordError",
    (c) => ({ code: c.inviteCode, target_users_file: "user_id\n1\n" }),
    "a JSON body can't carry the CSV file part",
  ),
  GetInviteTargetUsersJobStatus: fails(
    "NotFound",
    (c) => ({ code: c.inviteCode }),
    "no bulk job ran for the invite",
  ),
  RevokeInvite: ok((c) => ({ code: c.inviteCode })),

  // Guild reads.
  GetGuild: ok(
    () => ({ with_counts: true }),
    (data, c) => expect(data.id).toBe(c.guildId),
  ),
  GetGuildPreview: ok(
    () => ({}),
    (data, c) => expect(data.id).toBe(c.guildId),
  ),
  ListChannels: ok(
    () => ({}),
    (data, c) => expect(data.some((ch: { id: string }) => ch.id === c.channelId)).toBe(true),
  ),
  ReorderChannels: ok((c) => ({ body: [{ id: c.channelId, position: 0 }] })),
  ListRoles: ok(
    () => ({}),
    (data, c) => expect(data.some((r: { id: string }) => r.id === c.guildId)).toBe(true),
  ),
  GetRole: ok(
    (c) => ({ role_id: c.guildId }),
    (data) => expect(data.name).toBe("@everyone"),
  ),
  GetRoleMemberCounts: ok(() => ({})),
  GetRolePermissions: ok(
    (c) => ({ role_id: c.guildId }),
    (data) => expect(typeof data.permissions).toBe("string"),
  ),
  ListIntegrations: ok(
    () => ({}),
    (data, c) =>
      expect(
        data.some((i: { application?: { id: string } }) => i.application?.id === c.appId),
      ).toBe(true),
  ),
  DeleteIntegration: fails(
    "NotFound",
    () => ({ integration_id: NONE }),
    "removing the bot's own integration would kick it from the test guild",
  ),
  ListGuildVoiceRegions: ok(() => ({})),
  GetVanityUrl: fails(
    "UnknownDiscordError",
    () => ({}),
    "the test guild has no vanity URL feature",
  ),
  GetWidget: ok(() => ({})),
  GetWidgetImage: ok(() => ({ style: "banner2" })),
  GetWelcomeScreen: ok(() => ({})),
  GetOnboarding: ok(
    () => ({}),
    (data, c) => expect(data.guild_id).toBe(c.guildId),
  ),
  GetNewMemberWelcome: fails("NotFound", () => ({}), "the test guild has no new-member home"),
  ListEmojis: ok(() => ({})),
  ListStickers: ok(() => ({})),
  ListSoundboardSounds: ok(
    () => ({}),
    (data) => expect(Array.isArray(data.items)).toBe(true),
  ),
  ListGuildTemplates: ok(() => ({})),
  GetTemplate: fails("NotFound", () => ({ code: "alchemy-no-such-template" }), "unknown code"),
  ListAutoModerationRules: ok(() => ({})),
  ListAuditLog: ok(
    () => ({ limit: 10 }),
    (data) => expect(Array.isArray(data.audit_log_entries)).toBe(true),
  ),
  SearchMessages: ok(() => ({ content: "alchemy" })),
  UpdateIncidentActions: ok(() => ({ invites_disabled_until: null, dms_disabled_until: null })),

  // Members.
  GetBotMember: ok(
    () => ({}),
    (data, c) => expect(data.user.id).toBe(c.botId),
  ),
  EditBotMember: ok(
    () => ({ nick: "alchemy bindings" }),
    (data) => expect(data.nick).toBe("alchemy bindings"),
  ),
  GetMember: ok(
    (c) => ({ user_id: c.botId }),
    (data, c) => expect(data.user.id).toBe(c.botId),
  ),
  GetMemberPermissions: ok((c) => ({ user_id: c.botId })),
  ListMembers: ok(
    () => ({ limit: 10 }),
    (data) => expect(data.length).toBeGreaterThan(0),
  ),
  SearchMembers: ok(() => ({ query: "a", limit: 10 })),
  EditMember: ok(
    (c) => ({ user_id: c.botId, nick: null }),
    (data) => expect(data.nick ?? null).toBeNull(),
  ),
  AddMemberRole: fails(
    "NotFound",
    (c) => ({ user_id: c.botId, role_id: NONE }),
    "no role has id 1 (MemberRole.test.ts covers a real assignment)",
  ),
  RemoveMemberRole: fails(
    "NotFound",
    (c) => ({ user_id: c.botId, role_id: NONE }),
    "no role has id 1",
  ),
  AddMember: fails(
    "UnknownDiscordError",
    () => ({ user_id: NONE, access_token: "not-a-token" }),
    "needs a user's OAuth2 token with guilds.join",
  ),
  KickMember: fails("NotFound", () => ({ user_id: NONE }), "no member has id 1"),
  PreviewPrune: ok(
    () => ({ days: 30 }),
    (data) => expect(typeof data.pruned).toBe("number"),
  ),
  PruneMembers: ok(
    // compute_prune_count=false with an empty include_roles still prunes
    // only members with no roles inactive 30 days; the test guild has none.
    () => ({ days: 30, compute_prune_count: true, include_roles: [] }),
    (data) => expect(data.pruned).toBe(0),
  ),
  ListJoinRequests: fails(
    "UnknownDiscordError",
    () => ({}),
    "the test guild doesn't use membership applications",
  ),
  ActOnJoinRequest: fails(
    "NotFound",
    () => ({ request_id: NONE, action: "APPROVED" }),
    "no request has id 1",
  ),

  // Moderation.
  GetBan: fails("NotFound", () => ({ user_id: NONE }), "no ban for user 1"),
  ListBans: ok(() => ({})),
  BanMember: fails(
    "NotFound",
    () => ({ user_id: NONE }),
    "banning a real user would need a second account",
  ),
  BulkBanMembers: fails(
    "UnknownDiscordError",
    () => ({ user_ids: [NONE] }),
    "Discord refuses a bulk ban that bans nobody (500000)",
  ),
  UnbanMember: fails("NotFound", () => ({ user_id: NONE }), "no ban for user 1"),

  // Events and voice.
  ListScheduledEvents: ok(() => ({ with_user_count: true })),
  GetScheduledEvent: fails(
    "NotFound",
    () => ({ guild_scheduled_event_id: NONE }),
    "no event has id 1 (ScheduledEvent.test.ts covers a real one)",
  ),
  ListScheduledEventUsers: fails(
    "NotFound",
    () => ({ guild_scheduled_event_id: NONE }),
    "no event has id 1",
  ),
  CountScheduledEventUsers: fails(
    "NotFound",
    () => ({ guild_scheduled_event_id: NONE }),
    "no event has id 1",
  ),
  ListScheduledEventExceptionUsers: fails(
    "NotFound",
    () => ({ guild_scheduled_event_id: NONE, guild_scheduled_event_exception_id: NONE }),
    "no event has id 1",
  ),
  GetVoiceState: fails(
    "NotFound",
    (c) => ({ user_id: c.botId }),
    "the bot isn't in a voice channel",
  ),
  GetBotVoiceState: fails("NotFound", () => ({}), "the bot isn't in a voice channel"),
  EditVoiceState: fails(
    "UnknownDiscordError",
    (c) => ({ user_id: c.botId, suppress: false }),
    "voice state edits need a stage channel the member is in",
  ),
  EditBotVoiceState: fails(
    "UnknownDiscordError",
    () => ({ suppress: false }),
    "voice state edits need a stage channel the bot is in",
  ),
  SendSoundboardSound: fails(
    "UnknownDiscordError",
    (c) => ({ sound_id: c.soundId }),
    "the bindings channel is a text channel and the bot isn't connected to voice",
  ),
  SetVoiceChannelStatus: fails(
    "UnknownDiscordError",
    () => ({ status: "alchemy" }),
    "the bindings channel is a text channel",
  ),

  // Commands.
  ListCommands: ok(() => ({})),
  GetCommand: fails("NotFound", () => ({ command_id: NONE }), "no command has id 1"),
  ListGuildCommands: ok((c) => ({ application_id: c.appId })),
  GetCommandPermissions: fails(
    "NotFound",
    (c) => ({ application_id: c.appId, command_id: NONE }),
    "no command has id 1",
  ),
  ListCommandPermissions: ok((c) => ({ application_id: c.appId })),

  // DMs.
  CreateDm: fails(
    "UnknownDiscordError",
    (c) => ({ recipient_id: c.botId }),
    "a bot can't open a DM with itself (50007)",
  ),

  // Activities.
  GetActivityInstance: fails(
    "NotFound",
    () => ({ instance_id: "i-1" }),
    "the test application has no Activity running",
  ),
  UploadAttachment: fails(
    "UnknownDiscordError",
    () => ({ file: "x" }),
    "attachments are for Activities, which the test application doesn't enable",
  ),

  // Monetization: the test application sells nothing.
  ListEntitlements: ok(
    () => ({}),
    (data) => expect(Array.isArray(data)).toBe(true),
  ),
  GetEntitlement: fails("NotFound", () => ({ entitlement_id: NONE }), "no entitlements"),
  ConsumeEntitlement: fails("NotFound", () => ({ entitlement_id: NONE }), "no entitlements"),
  DeleteTestEntitlement: fails("NotFound", () => ({ entitlement_id: NONE }), "no entitlements"),
  CreateTestEntitlement: fails(
    "NotFound",
    (c) => ({ sku_id: NONE, owner_id: c.guildId, owner_type: 1 }),
    "the test application has no SKUs",
  ),
  ListSkuSubscriptions: fails(
    "NotFound",
    (c) => ({ sku_id: NONE, user_id: c.botId }),
    "the test application has no SKUs",
  ),
  GetSkuSubscription: fails(
    "NotFound",
    () => ({ sku_id: NONE, subscription_id: NONE }),
    "the test application has no SKUs",
  ),

  // Social SDK lobbies: the test application doesn't enable the Social SDK.
  CreateLobby: fails("UnknownDiscordError", () => ({}), "Social SDK not enabled for the app"),
  GetLobby: fails("NotFound", () => ({ lobby_id: NONE }), "no lobby has id 1"),
  EditLobby: fails("NotFound", () => ({ lobby_id: NONE }), "no lobby has id 1"),
  DeleteLobby: fails("NotFound", () => ({ lobby_id: NONE }), "no lobby has id 1"),
  AddLobbyMember: fails(
    "NotFound",
    (c) => ({ lobby_id: NONE, user_id: c.botId }),
    "no lobby has id 1",
  ),
  RemoveLobbyMember: fails(
    "NotFound",
    (c) => ({ lobby_id: NONE, user_id: c.botId }),
    "no lobby has id 1",
  ),
  BulkUpdateLobbyMembers: fails(
    "NotFound",
    (c) => ({ lobby_id: NONE, body: [{ id: c.botId }] }),
    "no lobby has id 1",
  ),
  LinkLobbyChannel: fails("NotFound", () => ({ lobby_id: NONE }), "no lobby has id 1"),
  SendLobbyMessage: fails(
    "NotFound",
    () => ({ lobby_id: NONE, content: "gg" }),
    "no lobby has id 1",
  ),
  ListLobbyMessages: fails("NotFound", () => ({ lobby_id: NONE }), "no lobby has id 1"),
  CreateLobbyGuildInvite: fails(
    "NotFound",
    (c) => ({ lobby_id: NONE, user_id: c.botId }),
    "no lobby has id 1",
  ),
  ModerateLobbyMessage: fails(
    "NotFound",
    () => ({ lobby_id: NONE, message_id: NONE, body: {} }),
    "no lobby has id 1",
  ),
  ModerateUserMessage: fails(
    "NotFound",
    (c) => ({ user_id_1: c.botId, user_id_2: NONE, message_id: NONE, body: {} }),
    "no game DM exists",
  ),
  CreateProvisionalToken: fails(
    "UnknownDiscordError",
    () => ({ external_user_id: "alchemy-test-player" }),
    "provisional accounts need the Social SDK enabled",
  ),
  UnmergeProvisionalAccount: fails(
    "UnknownDiscordError",
    () => ({ external_user_id: "alchemy-test-player" }),
    "provisional accounts need the Social SDK enabled",
  ),

  // Cleanup last.
  DeleteMessage: ok((c) => ({ message_id: c.messageId })),
  BulkDeleteMessages: fails(
    "UnknownDiscordError",
    () => ({ messages: [NONE, "2"] }),
    "bulk delete refuses ids older than two weeks (50034)",
  ),
  LeaveGuild: fails(
    "NotFound",
    () => ({}),
    "never actually leave: the bound guild is the bindings Worker's; asserted against a guild the bot isn't in",
  ),
};
