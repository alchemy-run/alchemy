/**
 * Generates one `Binding.Service` contract (`src/<Name>.ts`) and one `*Http`
 * layer (`src/<Name>Http.ts`) per Discord data-plane operation in
 * {@link BINDINGS}, and rewrites `src/index.ts`.
 *
 * The table is the source of truth for which distilled operations are
 * bindings, what they bind to, and their docs. Generated files carry a header
 * and are overwritten; edit the table and rerun:
 *
 *   node packages/discord/scripts/generate-bindings.ts && pnpm exec oxfmt packages/discord/src
 */
import * as fs from "node:fs";
import * as path from "node:path";

type Target = "Channel" | "Guild" | "Application" | "Webhook";

interface Row {
  /** Binding name (`Discord.<name>`). */
  name: string;
  /** Distilled operation. */
  op: string;
  target: Target;
  product: string;
  /** One sentence: what the binding does. */
  doc: string;
  /** Example request literal; defaults to the remaining required fields. */
  example?: string;
}

const B = (
  name: string,
  op: string,
  target: Target,
  product: string,
  doc: string,
  example?: string,
): Row => ({ name, op, target, product, doc, example });

export const BINDINGS: Row[] = [
  // Messages
  B(
    "SendMessage",
    "createMessage",
    "Channel",
    "Message",
    "Post a message in the bound channel.",
    `{ content: "Deployed v1.2.3" }`,
  ),
  B("GetMessage", "getMessage", "Channel", "Message", "Read one message in the bound channel."),
  B(
    "ListMessages",
    "listMessages",
    "Channel",
    "Message",
    "List recent messages in the bound channel (up to 100 per call).",
    `{ limit: 50 }`,
  ),
  B(
    "EditMessage",
    "updateMessage",
    "Channel",
    "Message",
    "Edit a message the bot sent in the bound channel.",
    `{ message_id, content: "Edited" }`,
  ),
  B(
    "DeleteMessage",
    "deleteMessage",
    "Channel",
    "Message",
    "Delete a message in the bound channel (`MANAGE_MESSAGES` for others' messages).",
  ),
  B(
    "BulkDeleteMessages",
    "bulkDeleteMessages",
    "Channel",
    "Message",
    "Delete 2-100 messages younger than two weeks in the bound channel.",
    `{ messages: [id1, id2] }`,
  ),
  B(
    "CrosspostMessage",
    "crosspostMessage",
    "Channel",
    "Message",
    "Publish a message in the bound announcement channel to its followers.",
  ),
  B(
    "TriggerTyping",
    "triggerTypingIndicator",
    "Channel",
    "Message",
    "Show the bot as typing in the bound channel for 10 seconds.",
    `{}`,
  ),
  B(
    "EndPoll",
    "pollExpire",
    "Channel",
    "Message",
    "End a poll the bot posted in the bound channel now.",
  ),
  B(
    "GetPollVoters",
    "getAnswerVoters",
    "Channel",
    "Message",
    "List users who voted for one answer of a poll in the bound channel.",
  ),
  // Reactions
  B(
    "AddReaction",
    "addMyMessageReaction",
    "Channel",
    "Message",
    "React to a message in the bound channel as the bot.",
    `{ message_id, emoji_name: "👍" }`,
  ),
  B(
    "RemoveReaction",
    "deleteMyMessageReaction",
    "Channel",
    "Message",
    "Remove the bot's own reaction from a message in the bound channel.",
  ),
  B(
    "RemoveUserReaction",
    "deleteUserMessageReaction",
    "Channel",
    "Message",
    "Remove another user's reaction from a message in the bound channel.",
  ),
  B(
    "RemoveAllReactions",
    "deleteAllMessageReactions",
    "Channel",
    "Message",
    "Remove every reaction from a message in the bound channel.",
  ),
  B(
    "RemoveEmojiReactions",
    "deleteAllMessageReactionsByEmoji",
    "Channel",
    "Message",
    "Remove every reaction of one emoji from a message in the bound channel.",
  ),
  B(
    "ListReactions",
    "listMessageReactionsByEmoji",
    "Channel",
    "Message",
    "List users who reacted with one emoji to a message in the bound channel.",
  ),
  // Pins
  B("PinMessage", "createPin", "Channel", "Message", "Pin a message in the bound channel."),
  B("UnpinMessage", "deletePin", "Channel", "Message", "Unpin a message in the bound channel."),
  B(
    "ListPins",
    "listPins",
    "Channel",
    "Message",
    "List pinned messages in the bound channel.",
    `{}`,
  ),
  // Threads
  B(
    "CreateThread",
    "createThread",
    "Channel",
    "Thread",
    "Start a thread (or a forum post) in the bound channel.",
    `{ body: { name: "Incident 42", type: 11 } }`,
  ),
  B(
    "StartThreadFromMessage",
    "createThreadFromMessage",
    "Channel",
    "Thread",
    "Start a thread from a message in the bound channel.",
    `{ message_id, name: "Discussion" }`,
  ),
  B(
    "ListPublicArchivedThreads",
    "listPublicArchivedThreads",
    "Channel",
    "Thread",
    "List archived public threads of the bound channel.",
    `{}`,
  ),
  B(
    "ListPrivateArchivedThreads",
    "listPrivateArchivedThreads",
    "Channel",
    "Thread",
    "List archived private threads of the bound channel.",
    `{}`,
  ),
  B(
    "ListJoinedPrivateArchivedThreads",
    "listMyPrivateArchivedThreads",
    "Channel",
    "Thread",
    "List archived private threads of the bound channel the bot has joined.",
    `{}`,
  ),
  B(
    "SearchThreads",
    "searchThread",
    "Channel",
    "Thread",
    "Search the threads (forum posts) of the bound channel.",
    `{ name: "bug" }`,
  ),
  B(
    "JoinThread",
    "joinThread",
    "Application",
    "Thread",
    "Add the bot to a thread.",
    `{ channel_id: threadId }`,
  ),
  B(
    "LeaveThread",
    "leaveThread",
    "Application",
    "Thread",
    "Remove the bot from a thread.",
    `{ channel_id: threadId }`,
  ),
  B(
    "AddThreadMember",
    "addThreadMember",
    "Application",
    "Thread",
    "Add a member to a thread.",
    `{ channel_id: threadId, user_id }`,
  ),
  B(
    "RemoveThreadMember",
    "deleteThreadMember",
    "Application",
    "Thread",
    "Remove a member from a thread.",
    `{ channel_id: threadId, user_id }`,
  ),
  B(
    "GetThreadMember",
    "getThreadMember",
    "Application",
    "Thread",
    "Read one member of a thread.",
    `{ channel_id: threadId, user_id }`,
  ),
  B(
    "ListThreadMembers",
    "listThreadMembers",
    "Application",
    "Thread",
    "List the members of a thread.",
    `{ channel_id: threadId }`,
  ),
  B(
    "EditThread",
    "updateChannel",
    "Application",
    "Thread",
    "Rename, archive, lock or retag a thread (or edit any channel by id).",
    `{ channel_id: threadId, body: { archived: true } }`,
  ),
  B(
    "DeleteThread",
    "deleteChannel",
    "Application",
    "Thread",
    "Delete a thread (or any channel by id).",
    `{ channel_id: threadId }`,
  ),
  // Channel reads and runtime objects
  B("GetChannel", "getChannel", "Channel", "Channel", "Read the bound channel.", `{}`),
  B(
    "CreateInvite",
    "createChannelInvite",
    "Channel",
    "Invite",
    "Create an invite to the bound channel at runtime (e.g. one-use invites).",
    `{ body: { max_uses: 1, max_age: 3600, unique: true } }`,
  ),
  B(
    "ListChannelInvites",
    "listChannelInvites",
    "Channel",
    "Invite",
    "List the invites of the bound channel.",
    `{}`,
  ),
  B(
    "ListChannelWebhooks",
    "listChannelWebhooks",
    "Channel",
    "Webhook",
    "List the webhooks of the bound channel.",
    `{}`,
  ),
  B(
    "GetChannelMemberPermissions",
    "getChannelMemberPermissions",
    "Channel",
    "Channel",
    "Compute a member's permissions in the bound channel.",
    `{ user_id }`,
  ),
  B(
    "GetChannelRolePermissions",
    "getChannelRolePermissions",
    "Channel",
    "Channel",
    "Compute a role's permissions in the bound channel.",
    `{ role_id }`,
  ),
  B(
    "SendSoundboardSound",
    "sendSoundboardSound",
    "Channel",
    "Voice",
    "Play a soundboard sound in the bound voice channel (the bot must be connected).",
    `{ sound_id }`,
  ),
  B(
    "SetVoiceChannelStatus",
    "updateVoiceChannelStatus",
    "Channel",
    "Voice",
    "Set the status text of the bound voice channel.",
    `{ status: "Pairing on #123" }`,
  ),
  // Guild: members
  B(
    "GetMember",
    "getGuildMember",
    "Guild",
    "Member",
    "Read one member of the bound guild.",
    `{ user_id }`,
  ),
  B(
    "ListMembers",
    "listGuildMembers",
    "Guild",
    "Member",
    "List members of the bound guild (needs the Server Members intent).",
    `{ limit: 1000 }`,
  ),
  B(
    "SearchMembers",
    "searchGuildMembers",
    "Guild",
    "Member",
    "Find members of the bound guild whose name starts with a query.",
    `{ query: "sam" }`,
  ),
  B(
    "AddMember",
    "addGuildMember",
    "Guild",
    "Member",
    "Add a user to the bound guild with their OAuth2 access token (`guilds.join` scope).",
    `{ user_id, access_token }`,
  ),
  B(
    "EditMember",
    "updateGuildMember",
    "Guild",
    "Member",
    "Change a member's nickname, roles, voice state or timeout in the bound guild.",
    `{ user_id, nick: "on call" }`,
  ),
  B(
    "KickMember",
    "deleteGuildMember",
    "Guild",
    "Member",
    "Remove a member from the bound guild.",
    `{ user_id }`,
  ),
  B(
    "AddMemberRole",
    "addGuildMemberRole",
    "Guild",
    "Member",
    "Give a member a role in the bound guild.",
    `{ user_id, role_id }`,
  ),
  B(
    "RemoveMemberRole",
    "deleteGuildMemberRole",
    "Guild",
    "Member",
    "Take a role from a member of the bound guild.",
    `{ user_id, role_id }`,
  ),
  B(
    "GetMemberPermissions",
    "getGuildMemberPermissions",
    "Guild",
    "Member",
    "Compute a member's guild-level permissions in the bound guild.",
    `{ user_id }`,
  ),
  B(
    "GetBotMember",
    "getMyGuildMember",
    "Guild",
    "Member",
    "Read the bot's own member object in the bound guild.",
    `{}`,
  ),
  B(
    "EditBotMember",
    "updateMyGuildMember",
    "Guild",
    "Member",
    "Change the bot's nickname, avatar or bio in the bound guild.",
    `{ nick: "Deploy Bot" }`,
  ),
  B("LeaveGuild", "leaveGuild", "Guild", "Guild", "Make the bot leave the bound guild.", `{}`),
  B(
    "PreviewPrune",
    "previewPruneGuild",
    "Guild",
    "Member",
    "Count the members of the bound guild a prune would kick.",
    `{ days: 30 }`,
  ),
  B(
    "PruneMembers",
    "pruneGuild",
    "Guild",
    "Member",
    "Kick members of the bound guild inactive for a number of days.",
    `{ days: 30 }`,
  ),
  B(
    "ListJoinRequests",
    "getGuildJoinRequests",
    "Guild",
    "Member",
    "List membership applications to the bound guild.",
    `{}`,
  ),
  B(
    "ActOnJoinRequest",
    "joinActionGuildRequest",
    "Guild",
    "Member",
    "Approve or reject a membership application to the bound guild.",
    `{ request_id, action: "APPROVED" }`,
  ),
  // Guild: bans and moderation
  B(
    "BanMember",
    "banUserFromGuild",
    "Guild",
    "Moderation",
    "Ban a user from the bound guild.",
    `{ user_id, delete_message_seconds: 3600 }`,
  ),
  B(
    "BulkBanMembers",
    "bulkBanUsersFromGuild",
    "Guild",
    "Moderation",
    "Ban up to 200 users from the bound guild.",
    `{ user_ids: [a, b] }`,
  ),
  B(
    "UnbanMember",
    "unbanUserFromGuild",
    "Guild",
    "Moderation",
    "Lift a ban in the bound guild.",
    `{ user_id }`,
  ),
  B(
    "GetBan",
    "getGuildBan",
    "Guild",
    "Moderation",
    "Read one ban in the bound guild.",
    `{ user_id }`,
  ),
  B("ListBans", "listGuildBans", "Guild", "Moderation", "List bans in the bound guild.", `{}`),
  B(
    "ListAuditLog",
    "listGuildAuditLogEntries",
    "Guild",
    "Moderation",
    "Read the audit log of the bound guild.",
    `{ limit: 50 }`,
  ),
  B(
    "UpdateIncidentActions",
    "updateGuildIncidentActions",
    "Guild",
    "Moderation",
    "Pause invites or DMs in the bound guild for up to 24 hours (raid response).",
    `{ invites_disabled_until: new Date(Date.now() + 3_600_000).toISOString() }`,
  ),
  B(
    "ListAutoModerationRules",
    "listAutoModerationRules",
    "Guild",
    "Moderation",
    "List the AutoMod rules of the bound guild.",
    `{}`,
  ),
  B(
    "SearchMessages",
    "searchGuild",
    "Guild",
    "Message",
    "Search messages across the bound guild.",
    `{ content: "deploy" }`,
  ),
  // Guild: reads
  B(
    "GetGuild",
    "getGuild",
    "Guild",
    "Guild",
    "Read the bound guild, optionally with member counts.",
    `{ with_counts: true }`,
  ),
  B(
    "GetGuildPreview",
    "getGuildPreview",
    "Guild",
    "Guild",
    "Read the public preview of the bound guild.",
    `{}`,
  ),
  B(
    "ListChannels",
    "listGuildChannels",
    "Guild",
    "Channel",
    "List the channels of the bound guild.",
    `{}`,
  ),
  B(
    "ListActiveThreads",
    "getActiveGuildThreads",
    "Guild",
    "Thread",
    "List the active threads of the bound guild.",
    `{}`,
  ),
  B("ListRoles", "listGuildRoles", "Guild", "Role", "List the roles of the bound guild.", `{}`),
  B("GetRole", "getGuildRole", "Guild", "Role", "Read one role of the bound guild.", `{ role_id }`),
  B(
    "GetRoleMemberCounts",
    "guildRoleMemberCounts",
    "Guild",
    "Role",
    "Count members per role in the bound guild.",
    `{}`,
  ),
  B(
    "GetRolePermissions",
    "getGuildRolePermissions",
    "Guild",
    "Role",
    "Read a role's permissions in the bound guild.",
    `{ role_id }`,
  ),
  B(
    "ListGuildInvites",
    "listGuildInvites",
    "Guild",
    "Invite",
    "List every invite of the bound guild.",
    `{}`,
  ),
  B(
    "ListGuildWebhooks",
    "getGuildWebhooks",
    "Guild",
    "Webhook",
    "List every webhook of the bound guild.",
    `{}`,
  ),
  B(
    "ListIntegrations",
    "listGuildIntegrations",
    "Guild",
    "Guild",
    "List the integrations (bots, Twitch, YouTube) of the bound guild.",
    `{}`,
  ),
  B(
    "DeleteIntegration",
    "deleteGuildIntegration",
    "Guild",
    "Guild",
    "Remove an integration from the bound guild.",
    `{ integration_id }`,
  ),
  B(
    "ListGuildVoiceRegions",
    "listGuildVoiceRegions",
    "Guild",
    "Voice",
    "List the voice regions available to the bound guild.",
    `{}`,
  ),
  B(
    "GetVanityUrl",
    "getGuildVanityUrl",
    "Guild",
    "Guild",
    "Read the vanity invite of the bound guild.",
    `{}`,
  ),
  B(
    "GetWidget",
    "getGuildWidget",
    "Guild",
    "Guild",
    "Read the public widget data of the bound guild.",
    `{}`,
  ),
  B(
    "GetWidgetImage",
    "getGuildWidgetPng",
    "Guild",
    "Guild",
    "Render the widget of the bound guild as a PNG.",
    `{ style: "banner2" }`,
  ),
  B(
    "GetWelcomeScreen",
    "getGuildWelcomeScreen",
    "Guild",
    "Guild",
    "Read the welcome screen of the bound guild.",
    `{}`,
  ),
  B(
    "GetOnboarding",
    "getGuildsOnboarding",
    "Guild",
    "Guild",
    "Read the onboarding flow of the bound guild.",
    `{}`,
  ),
  B(
    "GetNewMemberWelcome",
    "getGuildNewMemberWelcome",
    "Guild",
    "Guild",
    "Read the new-member home settings of the bound guild.",
    `{}`,
  ),
  B(
    "ListEmojis",
    "listGuildEmojis",
    "Guild",
    "Expression",
    "List the custom emoji of the bound guild.",
    `{}`,
  ),
  B(
    "ListStickers",
    "listGuildStickers",
    "Guild",
    "Expression",
    "List the custom stickers of the bound guild.",
    `{}`,
  ),
  B(
    "ListSoundboardSounds",
    "listGuildSoundboardSounds",
    "Guild",
    "Expression",
    "List the soundboard sounds of the bound guild.",
    `{}`,
  ),
  B(
    "ListGuildTemplates",
    "listGuildTemplates",
    "Guild",
    "Guild",
    "List the templates of the bound guild.",
    `{}`,
  ),
  // Guild: events and voice
  B(
    "ListScheduledEvents",
    "listGuildScheduledEvents",
    "Guild",
    "Event",
    "List the scheduled events of the bound guild.",
    `{ with_user_count: true }`,
  ),
  B(
    "GetScheduledEvent",
    "getGuildScheduledEvent",
    "Guild",
    "Event",
    "Read one scheduled event of the bound guild.",
    `{ guild_scheduled_event_id }`,
  ),
  B(
    "ListScheduledEventUsers",
    "listGuildScheduledEventUsers",
    "Guild",
    "Event",
    "List users interested in a scheduled event of the bound guild.",
    `{ guild_scheduled_event_id }`,
  ),
  B(
    "CountScheduledEventUsers",
    "countGuildScheduledEventUsers",
    "Guild",
    "Event",
    "Count users interested in a scheduled event of the bound guild.",
    `{ guild_scheduled_event_id }`,
  ),
  B(
    "ListScheduledEventExceptionUsers",
    "listGuildScheduledEventExceptionUsers",
    "Guild",
    "Event",
    "List users interested in one occurrence of a recurring event.",
    `{ guild_scheduled_event_id, guild_scheduled_event_exception_id }`,
  ),
  B(
    "GetVoiceState",
    "getVoiceState",
    "Guild",
    "Voice",
    "Read a member's voice state in the bound guild.",
    `{ user_id }`,
  ),
  B(
    "GetBotVoiceState",
    "getSelfVoiceState",
    "Guild",
    "Voice",
    "Read the bot's voice state in the bound guild.",
    `{}`,
  ),
  B(
    "EditVoiceState",
    "updateVoiceState",
    "Guild",
    "Voice",
    "Suppress or unsuppress a member on a stage in the bound guild.",
    `{ user_id, suppress: false }`,
  ),
  B(
    "EditBotVoiceState",
    "updateSelfVoiceState",
    "Guild",
    "Voice",
    "Request to speak or unsuppress the bot on a stage in the bound guild.",
    `{ suppress: false }`,
  ),
  B(
    "ListGuildCommands",
    "listGuildApplicationCommands",
    "Guild",
    "Command",
    "List an application's commands in the bound guild.",
    `{ application_id }`,
  ),
  B(
    "GetCommandPermissions",
    "getGuildApplicationCommandPermissions",
    "Guild",
    "Command",
    "Read the permission overrides of one command in the bound guild.",
    `{ application_id, command_id }`,
  ),
  B(
    "ListCommandPermissions",
    "listGuildApplicationCommandPermissions",
    "Guild",
    "Command",
    "Read the permission overrides of every command in the bound guild.",
    `{ application_id }`,
  ),
  // Webhooks (webhook token only)
  B(
    "ExecuteWebhook",
    "executeWebhook",
    "Webhook",
    "Webhook",
    "Post a message through the bound webhook, with its own username and avatar if you like.",
    `{ wait: true, body: { content: "Deployed v1.2.3", username: "Deploys" } }`,
  ),
  B(
    "ExecuteSlackWebhook",
    "executeSlackCompatibleWebhook",
    "Webhook",
    "Webhook",
    "Post a Slack-formatted payload through the bound webhook.",
    `{ text: "Deployed v1.2.3" }`,
  ),
  B(
    "ExecuteGitHubWebhook",
    "executeGithubCompatibleWebhook",
    "Webhook",
    "Webhook",
    "Forward a GitHub webhook payload through the bound webhook.",
    `{ sender, ...githubPayload }`,
  ),
  B(
    "GetWebhookMessage",
    "getWebhookMessage",
    "Webhook",
    "Webhook",
    "Read a message the bound webhook posted.",
    `{ message_id }`,
  ),
  B(
    "EditWebhookMessage",
    "updateWebhookMessage",
    "Webhook",
    "Webhook",
    "Edit a message the bound webhook posted.",
    `{ message_id, content: "Edited" }`,
  ),
  B(
    "DeleteWebhookMessage",
    "deleteWebhookMessage",
    "Webhook",
    "Webhook",
    "Delete a message the bound webhook posted.",
    `{ message_id }`,
  ),
  B(
    "GetWebhookWithToken",
    "getWebhookByToken",
    "Webhook",
    "Webhook",
    "Read the bound webhook using only its token.",
    `{}`,
  ),
  // Application-level
  B(
    "GetApplication",
    "getApplication",
    "Application",
    "Application",
    "Read the bound application.",
    `{}`,
  ),
  B("GetUser", "getUser", "Application", "User", "Read a Discord user by id.", `{ user_id }`),
  B("GetBotUser", "getMyUser", "Application", "User", "Read the bot's own user.", `{}`),
  B(
    "ListBotGuilds",
    "listMyGuilds",
    "Application",
    "Guild",
    "List the guilds the bot is in.",
    `{ limit: 200 }`,
  ),
  B(
    "CreateDm",
    "createDm",
    "Application",
    "Message",
    "Open (or get) the DM channel with a user; send to it with its id.",
    `{ recipient_id: userId }`,
  ),
  B(
    "GetInvite",
    "inviteResolve",
    "Application",
    "Invite",
    "Resolve an invite code.",
    `{ code, with_counts: true }`,
  ),
  B("RevokeInvite", "revokeInvite", "Application", "Invite", "Revoke an invite code.", `{ code }`),
  B(
    "GetInviteTargetUsers",
    "getInviteTargetUsers",
    "Application",
    "Invite",
    "List the users an invite is restricted to.",
    `{ code }`,
  ),
  B(
    "SetInviteTargetUsers",
    "updateInviteTargetUsers",
    "Application",
    "Invite",
    "Replace an invite's target users from a CSV file.",
    `{ code, target_users_file }`,
  ),
  B(
    "AddInviteTargetUser",
    "addInviteTargetUser",
    "Application",
    "Invite",
    "Restrict an invite to one more user.",
    `{ code, user_id }`,
  ),
  B(
    "RemoveInviteTargetUser",
    "removeInviteTargetUser",
    "Application",
    "Invite",
    "Remove a user from an invite's targets.",
    `{ code, user_id }`,
  ),
  B(
    "BulkAddInviteTargetUsers",
    "bulkAddInviteTargetUsers",
    "Application",
    "Invite",
    "Restrict an invite to more users at once.",
    `{ code, user_ids }`,
  ),
  B(
    "BulkRemoveInviteTargetUsers",
    "bulkRemoveInviteTargetUsers",
    "Application",
    "Invite",
    "Remove users from an invite's targets at once.",
    `{ code, user_ids }`,
  ),
  B(
    "GetInviteTargetUsersJobStatus",
    "getInviteTargetUsersJobStatus",
    "Application",
    "Invite",
    "Read the status of a bulk invite-target job.",
    `{ code }`,
  ),
  B(
    "GetTemplate",
    "getGuildTemplate",
    "Application",
    "Guild",
    "Read a guild template by code.",
    `{ code }`,
  ),
  B(
    "GetSticker",
    "getSticker",
    "Application",
    "Expression",
    "Read any sticker by id.",
    `{ sticker_id }`,
  ),
  B(
    "GetStickerPack",
    "getStickerPack",
    "Application",
    "Expression",
    "Read a Nitro sticker pack.",
    `{ pack_id }`,
  ),
  B(
    "ListStickerPacks",
    "listStickerPacks",
    "Application",
    "Expression",
    "List Discord's Nitro sticker packs.",
    `{}`,
  ),
  B(
    "ListDefaultSoundboardSounds",
    "getSoundboardDefaultSounds",
    "Application",
    "Expression",
    "List Discord's default soundboard sounds.",
    `{}`,
  ),
  B(
    "ListVoiceRegions",
    "listVoiceRegions",
    "Application",
    "Voice",
    "List Discord's voice regions.",
    `{}`,
  ),
  B("GetGateway", "getGateway", "Application", "Gateway", "Read the Gateway WebSocket URL.", `{}`),
  B(
    "GetBotGateway",
    "getBotGateway",
    "Application",
    "Gateway",
    "Read the Gateway URL with the bot's shard count and session limits.",
    `{}`,
  ),
  B(
    "ListCommands",
    "listApplicationCommands",
    "Application",
    "Command",
    "List the bound application's global commands.",
    `{}`,
  ),
  B(
    "GetCommand",
    "getApplicationCommand",
    "Application",
    "Command",
    "Read one global command of the bound application.",
    `{ command_id }`,
  ),
  B(
    "GetActivityInstance",
    "getApplicationActivityInstance",
    "Application",
    "Activity",
    "Read a running instance of the bound application's Activity.",
    `{ instance_id }`,
  ),
  B(
    "UploadAttachment",
    "uploadApplicationAttachment",
    "Application",
    "Activity",
    "Upload a file for an Activity to share.",
    `{ file: new File([bytes], "shot.png") }`,
  ),
  // Monetization
  B(
    "ListEntitlements",
    "getEntitlements",
    "Application",
    "Monetization",
    "List the bound application's entitlements (purchases, subscriptions).",
    `{ user_id, exclude_ended: true }`,
  ),
  B(
    "GetEntitlement",
    "getEntitlement",
    "Application",
    "Monetization",
    "Read one entitlement of the bound application.",
    `{ entitlement_id }`,
  ),
  B(
    "ConsumeEntitlement",
    "consumeEntitlement",
    "Application",
    "Monetization",
    "Mark a consumable entitlement as used.",
    `{ entitlement_id }`,
  ),
  B(
    "CreateTestEntitlement",
    "createEntitlement",
    "Application",
    "Monetization",
    "Grant a free test entitlement to a user or guild.",
    `{ sku_id, owner_id: userId, owner_type: 2 }`,
  ),
  B(
    "DeleteTestEntitlement",
    "deleteEntitlement",
    "Application",
    "Monetization",
    "Delete a test entitlement.",
    `{ entitlement_id }`,
  ),
  B(
    "ListSkuSubscriptions",
    "getSkuSubscriptions",
    "Application",
    "Monetization",
    "List the subscriptions to one SKU of the bound application.",
    `{ sku_id, user_id }`,
  ),
  B(
    "GetSkuSubscription",
    "getSkuSubscription",
    "Application",
    "Monetization",
    "Read one subscription to a SKU.",
    `{ sku_id, subscription_id }`,
  ),
  // Social SDK lobbies
  B(
    "CreateLobby",
    "createLobby",
    "Application",
    "Lobby",
    "Create a Social SDK lobby.",
    `{ members: [{ id: userId }], idle_timeout_seconds: 300 }`,
  ),
  B("GetLobby", "getLobby", "Application", "Lobby", "Read a lobby.", `{ lobby_id }`),
  B(
    "EditLobby",
    "editLobby",
    "Application",
    "Lobby",
    "Change a lobby's metadata, members or idle timeout.",
    `{ lobby_id, metadata: { map: "dust" } }`,
  ),
  B("DeleteLobby", "deleteLobby", "Application", "Lobby", "Delete a lobby.", `{ lobby_id }`),
  B(
    "AddLobbyMember",
    "addLobbyMember",
    "Application",
    "Lobby",
    "Add or update a member of a lobby.",
    `{ lobby_id, user_id }`,
  ),
  B(
    "RemoveLobbyMember",
    "deleteLobbyMember",
    "Application",
    "Lobby",
    "Remove a member from a lobby.",
    `{ lobby_id, user_id }`,
  ),
  B(
    "BulkUpdateLobbyMembers",
    "bulkUpdateLobbyMembers",
    "Application",
    "Lobby",
    "Add, update and remove lobby members in one call.",
    `{ lobby_id, body: [{ id: userId }] }`,
  ),
  B(
    "LinkLobbyChannel",
    "editLobbyChannelLink",
    "Application",
    "Lobby",
    "Link a lobby to a guild channel, or unlink it.",
    `{ lobby_id, channel_id }`,
  ),
  B(
    "SendLobbyMessage",
    "createLobbyMessage",
    "Application",
    "Lobby",
    "Post a message in a lobby.",
    `{ lobby_id, content: "gg" }`,
  ),
  B(
    "ListLobbyMessages",
    "getLobbyMessages",
    "Application",
    "Lobby",
    "List recent messages in a lobby.",
    `{ lobby_id, limit: 50 }`,
  ),
  B(
    "CreateLobbyGuildInvite",
    "createLinkedLobbyGuildInviteForUser",
    "Application",
    "Lobby",
    "Create a guild invite for a user from a lobby's linked channel.",
    `{ lobby_id, user_id }`,
  ),
  B(
    "ModerateLobbyMessage",
    "updateLobbyMessageExternalModerationMetadata",
    "Application",
    "Lobby",
    "Attach external moderation results to a lobby message.",
    `{ lobby_id, message_id, body }`,
  ),
  B(
    "ModerateUserMessage",
    "updateUserMessageExternalModerationMetadata",
    "Application",
    "Lobby",
    "Attach external moderation results to a game DM.",
    `{ user_id_1, user_id_2, message_id, body }`,
  ),
  B(
    "CreateProvisionalToken",
    "botPartnerSdkToken",
    "Application",
    "Lobby",
    "Mint a Social SDK token for a provisional account keyed by your game's user id.",
    `{ external_user_id: playerId }`,
  ),
  B(
    "UnmergeProvisionalAccount",
    "botPartnerSdkUnmergeProvisionalAccount",
    "Application",
    "Lobby",
    "Split a provisional account from the Discord account it was merged into.",
    `{ external_user_id: playerId }`,
  ),
];

