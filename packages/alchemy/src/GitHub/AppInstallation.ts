import type { Octokit as RestOctokit } from "@octokit/rest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../AdoptPolicy.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { UserFacingError } from "../UserFacingError.ts";
import { githubWebOrigin } from "./BaseUrl.ts";
import type { GitHubBrowser, GitHubBrowserError } from "./Browser.ts";
import { manualStep, pollUntilDefined, withBrowser } from "./ManualStep.ts";
import {
  appOctokit,
  effectiveGitHubBaseUrl,
  octokitFor,
  retryFreshAppKey,
  unlessStatus,
} from "./Octokit.ts";
import type * as GitHub from "./Providers.ts";
import {
  acceptInstallationPermissions,
  installApp,
  setInstallationRepositorySelection,
  setInstallationSuspension,
} from "./WebFlows.ts";

export interface AppInstallationProps {
  /** The app's ID, e.g. `app.appId` of a `GitHub.App`. */
  appId: number;
  /** The app's private key, used to sign the app JWT. */
  privateKey: Redacted.Redacted<string>;
  /** Login of the organization or user to install the app on. */
  account: string;
  /**
   * Install on every repository of the account, or only on `repositories`.
   * GitHub has no API to switch between the two.
   */
  repositorySelection: "all" | "selected";
  /** Repository names in `account`, when `repositorySelection` is `selected`. */
  repositories?: string[];
  /**
   * Suspend the installation: the app keeps its installation but loses
   * access to the account's resources until it is unsuspended. A
   * suspension made in the GitHub UI can only be lifted there, so lifting
   * one needs a browser session.
   * @default false
   */
  suspended?: boolean;
  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise).
   */
  baseUrl?: string;
}

export interface AppInstallation extends Resource<
  "GitHub.AppInstallation",
  AppInstallationProps,
  {
    installationId: number;
    account: string;
    repositorySelection: "all" | "selected";
    /** Selected repository names, sorted; empty for `all`. */
    repositories: string[];
    /** Permissions the account has granted the installation. */
    permissions: Record<string, string>;
    events: string[];
    /** The installation's settings page. */
    htmlUrl: string;
    /** Whether the installation is suspended, through the API or the UI. */
    suspended: boolean;
    /** When the installation was suspended (ISO 8601). */
    suspendedAt: string | undefined;
    /**
     * Login that suspended the installation: the app's bot
     * (`<slug>[bot]`) for the API, a user for the GitHub UI.
     */
    suspendedBy: string | undefined;
  },
  never,
  GitHub.Providers
> {}

/**
 * An installation of a GitHub App on an organization or user account.
 *
 * GitHub has no API to install an app, so the first deploy opens the app's
 * install page: with a browser session configured (see below) alchemy
 * installs it there itself, otherwise it waits until a human does (without
 * an interactive terminal it fails with `GitHubManualStepRequired`).
 * Selected repositories are then added and removed through the API.
 * Switching between `all` and `selected`, or app permissions the account
 * has not yet accepted, are likewise applied through the browser session,
 * and without one fail with `GitHubAppInstallationDrift` and the settings
 * URL to resolve them at.
 *
 * Installations default to **retain** on removal: the state is dropped and
 * the app stays installed. Opt into uninstalling through the API with
 * {@link destroy}() from `alchemy/RemovalPolicy`.
 *
 * An installation found on `account` with no prior state is owned by
 * someone else until the deploy runs with `--adopt` (or `adopt(true)`).
 *
 * ### Installing an App
 * **Example:** Install on selected repositories
 * ```typescript
 * const app = yield* GitHub.App("bot", { ... });
 *
 * yield* GitHub.AppInstallation("bot-install", {
 *   appId: app.appId,
 *   privateKey: app.privateKey,
 *   account: "my-org",
 *   repositorySelection: "selected",
 *   repositories: ["api", "web"],
 * });
 * ```
 *
 * ### Unattended deploys with a browser session
 * Sign a browser profile in to GitHub once as an owner of `account`, then
 * pass `browser` to the providers: installing, switching the repository
 * selection and accepting new permissions run headless in that session,
 * with no prompt and no clicks, so deploy also works without a terminal.
 * ```sh
 * alchemy provider github browser-login
 * ```
 * ```typescript
 * providers: GitHub.providers({ browser: true })
 * ```
 * `browser: true` reads the session from the environment, so in CI set
 * `GITHUB_BROWSER_USERNAME`, `GITHUB_BROWSER_PASSWORD` and
 * `GITHUB_BROWSER_TOTP_SECRET` (the account's TOTP seed) for an unattended
 * sign-in. Pass an options object instead to pin the profile directory,
 * host, or credentials.
 *
 * ### Suspending an installation
 * **Example:** Suspend the app on an account
 * ```typescript
 * yield* GitHub.AppInstallation("bot-install", {
 *   appId: app.appId,
 *   privateKey: app.privateKey,
 *   account: "my-org",
 *   repositorySelection: "all",
 *   suspended: true,
 * });
 * ```
 * Setting `suspended: false` lifts a suspension made through the API
 * directly, and one made in the GitHub UI through the browser session.
 *
 * @resource
 * @product App
 */
