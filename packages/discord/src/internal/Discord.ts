/**
 * Helpers shared by every Discord resource provider. Not exported from the
 * package barrel.
 */
import * as discord from "@distilled.cloud/discord/discord";
import { Unowned } from "alchemy/AdoptPolicy";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";

/**
 * The application the deploy's bot token belongs to. Every application-level
 * operation (`/applications/{application_id}/...`) takes its id.
 */
export const currentApplication = Effect.fn("Discord.currentApplication")(function* () {
  return yield* discord.getMyApplication({});
});

/** The id of the application the bot token belongs to. */
export const applicationId = Effect.fn("Discord.applicationId")(function* () {
  return (yield* currentApplication()).id;
});

/** The bot user's id. Ownership of guild objects is "created by this bot". */
export const botUserId = Effect.fn("Discord.botUserId")(function* () {
  return (yield* discord.getMyUser({})).id;
});

/**
 * Guilds the bot is a member of. `listMyGuilds` pages by `after` (a guild
 * id) at up to 200 per page.
 */
export const listBotGuilds = Effect.fn("Discord.listBotGuilds")(function* () {
  const guilds: Array<{ id: string; name: string }> = [];
  let after: string | undefined;
  for (;;) {
    const page = (yield* discord.listMyGuilds({ limit: 200, after })) ?? [];
    guilds.push(...page.map((guild) => ({ id: guild.id, name: guild.name })));
    if (page.length < 200) return guilds;
    after = page[page.length - 1]!.id;
  }
});

/**
 * Discord's audit log action types for the objects alchemy creates in a
 * guild (https://discord.com/developers/docs/resources/audit-log#audit-log-entry-object-audit-log-events).
 */
export const AuditLogAction = {
  ChannelCreate: 10,
  ChannelOverwriteCreate: 13,
  RoleCreate: 30,
  InviteCreate: 40,
  WebhookCreate: 50,
  EmojiCreate: 60,
  StageInstanceCreate: 83,
  StickerCreate: 90,
  ScheduledEventCreate: 100,
  SoundboardSoundCreate: 130,
  AutoModerationRuleCreate: 140,
} as const;

/**
 * Ids of the objects of one kind the bot created in a guild, read from the
 * guild's audit log (`VIEW_AUDIT_LOG`). Discord has no tags or labels on
 * guild objects, so "the bot created it" is the ownership marker `list` and
 * cold `read`s use. The audit log keeps 45 days, so older objects are not
 * listed.
 */
export const createdByBot = Effect.fn("Discord.createdByBot")(function* (
  guildId: string,
  actionType: number,
) {
  const userId = yield* botUserId();
  const ids = new Set<string>();
  let before: string | undefined;
  for (let page = 0; page < 50; page++) {
    const log = yield* discord.listGuildAuditLogEntries({
      guild_id: guildId,
      user_id: userId,
      action_type: actionType,
      limit: 100,
      before,
    });
    for (const entry of log.audit_log_entries) {
      if (entry.target_id) ids.add(entry.target_id);
    }
    if (log.audit_log_entries.length < 100) break;
    before = log.audit_log_entries[log.audit_log_entries.length - 1]!.id;
  }
  return ids;
});

/**
 * For `list`: every guild the bot is in, with the ids of the objects of one
 * kind it created there. Guilds where the bot can't read the audit log are
 * skipped (nothing there can be proven ours).
 */
export const ownedPerGuild = Effect.fn("Discord.ownedPerGuild")(function* (actionType: number) {
  const guilds = yield* listBotGuilds();
  return yield* Effect.forEach(
    guilds,
    (guild) =>
      createdByBot(guild.id, actionType).pipe(
        Effect.catchTag("MissingPermissions", () => Effect.succeed(new Set<string>())),
        Effect.map((ids) => ({ guildId: guild.id, ids })),
      ),
    { concurrency: 4 },
  );
});

/**
 * Whether the bot created object `id` in `guildId` (cold `read`s adopt only
 * what the bot created; anything else is {@link Unowned}).
 */
export const isCreatedByBot = Effect.fn("Discord.isCreatedByBot")(function* (
  guildId: string,
  actionType: number,
  id: string,
) {
  const ids = yield* createdByBot(guildId, actionType).pipe(
    Effect.catchTag("MissingPermissions", () => Effect.succeed(new Set<string>())),
  );
  return ids.has(id);
});

/**
 * `attrs` when `owned`, else {@link Unowned}`(attrs)`, so the engine refuses
 * to take over a foreign object without `--adopt`.
 */
export const ownership = <T extends object>(attrs: T, owned: boolean): T =>
  owned ? attrs : Unowned(attrs);

/**
 * Discord refuses names that contain "discord" or "clyde" for several object
 * kinds (webhooks, bot usernames). Generated names never contain them.
 */
const scrubReserved = (name: string) => name.replace(/discord/gi, "dc").replace(/clyde/gi, "cl");

/**
 * A generated physical name, scrubbed of Discord's reserved words and limited
 * to `charset` (other characters become the delimiter).
 */
export const physicalName = Effect.fn("Discord.physicalName")(function* (
  id: string,
  options: {
    /** The engine's instance id (from `read`/`reconcile` input). */
    readonly instanceId?: string;
    readonly maxLength: number;
    readonly delimiter?: string;
    readonly lowercase?: boolean;
    readonly charset?: RegExp;
  },
) {
  const delimiter = options.delimiter ?? "-";
  const name = scrubReserved(
    yield* createPhysicalName({
      id,
      instanceId: options.instanceId,
      maxLength: options.maxLength,
      delimiter,
      lowercase: options.lowercase ?? false,
    }),
  );
  return options.charset === undefined ? name : name.replace(options.charset, delimiter);
});

/** `0x5865f2`-style integer colors from `#5865F2` or `5865F2` strings. */
export const colorToInt = (color: string | number | undefined | null) =>
  color === undefined || color === null
    ? undefined
    : typeof color === "number"
      ? color
      : Number.parseInt(color.replace(/^#/, ""), 16);

/** Permission bit sets are decimal strings on the wire; accept bigint too. */
export const permissionsToString = (value: string | bigint | number | undefined) =>
  value === undefined ? undefined : value.toString();

/** Shallow structural equality via canonical JSON (sorted keys). */
export const sameJson = (a: unknown, b: unknown) => canonical(a) === canonical(b);

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v,
  );

/** Emoji names: letters, digits and underscores, 2-32 characters. */
export const emojiName = (id: string, instanceId: string, props: { name?: string }) =>
  props.name !== undefined
    ? Effect.succeed(props.name)
    : physicalName(id, {
        instanceId,
        maxLength: 32,
        delimiter: "_",
        charset: /[^A-Za-z0-9_]/g,
      });
