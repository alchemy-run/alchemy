import { Retry as DiscordRetry } from "@distilled.cloud/discord/Retry";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as DeployRetry from "alchemy/DeployRetry";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { Application, ApplicationProvider } from "./Application.ts";
import { ApplicationCommand, ApplicationCommandProvider } from "./ApplicationCommand.ts";
import { ApplicationEmoji, ApplicationEmojiProvider } from "./ApplicationEmoji.ts";
import { DiscordAuth } from "./AuthProvider.ts";
import { AutoModerationRule, AutoModerationRuleProvider } from "./AutoModerationRule.ts";
import { Bot, BotProvider } from "./Bot.ts";
import { Channel, ChannelProvider } from "./Channel.ts";
import { ChannelFollower, ChannelFollowerProvider } from "./ChannelFollower.ts";
import * as Credentials from "./Credentials.ts";
import { Emoji, EmojiProvider } from "./Emoji.ts";
import { EventWebhook, EventWebhookProvider } from "./EventWebhook.ts";
import { Guild, GuildProvider } from "./Guild.ts";
import { GuildSettings, GuildSettingsProvider } from "./GuildSettings.ts";
import { GuildTemplate, GuildTemplateProvider } from "./GuildTemplate.ts";
import { InteractionsEndpoint, InteractionsEndpointProvider } from "./InteractionsEndpoint.ts";
import { DeployerToken, DeployerTokenProvider } from "./internal/DeployerToken.ts";
import { Invite, InviteProvider } from "./Invite.ts";
import { MemberRole, MemberRoleProvider } from "./MemberRole.ts";
import { Onboarding, OnboardingProvider } from "./Onboarding.ts";
import { PermissionOverwrite, PermissionOverwriteProvider } from "./PermissionOverwrite.ts";
import { Role, RoleProvider } from "./Role.ts";
import {
  RoleConnectionMetadata,
  RoleConnectionMetadataProvider,
} from "./RoleConnectionMetadata.ts";
import { ScheduledEvent, ScheduledEventProvider } from "./ScheduledEvent.ts";
import {
  ScheduledEventException,
  ScheduledEventExceptionProvider,
} from "./ScheduledEventException.ts";
import { SoundboardSound, SoundboardSoundProvider } from "./SoundboardSound.ts";
import { StageInstance, StageInstanceProvider } from "./StageInstance.ts";
import { Sticker, StickerProvider } from "./Sticker.ts";
import { Webhook, WebhookProvider } from "./Webhook.ts";
import { WelcomeScreen, WelcomeScreenProvider } from "./WelcomeScreen.ts";
import { Widget, WidgetProvider } from "./Widget.ts";

export { Credentials } from "@distilled.cloud/discord/Credentials";

export class Providers extends Provider.ProviderCollection<Providers>()("Discord") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

let cached: ReturnType<typeof make> | undefined;

const make = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      Application,
      ApplicationCommand,
      ApplicationEmoji,
      AutoModerationRule,
      Bot,
      Channel,
      ChannelFollower,
      Emoji,
      EventWebhook,
      GuildSettings,
      GuildTemplate,
      InteractionsEndpoint,
      Invite,
      MemberRole,
      Onboarding,
      PermissionOverwrite,
      Role,
      RoleConnectionMetadata,
      ScheduledEvent,
      ScheduledEventException,
      SoundboardSound,
      StageInstance,
      Sticker,
      Webhook,
      WelcomeScreen,
      Widget,
      Guild,
      DeployerToken,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        ApplicationProvider(),
        ApplicationCommandProvider(),
        ApplicationEmojiProvider(),
        AutoModerationRuleProvider(),
        BotProvider(),
        ChannelProvider(),
        ChannelFollowerProvider(),
        EmojiProvider(),
        EventWebhookProvider(),
        GuildSettingsProvider(),
        GuildTemplateProvider(),
        InteractionsEndpointProvider(),
        InviteProvider(),
        MemberRoleProvider(),
        OnboardingProvider(),
        PermissionOverwriteProvider(),
        RoleProvider(),
        RoleConnectionMetadataProvider(),
        ScheduledEventProvider(),
        ScheduledEventExceptionProvider(),
        SoundboardSoundProvider(),
        StageInstanceProvider(),
        StickerProvider(),
        WebhookProvider(),
        WelcomeScreenProvider(),
        WidgetProvider(),
        GuildProvider(),
        DeployerTokenProvider(),
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
