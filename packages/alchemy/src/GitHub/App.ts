import type { Octokit as RestOctokit } from "@octokit/rest";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { createPrivateKey, randomUUID } from "node:crypto";
import http from "node:http";
import { Unowned } from "../AdoptPolicy.ts";
import { deepEqual } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { UserFacingError } from "../UserFacingError.ts";
import { githubWebOrigin } from "./BaseUrl.ts";
import { manualStep, pollUntilDefined, withBrowser } from "./ManualStep.ts";
import {
  appOctokit,
  effectiveGitHubBaseUrl,
  octokitFor,
  unlessStatus,
} from "./Octokit.ts";
import type * as GitHub from "./Providers.ts";
import {
  appGeneralSettingsFormDrift,
  deleteApp,
  readAppVisibility,
  registerAppFromManifest,
  setAppVisibility,
  syncAppGeneralSettings,
  updateAppPermissions,
  type AppGeneralSettings,
  type DesiredAppGeneralSettings,
} from "./WebFlows.ts";

export type AppPermissionAccess = "read" | "write" | "admin";

export interface AppWebhook {
  /** URL GitHub `POST`s app events to. */
  url: string;
  /** Secret used to sign deliveries. Set through the API, never the manifest. */
  secret?: Redacted.Redacted<string>;
  /** @default "json" */
  contentType?: "json" | "form";
  /** @default false */
  insecureSsl?: boolean;
  /**
   * Whether GitHub delivers events to `url`. No API reads or writes it after
   * registration; a browser session keeps it in sync.
   * @default true
   */
  active?: boolean;
}

export interface AppProps {
  /**
   * Organization that owns the app. Omit to register it under the
   * authenticated user.
   */
  owner?: string;
  /** App name; GitHub derives the slug from it. At most 34 characters. */
  name: string;
  /**
   * Slug of the registration to adopt, when it differs from the one GitHub
   * derives from `name`.
   */
  slug?: string;
  /**
   * Private key of an existing registration: required to adopt one, and
   * the way to hand over a rotated key. A fresh registration returns its
   * own key, so this is ignored then.
   */
  privateKey?: Redacted.Redacted<string>;
  /** Client secret of an existing registration. GitHub never returns it. */
  clientSecret?: Redacted.Redacted<string>;
  /** Homepage URL shown on the app's public page. */
  url: string;
  description?: string;
  /** Repository, organization and account permissions, e.g. `{ issues: "write" }`. */
  permissions: Record<string, AppPermissionAccess>;
  /** Webhook events the app subscribes to. Requires `webhook`. */
  events?: string[];
  /** Webhook delivery settings, synced through `PATCH /app/hook/config`. */
  webhook?: AppWebhook;
  /**
   * Request user authorization (OAuth) during installation. No API reads or
   * writes it after registration; a browser session keeps it in sync.
   * GitHub disables `setupUrl` while it is set, so the two are mutually
   * exclusive.
   * @default false
   */
  requestOauthOnInstall?: boolean;
  /**
   * URLs GitHub may redirect to after a user authorizes the app, at most 10.
   * No API reads or writes them after registration; a browser session keeps
   * them in sync.
   */
  callbackUrls?: string[];
  /**
   * URL GitHub redirects to after the app is installed, for setup the app
   * needs. No API reads or writes it after registration; a browser session
   * keeps it in sync. Cannot be combined with `requestOauthOnInstall`.
   */
  setupUrl?: string;
  /**
   * Also redirect to `setupUrl` after an installation is updated. No API
   * reads or writes it after registration; a browser session keeps it in
   * sync.
   * @default false
   */
  setupOnUpdate?: boolean;
  /**
   * Whether any account can install the app. A private app installs only on
   * its owner. GitHub refuses to make an app private while it is installed
   * on other accounts. No API reads or writes it after registration; a
   * browser session keeps it in sync.
   * @default false
   */
  public?: boolean;
  /**
   * Override the GitHub host or API base URL for this resource only (e.g.
   * `github.example.com` for GitHub Enterprise).
   */
  baseUrl?: string;
}

export interface App extends Resource<
  "GitHub.App",
  AppProps,
  {
    /** Numeric app ID, the JWT issuer. */
    appId: number;
    slug: string;
    name: string;
    /** Login of the owning organization or user. */
    owner: string;
    clientId: string;
    /** Unknown for an adopted registration unless passed in. */
    clientSecret: Redacted.Redacted<string> | undefined;
    /** PEM private key returned once at registration, or passed in. */
    privateKey: Redacted.Redacted<string>;
    /**
     * `privateKey` re-encoded as PKCS#8 PEM (`-----BEGIN PRIVATE KEY-----`).
     * GitHub issues PKCS#1 keys; hand this one to JWT libraries that only
     * accept PKCS#8.
     */
    privateKeyPkcs8: Redacted.Redacted<string>;
    /** Login of the app's bot user, `<slug>[bot]`. */
    botLogin: string;
    /**
     * Numeric ID of the bot user, as in its noreply commit email
     * `<botUserId>+<botLogin>@users.noreply.github.com`.
     */
    botUserId: number;
    webhookSecret: Redacted.Redacted<string> | undefined;
    /** Public page of the app, `https://github.com/apps/<slug>`. */
    htmlUrl: string;
    permissions: Record<string, string>;
    events: string[];
    /** Whether any account can install the app. */
    public: boolean;
  },
  never,
  GitHub.Providers
> {}