const INJECT: Record<Target, Record<string, string>> = {
  Channel: { channel_id: "ids" },
  Guild: { guild_id: "ids" },
  Application: { application_id: "ids" },
  Webhook: { webhook_id: "ids.id", webhook_token: "ids.token" },
};

const TARGET_VAR: Record<Target, string> = {
  Channel: "channel",
  Guild: "guild",
  Application: "app",
  Webhook: "webhook",
};

const root = path.resolve(import.meta.dirname, "..");
const servicePath = path.resolve(
  root,
  "../../submodules/distilled/packages/discord/src/services/discord.ts",
);
const service = fs.readFileSync(servicePath, "utf8");

const interfaces = new Map<string, string>();
for (const m of service.matchAll(/export interface (\w+) \{\n([\s\S]*?)\n\}/g)) {
  interfaces.set(m[1]!, m[2]!);
}
const ops = new Map<string, { request: string; output: string; error: string }>();
for (const m of service.matchAll(
  /export const (\w+): API\.(?:OperationMethod|PaginatedOperationMethod)<\s*(\w+),\s*([\w<>\[\]| ]+?),\s*(\w+),/g,
)) {
  ops.set(m[1]!, { request: m[2]!, output: m[3]!.trim(), error: m[4]! });
}

const pascal = (s: string) => s[0]!.toUpperCase() + s.slice(1);
const camel = (s: string) => s[0]!.toLowerCase() + s.slice(1);

