/**
 * Discord permission bits as decimal strings, the form Discord's API uses for
 * permission bit sets (https://discord.com/developers/docs/topics/permissions#permissions-bitwise-permission-flags).
 * Combine them with {@link combinePermissions}.
 *
 * ```typescript
 * yield* Discord.Role("Moderator", {
 *   guildId,
 *   permissions: Discord.combinePermissions(
 *     Discord.Permissions.KickMembers,
 *     Discord.Permissions.ManageMessages,
 *   ),
 * });
 * ```
 */
const bit = (n: number) => (1n << BigInt(n)).toString();

export const Permissions = {
  CreateInstantInvite: bit(0),
  KickMembers: bit(1),
  BanMembers: bit(2),
  Administrator: bit(3),
  ManageChannels: bit(4),
  ManageGuild: bit(5),
  AddReactions: bit(6),
  ViewAuditLog: bit(7),
  PrioritySpeaker: bit(8),
  Stream: bit(9),
  ViewChannel: bit(10),
  SendMessages: bit(11),
  SendTtsMessages: bit(12),
  ManageMessages: bit(13),
  EmbedLinks: bit(14),
  AttachFiles: bit(15),
  ReadMessageHistory: bit(16),
  MentionEveryone: bit(17),
  UseExternalEmojis: bit(18),
  ViewGuildInsights: bit(19),
  Connect: bit(20),
  Speak: bit(21),
  MuteMembers: bit(22),
  DeafenMembers: bit(23),
  MoveMembers: bit(24),
  UseVad: bit(25),
  ChangeNickname: bit(26),
  ManageNicknames: bit(27),
  ManageRoles: bit(28),
  ManageWebhooks: bit(29),
  ManageGuildExpressions: bit(30),
  UseApplicationCommands: bit(31),
  RequestToSpeak: bit(32),
  ManageEvents: bit(33),
  ManageThreads: bit(34),
  CreatePublicThreads: bit(35),
  CreatePrivateThreads: bit(36),
  UseExternalStickers: bit(37),
  SendMessagesInThreads: bit(38),
  UseEmbeddedActivities: bit(39),
  ModerateMembers: bit(40),
  ViewCreatorMonetizationAnalytics: bit(41),
  UseSoundboard: bit(42),
  CreateGuildExpressions: bit(43),
  CreateEvents: bit(44),
  UseExternalSounds: bit(45),
  SendVoiceMessages: bit(46),
  SendPolls: bit(49),
  UseExternalApps: bit(50),
} as const;

export type Permission = (typeof Permissions)[keyof typeof Permissions];

/** OR permission bit sets (decimal strings or numbers) into one decimal string. */
export const combinePermissions = (...permissions: ReadonlyArray<string | number | bigint>) =>
  permissions.reduce<bigint>((all, p) => all | BigInt(p), 0n).toString();