/**
 * A GitHub App registration.
 *
 * GitHub has no API to register or delete an app, so both happen in a
 * browser: the first deploy opens a local page that submits an app manifest
 * to GitHub, where "Create GitHub App" is clicked; destroy opens the app's
 * advanced settings page and waits until it is deleted. With a browser
 * session configured (see below) alchemy clicks through both itself.
 * Otherwise a human does, and without an interactive terminal both fail
 * with `GitHubManualStepRequired`.
 *
 * Apps register private unless `public` is set.
 *
 * Later deploys never prompt. Webhook settings are synced through the API.
 * Any other difference from the live registration (name, description, URL,
 * permissions, events, visibility) is repaired through the browser session
 * when there is one, and otherwise fails with `GitHubAppDrift` and the
 * settings URL to fix it at.
 *
 * No API reports visibility, so the browser session reads and sets it on
 * the app's Advanced settings page. Without a session, changing `public`
 * fails with `GitHubAppDrift` and that page's URL, and adopting an app
 * fails with `GitHubAppVisibilityNeedsBrowser`.
 *
 * Callback URLs, the setup URL, redirect-on-update, OAuth on install and
 * the webhook's Active checkbox cannot be read through any API. The
 * browser session syncs them whenever the browser is needed anyway, when
 * one of them changes, and on adoption. Without a session, changing one
 * fails with `GitHubAppDrift`.
 *
 * Apps default to **retain** on removal: destroying the stack drops the
 * state and leaves the registration (and every installation) in place.
 * Opt into the browser delete step with {@link destroy}() from
 * `alchemy/RemovalPolicy`.
 *
 * ### Registering an App
 * **Example:** Organization app with a webhook
 * ```typescript
 * const app = yield* GitHub.App("bot", {
 *   owner: "my-org",
 *   name: "my-org-bot",
 *   url: "https://example.com",
 *   permissions: { issues: "write", pull_requests: "read" },
 *   events: ["issues", "pull_request"],
 *   webhook: {
 *     url: "https://example.com/github",
 *     secret: Redacted.make(process.env.WEBHOOK_SECRET!),
 *   },
 * });
 * ```
 *
 * Without `owner` the app is registered under the account signed in to the
 * browser, not the account behind the token.
 *
 * ### Adopting an App
 * A registration found by slug with no prior state is owned by someone else
 * until the deploy runs with `--adopt` (or `adopt(true)`). Adopting needs
 * the app's private key (generate one on its settings page); the client
 * secret is optional. Drift against the live registration is reported as
 * usual, and `webhook` is applied through the API.
 * ```typescript
 * import { adopt } from "alchemy/AdoptPolicy";
 *
 * const app = yield* GitHub.App("bot", {
 *   owner: "my-org",
 *   name: "my-org-bot",
 *   url: "https://example.com",
 *   permissions: { issues: "write" },
 *   privateKey: yield* Config.Redacted("BOT_PRIVATE_KEY"),
 * }).pipe(adopt(true));
 * ```
 *
 * ### Delivering Webhooks to a Worker
 * Inputs may be `Output`s, so a `webhook.url` can come from another
 * resource and the secret from a shared `Alchemy.Random`. The Worker that
 * verifies deliveries also binds `app.privateKey`, which is a cycle if its
 * URL is only known after it deploys. Give the Worker a URL known up front —
 * a custom domain or route — and pass that string as `webhook.url`. GitHub
 * requires `webhook.url` in the manifest whenever `events` is set, so the
 * URL cannot be filled in by a later step. Bind `app.privateKeyPkcs8`
 * rather than `app.privateKey` for JWT libraries that only accept
 * `-----BEGIN PRIVATE KEY-----`. `botLogin` and `botUserId` give commits
 * made as the app the author `<botLogin>` and the email
 * `<botUserId>+<botLogin>@users.noreply.github.com`.
 * ```typescript
 * const secret = yield* Alchemy.Random("WebhookSecret");
 * const app = yield* GitHub.App("bot", {
 *   owner: "my-org",
 *   name: "my-org-bot",
 *   url: "https://bot.example.com",
 *   permissions: { issues: "write" },
 *   events: ["issues"],
 *   webhook: { url: "https://bot.example.com/github", secret: secret.text },
 * });
 * yield* Cloudflare.Worker("Bot", {
 *   domains: ["bot.example.com"],
 *   bindings: {
 *     APP_ID: app.appId,
 *     PRIVATE_KEY: app.privateKeyPkcs8,
 *     WEBHOOK_SECRET: secret.text,
 *     BOT_LOGIN: app.botLogin,
 *     BOT_USER_ID: app.botUserId,
 *   },
 * });
 * ```
 *
 * ### Callback and setup URLs
 * **Example:** OAuth callbacks and a post-install setup page
 * ```typescript
 * const app = yield* GitHub.App("bot", {
 *   owner: "my-org",
 *   name: "my-org-bot",
 *   url: "https://example.com",
 *   permissions: { issues: "write" },
 *   callbackUrls: ["https://example.com/auth/callback"],
 *   setupUrl: "https://example.com/setup",
 *   setupOnUpdate: true,
 * });
 * ```
 *
 * ### Unattended deploys with a browser session
 * Sign a browser profile in to GitHub once, then pass `browser` to the
 * providers: registration, deletion and drift repair run headless in that
 * session, with no prompt and no clicks, so deploy and destroy also work
 * without a terminal.
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
 * @resource
 * @product App
 */
export const App = Resource<App>("GitHub.App", {
  defaultRemovalPolicy: "retain",
});