export const AppInstallation = Resource<AppInstallation>(
  "GitHub.AppInstallation",
  { defaultRemovalPolicy: "retain" },
);

/** The installation differs in a way only the account owner can fix. */
export class GitHubAppInstallationDrift extends Data.TaggedError(
  "GitHubAppInstallationDrift",
)<{
  readonly reason: "repository-selection" | "permissions-pending" | "suspended";
  readonly url: string;
  readonly slug: string;
  readonly account: string;
}> {
  readonly [UserFacingError] = true;
  override get message(): string {
    if (this.reason === "suspended") {
      return `GitHub App ${this.slug} was suspended on ${this.account} in the GitHub UI, and GitHub has no API to lift that. Unsuspend it in your browser, then deploy again: ${this.url}`;
    }
    return this.reason === "repository-selection"
      ? `GitHub has no API to change which repositories GitHub App ${this.slug} can access on ${this.account}. Change it in your browser, then deploy again: ${this.url}`
      : `GitHub App ${this.slug} asks for new permissions on ${this.account}, and GitHub has no API to approve them. Approve them in your browser, then deploy again: ${this.url}`;
  }
}

/** GitHub did not apply a suspension change before the deploy gave up. */
export class GitHubAppInstallationSuspensionNotApplied extends Data.TaggedError(
  "GitHubAppInstallationSuspensionNotApplied",
)<{
  readonly desired: boolean;
  readonly url: string;
  readonly slug: string;
  readonly account: string;
}> {
  readonly [UserFacingError] = true;
  override get message(): string {
    return `GitHub did not ${this.desired ? "suspend" : "unsuspend"} GitHub App ${this.slug} on ${this.account} in time. Check the installation, then deploy again: ${this.url}`;
  }
}

/** The installation was removed while the deploy was changing it. */
export class GitHubAppInstallationNotFound extends Data.TaggedError(
  "GitHubAppInstallationNotFound",
)<{
  readonly installationId: number;
  readonly slug: string;
  readonly account: string;
}> {
  readonly [UserFacingError] = true;
  override get message(): string {
    return `GitHub App ${this.slug}'s installation ${this.installationId} on ${this.account} was removed during the deploy. Deploy again to install it.`;
  }
}

interface InstallationTarget {
  readonly account: string;
  readonly accountType: "Organization" | "User";
  readonly installationId: number;
  readonly baseUrl?: string;
}

export const appInstallUrl = (options: {
  readonly slug: string;
  readonly baseUrl?: string;
}) =>
  `${githubWebOrigin(options.baseUrl)}/apps/${options.slug}/installations/new`;

export const installationSettingsUrl = (target: InstallationTarget) =>
  `${githubWebOrigin(target.baseUrl)}${target.accountType === "Organization" ? `/organizations/${target.account}` : ""}/settings/installations/${target.installationId}`;

export const installationPermissionsReviewUrl = (target: InstallationTarget) =>
  `${installationSettingsUrl(target)}/permissions/update`;

const rank = (access: string | undefined) =>
  ["read", "write", "admin"].indexOf(access ?? "") + 1;

/** App permissions the installation has not accepted: raised or added. */
export const installationPermissionsPending = (
  appPermissions: Readonly<Record<string, string | undefined>>,
  grantedPermissions: Readonly<Record<string, string | undefined>>,
) =>
  Object.entries(appPermissions)
    .filter(([name, access]) => rank(access) > rank(grantedPermissions[name]))
    .map(([name]) => name);

