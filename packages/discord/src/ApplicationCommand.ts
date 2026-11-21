import * as discord from "@distilled.cloud/discord/discord";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { ChannelType } from "./Channel.ts";
import { applicationId, listBotGuilds } from "./internal/Discord.ts";
import type { Providers } from "./Providers.ts";

/** Kinds of command option. */
export type CommandOptionType =
  | "subcommand"
  | "subcommandGroup"
  | "string"
  | "integer"
  | "boolean"
  | "user"
  | "channel"
  | "role"
  | "mentionable"
  | "number"
  | "attachment";

/** One option (argument, subcommand or subcommand group) of a slash command. */
export interface CommandOption {
  /** Option kind. */
  type: CommandOptionType;
  /** Name, 1-32 lowercase characters. */
  name: string;
  /** Description, 1-100 characters. */
  description: string;
  /** Localized names, keyed by locale. */
  nameLocalizations?: Record<string, string>;
  /** Localized descriptions, keyed by locale. */
  descriptionLocalizations?: Record<string, string>;
  /** The user must fill it in. @default false */
  required?: boolean;
  /** Fixed values to choose from (string, integer and number options; up to 25). */
  choices?: Array<{ name: string; value: string | number }>;
  /** Sub-options, for `subcommand` and `subcommandGroup`. */
  options?: CommandOption[];
  /** Channel kinds a `channel` option accepts. */
  channelTypes?: ChannelType[];
  /** Smallest accepted `integer`/`number`. */
  minValue?: number;
  /** Largest accepted `integer`/`number`. */
  maxValue?: number;
  /** Shortest accepted `string` (0-6000). */
  minLength?: number;
  /** Longest accepted `string` (1-6000). */
  maxLength?: number;
  /** Suggestions come from autocomplete interactions instead of `choices`. */
  autocomplete?: boolean;
}

export interface ApplicationCommandProps {
  /**
   * Command name: 1-32 lowercase characters for slash commands, any case
   * for user and message commands. A command is upserted by name, so
   * renaming creates the new command and deletes the old one.
   */
  name: string;
  /** Description, 1-100 characters (slash commands only). */
  description?: string;
  /**
   * `chatInput` is a slash command; `user` and `message` appear in the
   * context menu of a user or message; `primaryEntryPoint` launches an
   * Activity. Changing it replaces the command.
   * @default "chatInput"
   */
  type?: "chatInput" | "user" | "message" | "primaryEntryPoint";
  /**
   * Register the command in one guild (updates instantly) instead of
   * globally. Changing it replaces the command.
   */
  guildId?: string;
  /** Arguments, subcommands and groups (slash commands; up to 25). */
  options?: CommandOption[];
  /**
   * Permission bit set a member needs to see the command, as a decimal
   * string. `"0"` hides it from everyone but admins.
   */
  defaultMemberPermissions?: string;
  /** Where the command can be used. @default all contexts the integration types allow */
  contexts?: Array<"guild" | "botDm" | "privateChannel">;
  /** Install kinds the command is available for (global commands). */
  integrationTypes?: Array<"guildInstall" | "userInstall">;
  /** Only usable in age-restricted channels. @default false */
  nsfw?: boolean;
  /** Localized names, keyed by locale. */
  nameLocalizations?: Record<string, string>;
  /** Localized descriptions, keyed by locale. */
  descriptionLocalizations?: Record<string, string>;
}

export interface ApplicationCommandAttributes {
  /** Command id (a snowflake). */
  commandId: string;
  /** Owning application id. */
  applicationId: string;
  /** Guild the command is registered in, or `undefined` for global. */
  guildId: string | undefined;
  /** Command name. */
  name: string;
  /** Command kind. */
  type: NonNullable<ApplicationCommandProps["type"]>;
  /** Version id; changes on every update. */
  version: string;
  /** `</name:id>`, the clickable mention of a slash command. */
  mention: string;
}