/** The registration exists, but adopting it needs its private key. */
export class GitHubAppAdoptionNeedsKey extends Data.TaggedError(
  "GitHubAppAdoptionNeedsKey",
)<{
  readonly slug: string;
  readonly url: string;
}> {
  readonly [UserFacingError] = true;
  override get message(): string {
    return `GitHub App ${this.slug} already exists. To adopt it, generate a private key on its settings page and pass it as \`privateKey\`, then deploy with --adopt: ${this.url}`;
  }
}

/** The registration exists, but rejects the private key alchemy holds. */
export class GitHubAppKeyRejected extends Data.TaggedError(
  "GitHubAppKeyRejected",
)<{
  readonly slug: string;
  readonly url: string;
}> {
  readonly [UserFacingError] = true;
  override get message(): string {
    return `GitHub App ${this.slug} exists but rejected its private key. Generate a new key on its settings page and pass it as \`privateKey\`: ${this.url}`;
  }
}

/** The private key is not a valid PEM private key. */
export class GitHubAppKeyInvalid extends Data.TaggedError(
  "GitHubAppKeyInvalid",
)<{
  readonly slug: string;
  readonly cause: unknown;
}> {
  readonly [UserFacingError] = true;
  override get message(): string {
    return `The private key of GitHub App ${this.slug} is not a valid PEM private key. Pass the key generated on its settings page as \`privateKey\`.`;
  }
}

/** The app's private key as PKCS#8 PEM, whether it was PKCS#1 or PKCS#8. */
export const appPrivateKeyPkcs8 = (
  slug: string,
  privateKey: Redacted.Redacted<string>,
) =>
  Effect.try({
    try: () =>
      Redacted.make(
        createPrivateKey(Redacted.value(privateKey)).export({
          type: "pkcs8",
          format: "pem",
        }),
      ),
    catch: (cause) => new GitHubAppKeyInvalid({ slug, cause }),
  });

/** The callback `state` does not match the registration's. */
export class GitHubAppManifestStateMismatch extends Data.TaggedError(
  "GitHubAppManifestStateMismatch",
)<{
  readonly message: string;
}> {
  readonly [UserFacingError] = true;
}

/** The manifest callback carries no `code`. */
export class GitHubAppManifestCodeMissing extends Data.TaggedError(
  "GitHubAppManifestCodeMissing",
)<{
  readonly message: string;
}> {
  readonly [UserFacingError] = true;
}

/** GitHub rejects a manifest that subscribes to events without a webhook URL. */
export class GitHubAppEventsRequireWebhook extends Data.TaggedError(
  "GitHubAppEventsRequireWebhook",
)<{
  readonly message: string;
}> {
  readonly [UserFacingError] = true;
}

/** GitHub accepts at most 10 callback URLs. */
export class GitHubAppTooManyCallbackUrls extends Data.TaggedError(
  "GitHubAppTooManyCallbackUrls",
)<{
  readonly message: string;
}> {
  readonly [UserFacingError] = true;
}

/** GitHub rejects a callback URL listed twice. */
export class GitHubAppDuplicateCallbackUrls extends Data.TaggedError(
  "GitHubAppDuplicateCallbackUrls",
)<{
  readonly message: string;
}> {
  readonly [UserFacingError] = true;
}

/** GitHub disables the setup URL while the app requests OAuth on install. */
export class GitHubAppSetupUrlRequiresNoOauth extends Data.TaggedError(
  "GitHubAppSetupUrlRequiresNoOauth",
)<{
  readonly message: string;
}> {
  readonly [UserFacingError] = true;
}

const MAX_CALLBACK_URLS = 10;

/** Props GitHub would reject, caught before any API call or manual step. */
export const validateAppProps = (props: AppProps) =>
  Effect.gen(function* () {
    if (props.events?.length && props.webhook === undefined) {
      return yield* new GitHubAppEventsRequireWebhook({
        message: `GitHub App ${props.name} subscribes to events (${props.events.join(", ")}) but has no webhook. Set \`webhook.url\`, or remove \`events\`.`,
      });
    }
    if ((props.callbackUrls?.length ?? 0) > MAX_CALLBACK_URLS) {
      return yield* new GitHubAppTooManyCallbackUrls({
        message: `GitHub App ${props.name} has ${props.callbackUrls?.length} callback URLs; GitHub accepts at most ${MAX_CALLBACK_URLS}.`,
      });
    }
    const callbackUrls = props.callbackUrls ?? [];
    const duplicates = [
      ...new Set(
        callbackUrls.filter((url, i) => callbackUrls.indexOf(url) !== i),
      ),
    ];
    if (duplicates.length > 0) {
      return yield* new GitHubAppDuplicateCallbackUrls({
        message: `GitHub App ${props.name} lists callback URLs more than once (${duplicates.join(", ")}); list each once.`,
      });
    }
    if (props.setupUrl && props.requestOauthOnInstall) {
      return yield* new GitHubAppSetupUrlRequiresNoOauth({
        message: `GitHub App ${props.name} sets \`setupUrl\` and \`requestOauthOnInstall\`, but GitHub ignores the setup URL while OAuth on install is requested. Remove one of them.`,
      });
    }
  });

export interface AppDriftField {
  readonly field:
    | "name"
    | "description"
    | "url"
    | "permissions"
    | "events"
    | "requestOauthOnInstall"
    | "public"
    | "callbackUrls"
    | "setupUrl"
    | "setupOnUpdate"
    | "webhookActive";
  readonly desired: unknown;
  /** `undefined` for settings GitHub never returns. */
  readonly live: unknown;
}

