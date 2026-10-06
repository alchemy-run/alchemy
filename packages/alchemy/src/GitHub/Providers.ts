import type * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as Path from "effect/Path";
import { CredentialsStoreLive } from "../Auth/Credentials.ts";
import { ProfileStoreLive } from "../Auth/Profile.ts";
import * as Provider from "../Provider.ts";
import { App, AppProvider } from "./App.ts";
import { AppInstallation, AppInstallationProvider } from "./AppInstallation.ts";
import { type GitHubAuthOptions, makeGitHubAuth } from "./AuthProvider.ts";
import {
  BranchProtection,
  BranchProtectionProvider,
} from "./BranchProtection.ts";
import * as Browser from "./Browser.ts";
import { Collaborator, CollaboratorProvider } from "./Collaborator.ts";
import { Comment, CommentProvider } from "./Comment.ts";
import * as Credentials from "./Credentials.ts";
import { Environment, EnvironmentProvider } from "./Environment.ts";
import { Label, LabelProvider } from "./Label.ts";
import { Milestone, MilestoneProvider } from "./Milestone.ts";
import { Issue, IssueProvider } from "./Issue.ts";
import { PullRequest, PullRequestProvider } from "./PullRequest.ts";
import { Release, ReleaseProvider } from "./Release.ts";
import { Repository, RepositoryProvider } from "./Repository.ts";
import { Ruleset, RulesetProvider } from "./Ruleset.ts";
import { Secret, SecretProvider } from "./Secret.ts";
import { TeamAccess, TeamAccessProvider } from "./TeamAccess.ts";
import { Variable, VariableProvider } from "./Variable.ts";
import { Webhook, WebhookProvider } from "./Webhook.ts";
import { WikiPage, WikiPageProvider } from "./WikiPage.ts";

export { GitHubCredentials } from "./Credentials.ts";

export class Providers extends Provider.ProviderCollection<Providers>()(
  "GitHub",
) {}

export type ProviderRequirements = Layer.Services<ReturnType<typeof providers>>;

export interface ProvidersOptions extends GitHubAuthOptions {
  /**
   * A signed-in browser session for the steps GitHub only offers in its
   * web UI (registering, deleting and installing apps, repairing their
   * settings). `true` reads it from the environment
   * ({@link Browser.fromEnv}); an options object configures it directly
   * ({@link Browser.layer}). Without it those steps prompt a human.
   */
  browser?: Browser.GitHubBrowserOptions | true;
}

const browserSession = (
  browser: ProvidersOptions["browser"],
): Layer.Layer<never, never, FileSystem.FileSystem | Path.Path> =>
  browser === undefined
    ? Layer.empty
    : browser === true
      ? Browser.fromEnv()
      : Browser.layer(browser);

/**
 * GitHub resource providers and the GitHub AuthProvider discovered by the CLI.
 *
 * Pass `baseUrl` to pin every GitHub resource to a GitHub Enterprise host
 * without relying on the auth provider's configuration:
 *
 * ```typescript
 * providers: GitHub.providers({ baseUrl: "github.example.com" })
 * ```
 *
 * The auth provider receives the same value, so the configure flow skips the
 * host prompt and authenticates against the pinned host (`gh auth token
 * --hostname`, enterprise token env vars). Individual resources can still
 * override the host per-resource via their own `baseUrl` prop.
 *
 * Pass `browser` to let `GitHub.App` and `GitHub.AppInstallation` drive the
 * steps GitHub has no API for in a signed-in browser session instead of
 * prompting a human (sign in once with `alchemy provider github
 * browser-login`):
 *
 * ```typescript
 * providers: GitHub.providers({ browser: true })
 * ```
 *
 * The session is merged into the providers layer, so every lifecycle
 * operation of the stack sees it. A stack that builds the GitHub providers
 * some other way can provide {@link Browser.layer} on its own.
 */
export const providers = (options?: ProvidersOptions) =>
  Layer.effect(
    Providers,
    Provider.collection([
      App,
      AppInstallation,
      BranchProtection,
      Collaborator,
      Comment,
      Environment,
      Label,
      Milestone,
      Issue,
      PullRequest,
      Release,
      Repository,
      Ruleset,
      Secret,
      TeamAccess,
      Variable,
      Webhook,
      WikiPage,
    ]),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        AppProvider(),
        AppInstallationProvider(),
        BranchProtectionProvider(),
        CollaboratorProvider(),
        CommentProvider(),
        EnvironmentProvider(),
        LabelProvider(),
        MilestoneProvider(),
        IssueProvider(),
        PullRequestProvider(),
        ReleaseProvider(),
        RepositoryProvider(),
        RulesetProvider(),
        SecretProvider(),
        TeamAccessProvider(),
        VariableProvider(),
        WebhookProvider(),
        WikiPageProvider(),
      ),
    ),
    Layer.provideMerge(Credentials.fromAuthProvider(options)),
    Layer.provideMerge(browserSession(options?.browser)),
    Layer.provideMerge(makeGitHubAuth(options)),
    Layer.provideMerge(ProfileStoreLive),
    Layer.provideMerge(CredentialsStoreLive),
    Layer.orDie,
  );