/**
 * A slash command, or a user or message context-menu command, registered
 * for the application globally or in one guild.
 *
 * Global commands are available in every guild and DM the app is installed
 * in; guild commands only in their guild, and they update instantly (use
 * them while developing). Interactions from the command arrive at the
 * application's interactions endpoint (see `Discord.consumeInteractions`).
 *
 * ### Registering Commands
 * **Example:** Slash command with options
 * ```typescript
 * yield* Discord.ApplicationCommand("Roll", {
 *   name: "roll",
 *   description: "Roll some dice",
 *   options: [
 *     { type: "integer", name: "sides", description: "Sides per die", minValue: 2, maxValue: 100 },
 *     { type: "integer", name: "count", description: "How many dice" },
 *   ],
 * });
 * ```
 *
 * **Example:** Guild command while developing
 * ```typescript
 * yield* Discord.ApplicationCommand("Ping", {
 *   guildId,
 *   name: "ping",
 *   description: "Replies with pong",
 * });
 * ```
 *
 * **Example:** Subcommands
 * ```typescript
 * yield* Discord.ApplicationCommand("Config", {
 *   name: "config",
 *   description: "Bot settings",
 *   defaultMemberPermissions: Discord.Permissions.ManageGuild,
 *   options: [
 *     {
 *       type: "subcommand",
 *       name: "set",
 *       description: "Set a value",
 *       options: [
 *         { type: "string", name: "key", description: "Setting", required: true,
 *           choices: [{ name: "Prefix", value: "prefix" }, { name: "Language", value: "lang" }] },
 *         { type: "string", name: "value", description: "New value", required: true },
 *       ],
 *     },
 *     { type: "subcommand", name: "show", description: "Show the settings" },
 *   ],
 * });
 * ```
 *
 * **Example:** Message context-menu command
 * ```typescript
 * yield* Discord.ApplicationCommand("Translate", { name: "Translate", type: "message" });
 * ```
 *
 * @resource
 * @product Command
 */
export interface ApplicationCommand extends Resource<
  "Discord.ApplicationCommand",
  ApplicationCommandProps,
  ApplicationCommandAttributes,
  never,
  Providers
> {}

export const ApplicationCommand = Resource<ApplicationCommand>("Discord.ApplicationCommand");

const COMMAND_TYPES = { chatInput: 1, user: 2, message: 3, primaryEntryPoint: 4 } as const;
const OPTION_TYPES: Record<CommandOptionType, number> = {
  subcommand: 1,
  subcommandGroup: 2,
  string: 3,
  integer: 4,
  boolean: 5,
  user: 6,
  channel: 7,
  role: 8,
  mentionable: 9,
  number: 10,
  attachment: 11,
};
const CHANNEL_TYPES: Record<ChannelType, number> = {
  text: 0,
  voice: 2,
  category: 4,
  announcement: 5,
  stage: 13,
  forum: 15,
  media: 16,
};
const CONTEXTS = { guild: 0, botDm: 1, privateChannel: 2 } as const;
const INTEGRATION_TYPES = { guildInstall: 0, userInstall: 1 } as const;

const commandTypeName = (type: number) =>
  (Object.entries(COMMAND_TYPES).find(([, v]) => v === type)?.[0] ??
    "chatInput") as ApplicationCommandAttributes["type"];

const optionBody = (o: CommandOption): Record<string, unknown> => ({
  type: OPTION_TYPES[o.type],
  name: o.name,
  description: o.description,
  name_localizations: o.nameLocalizations,
  description_localizations: o.descriptionLocalizations,
  required: o.required,
  choices: o.choices,
  options: o.options?.map(optionBody),
  channel_types: o.channelTypes?.map((t) => CHANNEL_TYPES[t]),
  min_value: o.minValue,
  max_value: o.maxValue,
  min_length: o.minLength,
  max_length: o.maxLength,
  autocomplete: o.autocomplete,
});