/** The live registration differs in a way no API can fix. */
export class GitHubAppDrift extends Data.TaggedError("GitHubAppDrift")<{
  readonly url: string;
  readonly slug: string;
  readonly fields: ReadonlyArray<AppDriftField>;
}> {
  readonly [UserFacingError] = true;
  override get message(): string {
    const changes = this.fields
      .map(
        (f) =>
          `${f.field} to ${JSON.stringify(f.desired)}${f.live === undefined ? "" : ` (now ${JSON.stringify(f.live)})`}`,
      )
      .join(", ");
    // Settings GitHub's API cannot read are only verified by a browser session.
    const unobservable = this.fields.every((f) => f.live === undefined);
    const again = unobservable
      ? "then deploy again with a browser session (GitHub.providers({ browser: true }))"
      : "then deploy again";
    return `GitHub has no API to change GitHub App ${this.slug}. In your browser, set ${changes}, ${again}: ${this.url}`;
  }
}

const ownerSettings = (owner: string | undefined, baseUrl?: string) =>
  `${githubWebOrigin(baseUrl)}${owner === undefined ? "" : `/organizations/${owner}`}/settings`;

export const appRegistrationUrl = (options: {
  readonly owner?: string;
  readonly state: string;
  readonly baseUrl?: string;
}) =>
  `${ownerSettings(options.owner, options.baseUrl)}/apps/new?state=${encodeURIComponent(options.state)}`;

export const appSettingsUrl = (options: {
  readonly owner?: string;
  readonly slug: string;
  readonly page?: "permissions" | "advanced";
  readonly baseUrl?: string;
}) =>
  `${ownerSettings(options.owner, options.baseUrl)}/apps/${options.slug}${options.page === undefined ? "" : `/${options.page}`}`;

/** The manifest GitHub's registration page accepts (snake_case). */
export const appManifest = (
  props: AppProps,
  options: { readonly redirectUrl: string },
) => ({
  name: props.name,
  url: props.url,
  description: props.description,
  public: props.public ?? false,
  default_permissions: props.permissions,
  default_events: props.events,
  hook_attributes:
    props.webhook === undefined
      ? undefined
      : { url: props.webhook.url, active: props.webhook.active ?? true },
  redirect_url: options.redirectUrl,
  request_oauth_on_install: props.requestOauthOnInstall ?? false,
  ...(props.callbackUrls === undefined
    ? {}
    : { callback_urls: props.callbackUrls }),
  ...(props.setupUrl === undefined ? {} : { setup_url: props.setupUrl }),
  ...(props.setupOnUpdate === undefined
    ? {}
    : { setup_on_update: props.setupOnUpdate }),
});

/** The slug GitHub derives from an app name, unless `slug` is given. */
export const appSlug = (props: Pick<AppProps, "name" | "slug">) =>
  props.slug ??
  props.name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** The `code` from GitHub's redirect, once its `state` checks out. */
export const parseManifestCallback = (url: string, expectedState: string) =>
  Effect.gen(function* () {
    const params = new URL(url).searchParams;
    if (params.get("state") !== expectedState) {
      return yield* new GitHubAppManifestStateMismatch({
        message:
          "The GitHub App manifest callback carried an unexpected state; the registration was not started by this deploy.",
      });
    }
    const code = params.get("code");
    if (!code) {
      return yield* new GitHubAppManifestCodeMissing({
        message: "The GitHub App manifest callback carried no code.",
      });
    }
    return code;
  });

type LivePermissions = Readonly<Record<string, string | undefined>>;

const definedPermissions = (permissions: LivePermissions) =>
  Object.fromEntries(
    Object.entries(permissions).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );

/**
 * Differences between the desired props and the live registration that no
 * API can fix. GitHub adds `metadata: read` to every app, so it only counts
 * when the props mention it.
 */
export const appDrift = (
  desired: AppProps,
  live: {
    readonly name: string;
    readonly description: string | null | undefined;
    readonly external_url: string;
    readonly permissions: LivePermissions;
    readonly events: ReadonlyArray<string>;
  },
): AppDriftField[] => {
  const { metadata, ...rest } = definedPermissions(live.permissions);
  const livePermissions =
    desired.permissions.metadata === undefined && metadata === "read"
      ? rest
      : definedPermissions(live.permissions);
  const desiredEvents = desired.events ?? [];
  const fields: AppDriftField[] = [];
  if (desired.name !== live.name) {
    fields.push({ field: "name", desired: desired.name, live: live.name });
  }
  if ((desired.description || undefined) !== (live.description || undefined)) {
    fields.push({
      field: "description",
      desired: desired.description,
      live: live.description ?? undefined,
    });
  }
  if (desired.url !== live.external_url) {
    fields.push({
      field: "url",
      desired: desired.url,
      live: live.external_url,
    });
  }
  if (!deepEqual(desired.permissions, livePermissions)) {
    fields.push({
      field: "permissions",
      desired: desired.permissions,
      live: livePermissions,
    });
  }
  if (!deepEqual([...desiredEvents].sort(), [...live.events].sort())) {
    fields.push({ field: "events", desired: desiredEvents, live: live.events });
  }
  return fields;
};

const desiredGeneralSettings = (
  props: AppProps,
): DesiredAppGeneralSettings => ({
  callbackUrls: props.callbackUrls ?? [],
  requestOauthOnInstall: props.requestOauthOnInstall ?? false,
  setupUrl: props.setupUrl || undefined,
  setupOnUpdate: props.setupOnUpdate ?? false,
  webhookActive:
    props.webhook === undefined ? undefined : (props.webhook.active ?? true),
});

