import * as Layer from "effect/Layer";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileLive } from "../Auth/Profile.ts";
import * as ProviderLayer from "../Dev/ProviderLayer.ts";
import * as Provider from "../Provider.ts";
import { type GitHubAuthOptions, makeGitHubAuth } from "./AuthProvider.ts";
import { Comment, CommentProvider } from "./Comment.ts";
import * as Credentials from "./Credentials.ts";
import { Environment, EnvironmentProvider } from "./Environment.ts";
import { LocalWebhookProvider } from "./LocalWebhookProvider.ts";
import {
  PersonalAccessToken,
  PersonalAccessTokenProvider,
} from "./PersonalAccessToken.ts";
import { Repository, RepositoryProvider } from "./Repository.ts";
import { Secret, SecretProvider } from "./Secret.ts";
import { Variable, VariableProvider } from "./Variable.ts";
import { Webhook, WebhookProvider } from "./Webhook.ts";

export { GitHubCredentials } from "./Credentials.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "GitHub",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

export interface ProvidersOptions extends GitHubAuthOptions {}

/**
 * GitHub providers (Comment, Environment, PersonalAccessToken, Repository,
 * Secret, Variable, Webhook) plus the GitHub AuthProvider that `alchemy login`
 * discovers.
 *
 * Pass `baseUrl` to pin every GitHub resource to a GitHub Enterprise host
 * without relying on the auth provider's configuration:
 *
 * ```typescript
 * providers: GitHub.providers({ baseUrl: "github.example.com" })
 * ```
 *
 * The auth provider receives the same value, so `alchemy login` skips the
 * host prompt and authenticates against the pinned host (`gh auth token
 * --hostname`, enterprise token env vars). Individual resources can still
 * override the host per-resource via their own `baseUrl` prop.
 */
export const providers = (options?: ProvidersOptions) =>
  Layer.effect(
    Providers,
    Provider.collection([
      Comment,
      Environment,
      PersonalAccessToken,
      Repository,
      Secret,
      Variable,
      Webhook,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        CommentProvider(),
        EnvironmentProvider(),
        PersonalAccessTokenProvider(),
        RepositoryProvider(),
        SecretProvider(),
        VariableProvider(),
        // GitHub refuses localhost delivery URLs, so dev runs emulate
        // the webhook by polling in the sidecar (LocalWebhookProvider)
        ProviderLayer.dual(Webhook, {
          live: WebhookProvider,
          local: LocalWebhookProvider,
        }),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider(options)),
    Layer.provideMerge(makeGitHubAuth(options)),
    Layer.provideMerge(ProfileLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