export const installationRepositoryDelta = (
  desired: ReadonlyArray<string>,
  live: ReadonlyArray<string>,
) => ({
  add: desired.filter((name) => !live.includes(name)),
  remove: live.filter((name) => !desired.includes(name)),
});

/**
 * The step that moves an installation's suspension to `desired`. A
 * suspension by the app's bot was made through the API and is lifted
 * there; any other was made in the GitHub UI and is lifted in the browser.
 */
export const installationSuspensionAction = (options: {
  readonly suspendedAt: string | undefined;
  readonly suspendedBy: string | undefined;
  readonly slug: string;
  readonly desired: boolean;
}): "none" | "suspend" | "unsuspend" | "unsuspend-in-browser" => {
  if ((options.suspendedAt !== undefined) === options.desired) return "none";
  if (options.desired) return "suspend";
  return options.suspendedBy?.toLowerCase() ===
    `${options.slug}[bot]`.toLowerCase()
    ? "unsuspend"
    : "unsuspend-in-browser";
};

// A deleted app answers its own JWT with 404, which means no installation.
const findInstallation = (app: () => RestOctokit, account: string) =>
  unlessStatus([404], () => {
    const octokit = app();
    return octokit.paginate(octokit.rest.apps.listInstallations, {
      per_page: 100,
    });
  }).pipe(
    retryFreshAppKey,
    Effect.map((installations) =>
      installations?.find(
        (installation) =>
          accountLogin(installation.account)?.toLowerCase() ===
          account.toLowerCase(),
      ),
    ),
  );

const getInstallation = (app: () => RestOctokit, installationId: number) =>
  unlessStatus([404], () =>
    app().rest.apps.getInstallation({ installation_id: installationId }),
  ).pipe(
    retryFreshAppKey,
    Effect.map((found) => found?.data ?? undefined),
  );

const accountLogin = (
  account: { readonly login: string } | { readonly slug: string } | null,
) =>
  account === null
    ? undefined
    : "login" in account
      ? account.login
      : account.slug;

type LiveInstallation = NonNullable<
  Effect.Success<ReturnType<typeof getInstallation>>
>;

const targetOf = (
  installation: LiveInstallation,
  account: string,
  baseUrl: string | undefined,
): InstallationTarget => ({
  account: accountLogin(installation.account) ?? account,
  accountType:
    installation.target_type === "Organization" ? "Organization" : "User",
  installationId: installation.id,
  baseUrl,
});

const listRepositories = (octokit: RestOctokit, installationId: number) =>
  Effect.tryPromise(() =>
    octokit.paginate(
      octokit.rest.apps.listInstallationReposForAuthenticatedUser,
      {
        installation_id: installationId,
        per_page: 100,
      },
    ),
  );

const suspensionOf = (installation: LiveInstallation) => ({
  suspended: installation.suspended_at !== null,
  suspendedAt: installation.suspended_at ?? undefined,
  suspendedBy:
    installation.suspended_at === null
      ? undefined
      : installation.suspended_by?.login,
});

const attrsOf = (
  installation: LiveInstallation,
  target: InstallationTarget,
  repositories: ReadonlyArray<string>,
): AppInstallation["Attributes"] => ({
  installationId: installation.id,
  account: target.account,
  repositorySelection: installation.repository_selection,
  repositories:
    installation.repository_selection === "selected"
      ? [...repositories].sort()
      : [],
  permissions: Object.fromEntries(Object.entries(installation.permissions)),
  events: [...installation.events].sort(),
  htmlUrl: installationSettingsUrl(target),
  ...suspensionOf(installation),
});

// Drift only the account owner can fix. A browser session applies `fix`
// and the installation is read again; what still differs is reported.
const repairInstallationDrift = (options: {
  readonly installation: LiveInstallation;
  readonly drifted: (installation: LiveInstallation) => boolean;
  readonly fix: Effect.Effect<void, GitHubBrowserError, GitHubBrowser>;
  readonly app: () => RestOctokit;
  readonly error: GitHubAppInstallationDrift;
}) =>
  Effect.gen(function* () {
    if (!options.drifted(options.installation)) return options.installation;
    const repaired = yield* withBrowser(
      options.fix.pipe(
        Effect.andThen(getInstallation(options.app, options.installation.id)),
      ),
    );
    const installation =
      Option.getOrUndefined(repaired) ?? options.installation;
    if (options.drifted(installation)) return yield* options.error;
    return installation;
  });