/**
 * Differences between the desired props and the General settings page,
 * which no API reads. The webhook's Active checkbox only counts when
 * `webhook` is set.
 */
export const appGeneralSettingsDrift = (
  desired: AppProps,
  observed: AppGeneralSettings,
): AppDriftField[] =>
  appGeneralSettingsFormDrift(desiredGeneralSettings(desired), observed);

/**
 * General settings that differ between two sets of props, with unknown
 * live values. An app registered without `webhook` has Active unticked.
 */
export const changedAppGeneralSettings = (
  olds: AppProps,
  news: AppProps,
): AppDriftField[] =>
  appGeneralSettingsDrift(news, {
    ...desiredGeneralSettings(olds),
    webhookActive:
      olds.webhook === undefined ? false : (olds.webhook.active ?? true),
  }).map((field) => ({ ...field, live: undefined }));

/** `public` against the visibility the Advanced settings page shows. */
export const appVisibilityDrift = (
  desired: AppProps,
  live: boolean,
): AppDriftField[] =>
  (desired.public ?? false) === live
    ? []
    : [{ field: "public", desired: desired.public ?? false, live }];

/** A `public` prop that differs between two sets of props, live unknown. */
export const changedAppVisibility = (
  olds: AppProps,
  news: AppProps,
): AppDriftField[] =>
  appVisibilityDrift(news, olds.public ?? false).map((field) => ({
    ...field,
    live: undefined,
  }));

/**
 * Dropdown values that make the live permissions match `desired`: every
 * live permission the props drop becomes `none`, except GitHub's implicit
 * `metadata: read`.
 */
export const appPermissionChanges = (
  desired: Readonly<Record<string, AppPermissionAccess>>,
  live: LivePermissions,
): Record<string, "none" | AppPermissionAccess> => ({
  ...Object.fromEntries(
    Object.keys(definedPermissions(live))
      .filter(
        (name) =>
          desired[name] === undefined &&
          !(name === "metadata" && live.metadata === "read"),
      )
      .map((name) => [name, "none" as const]),
  ),
  ...desired,
});

interface LiveApp {
  readonly id: number;
  readonly slug?: string;
  readonly client_id?: string;
  readonly owner: { readonly login: string } | { readonly slug: string };
  readonly name: string;
  readonly description: string | null;
  readonly external_url: string;
  readonly html_url: string;
  readonly permissions: LivePermissions;
  readonly events: ReadonlyArray<string>;
  /** As the Advanced settings page shows it; `undefined` when not read. */
  readonly public: boolean | undefined;
}

type AppSecrets = Pick<
  App["Attributes"],
  "clientSecret" | "privateKey" | "webhookSecret"
>;

/** The app's bot user does not resolve by its login. */
export class GitHubAppBotUserNotFound extends Data.TaggedError(
  "GitHubAppBotUserNotFound",
)<{
  readonly login: string;
}> {
  readonly [UserFacingError] = true;
  override get message(): string {
    return `GitHub has no bot user ${this.login}.`;
  }
}

const botUserId = (octokit: RestOctokit, login: string) =>
  unlessStatus([404], () =>
    octokit.rest.users.getByUsername({ username: login }),
  ).pipe(
    Effect.flatMap((found) =>
      found === undefined
        ? Effect.fail(new GitHubAppBotUserNotFound({ login }))
        : Effect.succeed(found.data.id),
    ),
    Effect.retry({
      while: (error) => error instanceof GitHubAppBotUserNotFound,
      schedule: Schedule.spaced("3 seconds"),
      times: 10,
    }),
  );

// `previous` is the stored attributes of the same registration, whose bot
// user ID is reused while the bot login is unchanged. `knownPublic` stands
// when the browser did not read the visibility.
const attrsOf = (options: {
  readonly live: LiveApp;
  readonly knownPublic: boolean;
  readonly secrets: AppSecrets;
  readonly privateKeyPkcs8: Redacted.Redacted<string>;
  readonly octokit: RestOctokit;
  readonly previous: App["Attributes"] | undefined;
}) =>
  Effect.gen(function* () {
    const { live, secrets, previous } = options;
    const slug = live.slug ?? "";
    const botLogin = `${slug}[bot]`;
    return {
      appId: live.id,
      slug,
      name: live.name,
      owner: "login" in live.owner ? live.owner.login : live.owner.slug,
      clientId: live.client_id ?? "",
      ...secrets,
      privateKeyPkcs8: options.privateKeyPkcs8,
      botLogin,
      botUserId:
        previous?.botLogin === botLogin
          ? previous.botUserId
          : yield* botUserId(options.octokit, botLogin),
      htmlUrl: live.html_url,
      permissions: definedPermissions(live.permissions),
      events: [...live.events].sort(),
      public: live.public ?? options.knownPublic,
    } satisfies App["Attributes"];
  });

const appBySlug = (octokit: RestOctokit, slug: string) =>
  unlessStatus([404], () =>
    octokit.rest.apps.getBySlug({ app_slug: slug }),
  ).pipe(Effect.map((found) => found?.data ?? undefined));