const HEADER = "// AUTO-GENERATED by scripts/generate-bindings.ts. Do not edit.\n";

const written: string[] = [];
const seen = new Set<string>();
for (const row of BINDINGS) {
  if (seen.has(row.name)) throw new Error(`duplicate binding ${row.name}`);
  seen.add(row.name);
  const op = ops.get(row.op);
  if (op === undefined) throw new Error(`unknown operation ${row.op}`);
  const fields = [...(interfaces.get(op.request) ?? "").matchAll(/^  (\w+)(\??):/gm)].map((f) => ({
    name: f[1]!,
    optional: f[2] === "?",
  }));
  const inject = Object.entries(INJECT[row.target]).filter(([wire]) =>
    fields.some((f) => f.name === wire),
  );
  const injected = inject.map(([wire]) => wire);
  const remainingRequired = fields.filter((f) => !f.optional && !injected.includes(f.name));
  const requestType = `${row.name}Request`;
  const omit =
    injected.length > 0
      ? `Omit<discord.${op.request}, ${injected.map((w) => JSON.stringify(w)).join(" | ")}>`
      : `discord.${op.request}`;
  const requestParam = remainingRequired.length === 0 ? "request?" : "request";
  const v = camel(row.name);
  const t = TARGET_VAR[row.target];
  const example =
    row.example ??
    (remainingRequired.length === 0
      ? "{}"
      : `{ ${remainingRequired.map((f) => f.name).join(", ")} }`);
  const declare =
    row.target === "Channel"
      ? `const ${t} = yield* Discord.Channel("Alerts", { guildId, name: "alerts" });`
      : row.target === "Guild"
        ? `const ${t} = yield* Discord.Guild("Community", { guildId });`
        : row.target === "Webhook"
          ? `const ${t} = yield* Discord.Webhook("Hook", { channelId });`
          : `const ${t} = yield* Discord.Application("App", {});`;
  const authNote =
    row.target === "Webhook"
      ? " Only the webhook's own token is bound into the host, never the bot token."
      : " The host calls with the application's bot token (see `DiscordBindings`).";

  const contract = `${HEADER}import type * as discord from "@distilled.cloud/discord/discord";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ${row.target} } from "./${row.target}.ts";

export type ${requestType} = ${omit};

/**
 * ${row.doc}
 *
 * Wraps \`discord.${row.op}\`${injected.length > 0 ? `, with ${injected.map((w) => `\`${w}\``).join(" and ")} taken from the bound ${row.target.toLowerCase()}` : ""}. Provide \`Discord.${row.name}Http\` on the host.${authNote}
 *
 * ### Using ${row.name}
 * **Example:** Call it from a Worker
 * \`\`\`typescript
 * ${declare}
 * // construction phase
 * const ${v} = yield* Discord.${row.name}(${t});
 * // per request
 * const result = yield* ${v}(${example});
 * \`\`\`
 *
 * @binding
 * @product ${row.product}
 */
export interface ${row.name} extends Binding.Service<
  ${row.name},
  "Discord.${row.name}",
  (
    ${t}: ${row.target},
  ) => Effect.Effect<
    (
      ${requestParam}: ${requestType},
    ) => Effect.Effect<discord.${op.output}, discord.${op.error}, RuntimeContext>
  >
> {}

export const ${row.name} = Binding.Service<${row.name}>("Discord.${row.name}");
`;

  const args = inject.map(([wire, from]) => `${wire}: ${from}`).join(", ");
  const http = `${HEADER}import * as discord from "@distilled.cloud/discord/discord";
import * as Layer from "effect/Layer";
import { ${row.name}, type ${requestType} } from "./${row.name}.ts";
import * as BindingHttp from "./internal/BindingHttp.ts";

/**
 * Bot-API implementation of {@link ${row.name}}. Provide it on any host.
 *
 * @layer
 * @product ${row.product}
 * @provides Discord.${row.name}
 */
export const ${row.name}Http = Layer.effect(
  ${row.name},
  BindingHttp.${camel(row.target)}("${row.name}", (${inject.length > 0 ? "ids" : "_ids"}, request: ${requestType}) =>
    discord.${row.op}({ ...request${args ? `, ${args}` : ""} }),
  ),
);
`;
  fs.writeFileSync(path.join(root, "src", `${row.name}.ts`), contract);
  fs.writeFileSync(path.join(root, "src", `${row.name}Http.ts`), http);
  written.push(row.name, `${row.name}Http`);
}

// index.ts: every public module.
const internalOnly = new Set(["index", "Contributions", "globals.d"]);
const modules = fs
  .readdirSync(path.join(root, "src"))
  .filter((f) => f.endsWith(".ts"))
  .map((f) => f.replace(/\.ts$/, ""))
  .filter((m) => !internalOnly.has(m))
  .sort();
fs.writeFileSync(
  path.join(root, "src", "index.ts"),
  modules.map((m) => `export * from "./${m}.ts";\n`).join(""),
);
fs.writeFileSync(
  path.join(root, "scripts", "bindings.json"),
  JSON.stringify(
    BINDINGS.map(({ name, op, target, product }) => ({ name, op, target, product })),
    null,
    2,
  ) + "\n",
);
console.log(`wrote ${written.length} files for ${BINDINGS.length} bindings`);
void pascal;