// Suspension reads are eventually consistent: poll until `settled`.
const awaitInstallation = (options: {
  readonly app: () => RestOctokit;
  readonly installation: LiveInstallation;
  readonly settled: (installation: LiveInstallation) => boolean;
  readonly missing: GitHubAppInstallationNotFound;
}) =>
  getInstallation(options.app, options.installation.id).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("2 seconds"),
      until: (found) => found === undefined || options.settled(found),
      times: 10,
    }),
    Effect.flatMap((found) =>
      found === undefined
        ? Effect.fail(options.missing)
        : Effect.succeed(found),
    ),
  );

// API and UI suspensions are separate flags, each lifted only where it was
// set, so lifting one can uncover the other. Up to two steps run, and the
// installation must end with nothing left to apply.
const syncInstallationSuspension = (options: {
  readonly installation: LiveInstallation;
  readonly desired: boolean;
  readonly slug: string;
  readonly account: string;
  readonly app: () => RestOctokit;
  readonly settingsUrl: string;
}) =>
  Effect.gen(function* () {
    const { app, desired, slug, account, settingsUrl } = options;
    const actionOf = (installation: LiveInstallation) => {
      const observed = suspensionOf(installation);
      return installationSuspensionAction({ ...observed, slug, desired });
    };
    const uiSuspended = new GitHubAppInstallationDrift({
      reason: "suspended",
      slug,
      account,
      url: settingsUrl,
    });
    let installation = options.installation;
    for (let step = 0; step < 2; step++) {
      const action = actionOf(installation);
      if (action === "none") return installation;
      if (action === "suspend") {
        yield* Effect.tryPromise(() =>
          app().rest.apps.suspendInstallation({
            installation_id: installation.id,
          }),
        ).pipe(retryFreshAppKey);
      } else if (action === "unsuspend") {
        yield* Effect.tryPromise(() =>
          app().rest.apps.unsuspendInstallation({
            installation_id: installation.id,
          }),
        ).pipe(retryFreshAppKey);
      } else {
        const repaired = yield* withBrowser(
          setInstallationSuspension({ settingsUrl, suspended: false }),
        );
        if (Option.isNone(repaired)) return yield* uiSuspended;
      }
      installation = yield* awaitInstallation({
        app,
        installation,
        settled: (live) => actionOf(live) !== action,
        missing: new GitHubAppInstallationNotFound({
          installationId: installation.id,
          slug,
          account,
        }),
      });
    }
    const remaining = actionOf(installation);
    if (remaining === "none") return installation;
    if (remaining === "unsuspend-in-browser") return yield* uiSuspended;
    return yield* new GitHubAppInstallationSuspensionNotApplied({
      desired,
      slug,
      account,
      url: settingsUrl,
    });
  });