// `GET /app` as the app itself. A deleted app rejects its own JWT, so a
// rejection only means "gone" once the slug no longer resolves either. The
// token alone never decides: one that cannot see the app would call a
// living registration gone.
const observeRegistration = (
  app: {
    readonly appId: number;
    readonly slug: string;
    readonly privateKey: Redacted.Redacted<string>;
    readonly owner?: string;
  },
  octokit: RestOctokit,
  baseUrl: string | undefined,
) =>
  Effect.gen(function* () {
    const response = yield* unlessStatus([401, 404], () =>
      appOctokit(
        app.appId,
        app.privateKey,
        baseUrl,
      ).rest.apps.getAuthenticated(),
    );
    if (response?.data) return response.data;
    if ((yield* appBySlug(octokit, app.slug)) !== undefined) {
      return yield* new GitHubAppKeyRejected({
        slug: app.slug,
        url: appSettingsUrl({ owner: app.owner, slug: app.slug, baseUrl }),
      });
    }
    return undefined;
  });

/** Adopting the registration needs a browser session to read its visibility. */
export class GitHubAppVisibilityNeedsBrowser extends Data.TaggedError(
  "GitHubAppVisibilityNeedsBrowser",
)<{
  readonly slug: string;
  readonly url: string;
}> {
  readonly [UserFacingError] = true;
  override get message(): string {
    return `Adopting GitHub App ${this.slug} needs a browser session (GitHub.providers({ browser: true })): no API reports whether it is public, so its visibility is read from its Advanced settings page: ${this.url}`;
  }
}

/** GitHub refused to change the app's visibility. */
export class GitHubAppVisibilityRefused extends Data.TaggedError(
  "GitHubAppVisibilityRefused",
)<{
  readonly slug: string;
  readonly reason: string;
}> {
  readonly [UserFacingError] = true;
  override get message(): string {
    return `GitHub refused to change the visibility of GitHub App ${this.slug}: ${this.reason}.`;
  }
}

const advancedSettingsUrl = (
  owner: string | undefined,
  slug: string,
  baseUrl: string | undefined,
) => appSettingsUrl({ owner, slug, page: "advanced", baseUrl });

// The registration, with its visibility read in the browser session when
// there is one.
const observeApp = (
  app: Parameters<typeof observeRegistration>[0],
  octokit: RestOctokit,
  baseUrl: string | undefined,
) =>
  Effect.gen(function* () {
    const data = yield* observeRegistration(app, octokit, baseUrl);
    if (data === undefined) return undefined;
    const visibility = yield* withBrowser(
      readAppVisibility({
        advancedUrl: advancedSettingsUrl(app.owner, app.slug, baseUrl),
        slug: app.slug,
      }),
    );
    return { ...data, public: Option.getOrUndefined(visibility) };
  });

// Props override stored secrets, so a rotated key can be handed over.
const credentials = (
  news: AppProps,
  output: App["Attributes"],
): AppSecrets => ({
  privateKey: news.privateKey ?? output.privateKey,
  clientSecret: news.clientSecret ?? output.clientSecret,
  webhookSecret: output.webhookSecret,
});

// Signing the app JWT fails opaquely on a malformed key, so the key is
// parsed first to fail with `GitHubAppKeyInvalid`.
const withPkcs8 = (slug: string, secrets: AppSecrets) =>
  appPrivateKeyPkcs8(slug, secrets.privateKey).pipe(
    Effect.map((privateKeyPkcs8) => ({ secrets, privateKeyPkcs8 })),
  );

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// A loopback page that POSTs the manifest to GitHub's registration form, and
// the redirect target GitHub returns to with the conversion `code`.
const manifestServer = (
  props: AppProps,
  registrationUrl: string,
  state: string,
) =>
  Effect.gen(function* () {
    const code = yield* Deferred.make<
      string,
      GitHubAppManifestStateMismatch | GitHubAppManifestCodeMissing
    >();
    let origin = "";
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", origin);
      if (url.pathname === "/") {
        const manifest = appManifest(props, {
          redirectUrl: `${origin}/callback`,
        });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(
          `<!doctype html><title>Register ${escapeHtml(props.name)}</title>` +
            `<form id="manifest" method="post" action="${escapeHtml(registrationUrl)}">` +
            `<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">` +
            `<noscript><button>Continue to GitHub</button></noscript></form>` +
            `<script>document.getElementById("manifest").submit()</script>`,
        );
        return;
      }
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const result = Effect.runSync(
        Effect.result(parseManifestCallback(url.href, state)),
      );
      res.writeHead(result._tag === "Success" ? 200 : 400, {
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end(
        result._tag === "Success"
          ? "GitHub App registered. You can close this tab."
          : result.failure.message,
      );
      Deferred.doneUnsafe(
        code,
        result._tag === "Success"
          ? Effect.succeed(result.success)
          : Effect.fail(result.failure),
      );
    });
    const port = yield* Effect.acquireRelease(
      Effect.callback<number, Error>((resume) => {
        server.once("error", (error) => resume(Effect.fail(error)));
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resume(
            typeof address === "object" && address !== null
              ? Effect.succeed(address.port)
              : Effect.fail(new Error("Manifest server has no port")),
          );
        });
      }),
      () =>
        Effect.sync(() => {
          server.close();
          server.closeAllConnections();
        }),
    );
    origin = `http://127.0.0.1:${port}`;
    return { url: `${origin}/`, code: Deferred.await(code) };
  });

