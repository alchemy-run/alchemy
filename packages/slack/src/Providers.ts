import { Retry as SlackRetry } from "@distilled.cloud/slack/Retry";
import { CredentialsStoreLive } from "alchemy/Auth/Credentials";
import { ProfileStoreLive } from "alchemy/Auth/Profile";
import * as DeployRetry from "alchemy/DeployRetry";
import * as Provider from "alchemy/Provider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { App, AppProvider } from "./App.ts";
import { SlackAuth } from "./AuthProvider.ts";
import { Bookmark, BookmarkProvider } from "./Bookmark.ts";
import { BotToken, BotTokenProvider } from "./BotToken.ts";
import { Canvas, CanvasProvider, ChannelCanvas, ChannelCanvasProvider } from "./Canvas.ts";
import { Channel, ChannelProvider } from "./Channel.ts";
import { ChannelMember, ChannelMemberProvider } from "./ChannelMember.ts";
import * as Credentials from "./Credentials.ts";
import { UserGroup, UserGroupProvider } from "./UserGroup.ts";

export { Credentials } from "@distilled.cloud/slack/Credentials";

export class Providers extends Provider.ProviderCollection<Providers>()("Slack") {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

/**
 * Slack providers and credentials. Registers the Slack AuthProvider so
 * `alchemy profile edit --add Slack` can configure the bot token and the app
 * configuration token.
 */
export const providers = () =>
  Layer.effect(
    Providers,
    Provider.collection([
      App,
      Bookmark,
      BotToken,
      Canvas,
      Channel,
      ChannelCanvas,
      ChannelMember,
      UserGroup,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AppProvider(),
        BookmarkProvider(),
        BotTokenProvider(),
        CanvasProvider(),
        ChannelProvider(),
        ChannelCanvasProvider(),
        ChannelMemberProvider(),
        UserGroupProvider(),
      ),
    ),
    Layer.provideMerge(Layer.succeed(SlackRetry, DeployRetry.policy)),
    Layer.provideMerge(Credentials.fromAuthProvider()),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(SlackAuth),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