const commandBody = (news: ApplicationCommandProps) => ({
  name: news.name,
  description: news.description,
  type: COMMAND_TYPES[news.type ?? "chatInput"],
  options: news.options?.map(optionBody) as discord.CreateApplicationCommandRequest["options"],
  default_member_permissions:
    news.defaultMemberPermissions === undefined ? undefined : Number(news.defaultMemberPermissions),
  contexts: news.contexts?.map((c) => CONTEXTS[c]),
  integration_types: news.integrationTypes?.map((t) => INTEGRATION_TYPES[t]),
  name_localizations: news.nameLocalizations,
  description_localizations: news.descriptionLocalizations,
});

const toAttributes = (c: discord.ApplicationCommandResponse): ApplicationCommandAttributes => ({
  commandId: c.id,
  applicationId: c.application_id,
  guildId: c.guild_id ?? undefined,
  name: c.name,
  type: commandTypeName(Number(c.type)),
  version: c.version,
  mention: `</${c.name}:${c.id}>`,
});

const getCommand = (appId: string, guildId: string | undefined, commandId: string) =>
  (guildId === undefined
    ? discord.getApplicationCommand({ application_id: appId, command_id: commandId })
    : discord.getGuildApplicationCommand({
        application_id: appId,
        guild_id: guildId,
        command_id: commandId,
      })
  ).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const deleteCommand = (appId: string, guildId: string | undefined, commandId: string) =>
  (guildId === undefined
    ? discord.deleteApplicationCommand({ application_id: appId, command_id: commandId })
    : discord.deleteGuildApplicationCommand({
        application_id: appId,
        guild_id: guildId,
        command_id: commandId,
      })
  ).pipe(Effect.catchTag("NotFound", () => Effect.void));

const listCommands = (appId: string, guildId: string | undefined) =>
  (guildId === undefined
    ? discord.listApplicationCommands({ application_id: appId })
    : discord.listGuildApplicationCommands({ application_id: appId, guild_id: guildId })
  ).pipe(Effect.map((commands) => commands ?? []));

export const ApplicationCommandProvider = () =>
  Provider.succeed(ApplicationCommand, {
    stables: ["applicationId", "guildId", "type"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news) || olds === undefined) return;
      if (
        news.guildId !== olds.guildId ||
        (news.type ?? "chatInput") !== (olds.type ?? "chatInput")
      ) {
        return { action: "replace" } as const;
      }
    }),

    read: Effect.fn(function* ({ olds, output }) {
      if (output !== undefined) {
        const command = yield* getCommand(output.applicationId, output.guildId, output.commandId);
        return command ? toAttributes(command) : undefined;
      }
      if (olds === undefined) return undefined;
      // Commands belong to the application, so one with this name and type is ours.
      const appId = yield* applicationId();
      const match = (yield* listCommands(appId, olds.guildId)).find(
        (c) => c.name === olds.name && Number(c.type) === COMMAND_TYPES[olds.type ?? "chatInput"],
      );
      return match ? toAttributes(match) : undefined;
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const appId = output?.applicationId ?? (yield* applicationId());
      const body = commandBody(news);
      // Ensure + sync in one call: Discord upserts a command by name and type.
      const command =
        news.guildId === undefined
          ? yield* discord.createApplicationCommand({ application_id: appId, ...body })
          : yield* discord.createGuildApplicationCommand({
              application_id: appId,
              guild_id: news.guildId,
              ...body,
            });
      // A rename upserted a new command; drop the old one.
      if (output !== undefined && output.commandId !== command.id) {
        yield* deleteCommand(appId, output.guildId, output.commandId);
      }
      return toAttributes(command);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteCommand(output.applicationId, output.guildId, output.commandId);
    }),

    list: Effect.fn(function* () {
      const appId = yield* applicationId();
      const global = yield* listCommands(appId, undefined);
      const guilds = yield* listBotGuilds();
      const perGuild = yield* Effect.forEach(
        guilds,
        (guild) =>
          listCommands(appId, guild.id).pipe(Effect.catchTag("NotFound", () => Effect.succeed([]))),
        { concurrency: 4 },
      );
      return [...global, ...perGuild.flat()].map(toAttributes);
    }),
  });