const registerApp = (
  props: AppProps,
  octokit: RestOctokit,
  baseUrl: string | undefined,
) =>
  Effect.gen(function* () {
    const state = randomUUID();
    const registrationUrl = appRegistrationUrl({
      owner: props.owner,
      state,
      baseUrl,
    });
    const local = yield* manifestServer(props, registrationUrl, state);
    const code = yield* manualStep({
      step: "register-app",
      url: registrationUrl,
      open: local.url,
      action: `create GitHub App ${props.name}`,
      instruction: 'Click "Create GitHub App"',
      until: local.code,
      automate: registerAppFromManifest({ manifestUrl: local.url }),
    });
    const { data } = yield* Effect.tryPromise(() =>
      octokit.rest.apps.createFromManifest({ code }),
    );
    return data;
  }).pipe(Effect.scoped);

// Settings only the UI can change. A browser session sets them and the
// registration is observed again; whatever still differs is reported. The
// General settings and the visibility no API reads are only observed in the
// browser, so `olds` and `knownPublic` decide whether a session is worth
// opening for them alone.
const repairAppDrift = (
  news: AppProps,
  olds: AppProps | undefined,
  live: LiveApp,
  knownPublic: boolean,
  privateKey: Redacted.Redacted<string>,
  octokit: RestOctokit,
  baseUrl: string | undefined,
) =>
  Effect.gen(function* () {
    const drift = appDrift(news, live);
    const generalChanges =
      olds === undefined ? [] : changedAppGeneralSettings(olds, news);
    const changedVisibility =
      olds === undefined ? [] : changedAppVisibility(olds, news);
    const visibility =
      changedVisibility.length > 0
        ? changedVisibility
        : appVisibilityDrift(news, knownPublic);
    if (
      drift.length === 0 &&
      olds !== undefined &&
      generalChanges.length === 0 &&
      visibility.length === 0
    ) {
      return { live, drift };
    }
    const slug = live.slug ?? "";
    const fields = new Set(drift.map((f) => f.field));
    const identity =
      fields.has("name") || fields.has("description") || fields.has("url");
    const desiredPublic = news.public ?? false;
    const repaired = yield* withBrowser(
      Effect.gen(function* () {
        const general = yield* syncAppGeneralSettings({
          settingsUrl: appSettingsUrl({ owner: news.owner, slug, baseUrl }),
          ...(identity
            ? {
                name: news.name,
                description: news.description ?? "",
                url: news.url,
              }
            : {}),
          desired: desiredGeneralSettings(news),
        });
        if (fields.has("permissions") || fields.has("events")) {
          yield* updateAppPermissions({
            permissionsUrl: appSettingsUrl({
              owner: news.owner,
              slug,
              page: "permissions",
              baseUrl,
            }),
            permissions: appPermissionChanges(
              news.permissions,
              live.permissions,
            ),
            events: news.events ?? [],
          });
        }
        const outcome = yield* setAppVisibility({
          advancedUrl: advancedSettingsUrl(news.owner, slug, baseUrl),
          slug,
          public: desiredPublic,
        });
        if (!outcome.set) {
          return yield* new GitHubAppVisibilityRefused({
            slug,
            reason: outcome.reason,
          });
        }
        const registration = yield* observeRegistration(
          { appId: live.id, slug, privateKey, owner: news.owner },
          octokit,
          baseUrl,
        );
        const app =
          registration === undefined
            ? undefined
            : { ...registration, public: desiredPublic };
        return { app, general };
      }),
    );
    return Option.match(repaired, {
      onNone: () => ({
        live,
        drift: [...drift, ...generalChanges, ...visibility],
      }),
      onSome: ({ app, general }) => {
        const observed = app ?? live;
        return {
          live: observed,
          drift: [
            ...appDrift(news, observed),
            ...appGeneralSettingsDrift(news, general),
          ],
        };
      },
    });
  });

