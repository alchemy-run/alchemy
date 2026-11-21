import { Retry as DiscordRetry } from "@distilled.cloud/discord/Retry";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as DeployRetry from "alchemy/DeployRetry";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { ApplicationEmoji, ApplicationEmojiProvider } from "./ApplicationEmoji.ts";
import { DiscordAuth } from "./AuthProvider.ts";
import { AutoModerationRule, AutoModerationRuleProvider } from "./AutoModerationRule.ts";
import { Channel, ChannelProvider } from "./Channel.ts";
import { ChannelFollower, ChannelFollowerProvider } from "./ChannelFollower.ts";
import * as Credentials from "./Credentials.ts";
import { Emoji, EmojiProvider } from "./Emoji.ts";
import { GuildTemplate, GuildTemplateProvider } from "./GuildTemplate.ts";
import { Invite, InviteProvider } from "./Invite.ts";
import { MemberRole, MemberRoleProvider } from "./MemberRole.ts";
import { PermissionOverwrite, PermissionOverwriteProvider } from "./PermissionOverwrite.ts";
import { Role, RoleProvider } from "./Role.ts";
import { ScheduledEvent, ScheduledEventProvider } from "./ScheduledEvent.ts";
import {
  ScheduledEventException,
  ScheduledEventExceptionProvider,
} from "./ScheduledEventException.ts";
import { SoundboardSound, SoundboardSoundProvider } from "./SoundboardSound.ts";
import { StageInstance, StageInstanceProvider } from "./StageInstance.ts";
import { Sticker, StickerProvider } from "./Sticker.ts";
import { Webhook, WebhookProvider } from "./Webhook.ts";

export { Credentials } from "@distilled.cloud/discord/Credentials";

export class Providers extends Provider.ProviderCollection<Providers>()("Discord") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

let cached: ReturnType<typeof make> | undefined;

const make = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      ApplicationEmoji,
      AutoModerationRule,
      Channel,
      ChannelFollower,
      Emoji,
      GuildTemplate,
      Invite,
      MemberRole,
      PermissionOverwrite,
      Role,
      ScheduledEvent,
      ScheduledEventException,
      SoundboardSound,
      StageInstance,
      Sticker,
      Webhook,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ApplicationEmojiProvider(),
        AutoModerationRuleProvider(),
        ChannelProvider(),
        ChannelFollowerProvider(),
        EmojiProvider(),
        GuildTemplateProvider(),
        InviteProvider(),
        MemberRoleProvider(),
        PermissionOverwriteProvider(),
        RoleProvider(),
        ScheduledEventProvider(),
        ScheduledEventExceptionProvider(),
        SoundboardSoundProvider(),
        StageInstanceProvider(),
        StickerProvider(),
        WebhookProvider(),
      ),
    ),
    Layer.provideMerge(Layer.succeed(DiscordRetry, DeployRetry.policy)),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(DiscordAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );

/**
 * Discord providers and credentials. Wires up every Discord resource and
 * registers the Discord AuthProvider so `alchemy profile edit --add Discord`
 * can configure the bot token.
 */
export const providers = () => (cached ??= make());