export const AppInstallationProvider = () =>
  Provider.succeed(AppInstallation, {
    stables: ["installationId"],

    reconcile: Effect.fn(function* ({ news, output }) {
      const octokit = yield* octokitFor(news.baseUrl);
      const baseUrl = yield* effectiveGitHubBaseUrl(news.baseUrl);
      const app = () => appOctokit(news.appId, news.privateKey, baseUrl);
      const { data: registration } = yield* Effect.tryPromise(() =>
        app().rest.apps.getAuthenticated(),
      );
      if (registration === null) {
        return yield* Effect.fail(
          new Error(`GitHub App ${news.appId} could not be read`),
        );
      }

      // Observe by id, then by account (a reinstall has a new id), then
      // ensure — installing has no API, it is clicked in the browser.
      const slug = registration.slug ?? "";
      const installUrl = appInstallUrl({ slug, baseUrl });
      const found =
        (output === undefined
          ? undefined
          : yield* getInstallation(app, output.installationId)) ??
        (yield* findInstallation(app, news.account)) ??
        (yield* manualStep({
          step: "install-app",
          url: installUrl,
          action: `install GitHub App ${slug} on ${news.account}`,
          instruction: 'Pick the repositories and click "Install"',
          until: pollUntilDefined(findInstallation(app, news.account)),
          automate: installApp({
            installUrl,
            account: news.account,
            repositorySelection: news.repositorySelection,
            repositories: news.repositories,
          }),
        }));
      const target = targetOf(found, news.account, baseUrl);
      const suspended = news.suspended ?? false;
      const syncSuspension = (installation: LiveInstallation) =>
        syncInstallationSuspension({
          installation,
          desired: suspended,
          slug,
          account: news.account,
          app,
          settingsUrl: installationSettingsUrl(target),
        });

      // Sync — lift a suspension before the other syncs, apply one after.
      const active = suspended ? found : yield* syncSuspension(found);

      // Sync — what only the account owner can change.
      const selected = yield* repairInstallationDrift({
        installation: active,
        drifted: (installation) =>
          installation.repository_selection !== news.repositorySelection,
        fix: setInstallationRepositorySelection({
          settingsUrl: installationSettingsUrl(target),
          repositorySelection: news.repositorySelection,
          repositories: news.repositories,
        }),
        app,
        error: new GitHubAppInstallationDrift({
          reason: "repository-selection",
          slug,
          account: news.account,
          url: installationSettingsUrl(target),
        }),
      });
      const installation = yield* repairInstallationDrift({
        installation: selected,
        drifted: (installation) =>
          installationPermissionsPending(
            registration.permissions,
            installation.permissions,
          ).length > 0,
        fix: acceptInstallationPermissions({
          reviewUrl: installationPermissionsReviewUrl(target),
        }),
        app,
        error: new GitHubAppInstallationDrift({
          reason: "permissions-pending",
          slug,
          account: news.account,
          url: installationPermissionsReviewUrl(target),
        }),
      });

      // Sync — selected repositories, as the authenticated user.
      const desired = news.repositories ?? [];
      if (news.repositorySelection === "selected") {
        const live = yield* listRepositories(octokit, installation.id);
        const delta = installationRepositoryDelta(
          desired,
          live.map((repo) => repo.name),
        );
        for (const name of delta.add) {
          const { data: repo } = yield* Effect.tryPromise(() =>
            octokit.rest.repos.get({ owner: target.account, repo: name }),
          );
          yield* Effect.tryPromise(() =>
            octokit.rest.apps.addRepoToInstallationForAuthenticatedUser({
              installation_id: installation.id,
              repository_id: repo.id,
            }),
          );
        }
        for (const repo of live.filter((r) => delta.remove.includes(r.name))) {
          yield* Effect.tryPromise(() =>
            octokit.rest.apps.removeRepoFromInstallationForAuthenticatedUser({
              installation_id: installation.id,
              repository_id: repo.id,
            }),
          );
        }
      }

      const synced = suspended
        ? yield* syncSuspension(installation)
        : installation;

      return attrsOf(synced, target, desired);
    }),

    // With state, the installation is read by id. Without state, the one on
    // the account belongs to someone else until `--adopt` takes it over.
    read: Effect.fn(function* ({ olds, output }) {
      const octokit = yield* octokitFor(olds.baseUrl);
      const baseUrl = yield* effectiveGitHubBaseUrl(olds.baseUrl);
      const app = () => appOctokit(olds.appId, olds.privateKey, baseUrl);
      const installation =
        output === undefined
          ? yield* findInstallation(app, olds.account)
          : yield* getInstallation(app, output.installationId);
      if (installation === undefined) return undefined;
      const repositories =
        installation.repository_selection === "selected"
          ? yield* listRepositories(octokit, installation.id)
          : [];
      const attrs = attrsOf(
        installation,
        targetOf(installation, olds.account, baseUrl),
        repositories.map((repo) => repo.name),
      );
      return output === undefined ? Unowned(attrs) : attrs;
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      const baseUrl = yield* effectiveGitHubBaseUrl(olds.baseUrl);
      yield* unlessStatus([404], () =>
        appOctokit(
          olds.appId,
          olds.privateKey,
          baseUrl,
        ).rest.apps.deleteInstallation({
          installation_id: output.installationId,
        }),
      );
    }),
  });