export const AppProvider = () =>
  Provider.succeed(App, {
    // There is no create API and no transfer API, so the registration is
    // never replaced: every change goes through `reconcile`, which either
    // syncs it, asks the human, or fails with the settings URL.
    reconcile: Effect.fn(function* ({ news, olds, output, session }) {
      yield* validateAppProps(news);
      const octokit = yield* octokitFor(news.baseUrl);
      const baseUrl = yield* effectiveGitHubBaseUrl(news.baseUrl);

      // Observe — only the private key can read the registration.
      const held =
        output === undefined
          ? undefined
          : {
              output,
              ...(yield* withPkcs8(output.slug, credentials(news, output))),
            };
      const registration =
        held === undefined
          ? undefined
          : yield* observeRegistration(
              { ...held.output, ...held.secrets, owner: news.owner },
              octokit,
              baseUrl,
            );
      const observed: LiveApp | undefined =
        registration === undefined
          ? undefined
          : { ...registration, public: undefined };

      // Ensure — a human registers the app from the manifest.
      const registered = observed === undefined;
      const {
        live: found,
        secrets,
        privateKeyPkcs8,
        knownPublic,
      } = observed === undefined || held === undefined
        ? yield* registerApp(news, octokit, baseUrl).pipe(
            Effect.flatMap((data) =>
              withPkcs8(data.slug ?? "", {
                clientSecret: Redacted.make(data.client_secret),
                privateKey: Redacted.make(data.pem),
                webhookSecret:
                  data.webhook_secret === null
                    ? undefined
                    : Redacted.make(data.webhook_secret),
              }).pipe(
                Effect.map((fresh) => ({
                  live: { ...data, public: undefined },
                  ...fresh,
                  knownPublic: news.public ?? false,
                })),
              ),
            ),
          )
        : {
            live: observed,
            secrets: held.secrets,
            privateKeyPkcs8: held.privateKeyPkcs8,
            knownPublic: held.output.public,
          };

      // Sync — registration settings have no API: a browser session sets
      // them, otherwise they are reported.
      const { live, drift } = registered
        ? { live: found, drift: [] }
        : yield* repairAppDrift(
            news,
            olds,
            found,
            knownPublic,
            secrets.privateKey,
            octokit,
            baseUrl,
          );
      const slug = live.slug ?? "";
      if (drift.length > 0) {
        return yield* new GitHubAppDrift({
          slug,
          url: appSettingsUrl({
            owner: news.owner,
            slug,
            page: drift.every((f) => f.field === "public")
              ? "advanced"
              : drift.every(
                    (f) => f.field === "permissions" || f.field === "events",
                  )
                ? "permissions"
                : undefined,
            baseUrl,
          }),
          fields: drift,
        });
      }

      // Sync — webhook delivery config. The secret is write-only, so the
      // full config is always sent.
      const webhook = news.webhook;
      let webhookSecret = secrets.webhookSecret;
      if (webhook !== undefined) {
        // The body goes in `data`: Octokit reads a top-level `url` parameter
        // as the request URL, which would send this PATCH to the webhook.
        const sync = Effect.tryPromise(() =>
          appOctokit(live.id, secrets.privateKey, baseUrl).request(
            "PATCH /app/hook/config",
            {
              data: {
                url: webhook.url,
                content_type: webhook.contentType ?? "json",
                insecure_ssl: webhook.insecureSsl ? "1" : "0",
                ...(webhook.secret === undefined
                  ? {}
                  : { secret: Redacted.value(webhook.secret) }),
              },
            },
          ),
        );
        // The one-time secrets are only stored if reconcile succeeds.
        const applied = yield* registered
          ? sync.pipe(
              Effect.as(true),
              Effect.catch(() =>
                // ponytail: a failed webhook sync on a fresh app is not retried until a prop changes; checkpoint the secrets through State if that matters.
                session
                  .note(
                    `${news.name}: the app was registered, but its webhook config was not applied. Changing a \`webhook\` prop, or redeploying after any prop change, retries it.`,
                  )
                  .pipe(Effect.as(false)),
              ),
            )
          : sync.pipe(Effect.as(true));
        if (applied) webhookSecret = webhook.secret ?? webhookSecret;
      }

      return yield* attrsOf({
        live,
        knownPublic,
        secrets: { ...secrets, webhookSecret },
        privateKeyPkcs8,
        octokit,
        previous: registered ? undefined : output,
      });
    }),

    // With state, the registration is read through its private key and its
    // visibility in the browser session, keeping the stored one without a
    // session. Without state, one found by slug belongs to someone else
    // until `--adopt` takes it over with the key passed in `privateKey`;
    // its visibility can only be read in the browser session.
    read: Effect.fn(function* ({ olds, output }) {
      const octokit = yield* octokitFor(olds.baseUrl);
      const baseUrl = yield* effectiveGitHubBaseUrl(olds.baseUrl);
      if (output !== undefined) {
        const { secrets, privateKeyPkcs8 } = yield* withPkcs8(
          output.slug,
          credentials(olds, output),
        );
        const live = yield* observeApp(
          { ...output, ...secrets, owner: olds.owner },
          octokit,
          baseUrl,
        );
        return live === undefined
          ? undefined
          : yield* attrsOf({
              live,
              knownPublic: output.public,
              secrets,
              privateKeyPkcs8,
              octokit,
              previous: output,
            });
      }
      const slug = appSlug(olds);
      const found = yield* appBySlug(octokit, slug);
      if (found === undefined) return undefined;
      const url = appSettingsUrl({ owner: olds.owner, slug, baseUrl });
      if (olds.privateKey === undefined) {
        return yield* new GitHubAppAdoptionNeedsKey({ slug, url });
      }
      const { secrets, privateKeyPkcs8 } = yield* withPkcs8(slug, {
        privateKey: olds.privateKey,
        clientSecret: olds.clientSecret,
        webhookSecret: undefined,
      });
      const live = yield* observeApp(
        {
          appId: found.id,
          slug,
          privateKey: olds.privateKey,
          owner: olds.owner,
        },
        octokit,
        baseUrl,
      );
      if (live === undefined) return undefined;
      const visibility = live.public;
      if (visibility === undefined) {
        return yield* new GitHubAppVisibilityNeedsBrowser({
          slug,
          url: advancedSettingsUrl(olds.owner, slug, baseUrl),
        });
      }
      return Unowned(
        yield* attrsOf({
          live,
          knownPublic: visibility,
          secrets,
          privateKeyPkcs8,
          octokit,
          previous: undefined,
        }),
      );
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      const octokit = yield* octokitFor(olds.baseUrl);
      const baseUrl = yield* effectiveGitHubBaseUrl(olds.baseUrl);
      const gone = observeRegistration(
        { ...output, ...credentials(olds, output), owner: olds.owner },
        octokit,
        baseUrl,
      ).pipe(Effect.map((live) => (live === undefined ? true : undefined)));
      if (yield* gone) return;
      const advancedUrl = appSettingsUrl({
        owner: olds.owner,
        slug: output.slug,
        page: "advanced",
        baseUrl,
      });
      yield* manualStep({
        step: "delete-app",
        url: advancedUrl,
        action: `delete GitHub App ${output.slug}`,
        instruction: 'Click "Delete GitHub App" under Danger zone',
        until: pollUntilDefined(gone),
        automate: deleteApp({ advancedUrl, slug: output.slug }),
      });
    }),
  });
