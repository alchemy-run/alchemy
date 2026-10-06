import type { Octokit as RestOctokit } from "@octokit/rest";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { randomUUID } from "node:crypto";
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
  deleteApp,
  registerAppFromManifest,
  updateAppPermissions,
  updateAppSettings,
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
   * Request user authorization (OAuth) during installation. GitHub never
   * returns it.
   * @default false
   */
  requestOauthOnInstall?: boolean;
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
    webhookSecret: Redacted.Redacted<string> | undefined;
    /** Public page of the app, `https://github.com/apps/<slug>`. */
    htmlUrl: string;
    permissions: Record<string, string>;
    events: string[];
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
 * Apps register private; visibility is managed in GitHub's UI only.
 *
 * Later deploys never prompt. Webhook settings are synced through the API.
 * Any other difference from the live registration (name, description, URL,
 * permissions, events) is repaired through the browser session when there
 * is one, and otherwise fails with `GitHubAppDrift` and the settings URL to
 * fix it at.
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
 * URL cannot be filled in by a later step.
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
 *   bindings: { APP_ID: app.appId, PRIVATE_KEY: app.privateKey, WEBHOOK_SECRET: secret.text },
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

export interface AppDriftField {
  readonly field:
    | "name"
    | "description"
    | "url"
    | "permissions"
    | "events"
    | "requestOauthOnInstall";
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
    return `GitHub has no API to change GitHub App ${this.slug}. In your browser, set ${changes}, then deploy again: ${this.url}`;
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
  public: false,
  default_permissions: props.permissions,
  default_events: props.events,
  hook_attributes:
    props.webhook === undefined ? undefined : { url: props.webhook.url },
  redirect_url: options.redirectUrl,
  request_oauth_on_install: props.requestOauthOnInstall ?? false,
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
}

type AppSecrets = Pick<
  App["Attributes"],
  "clientSecret" | "privateKey" | "webhookSecret"
>;

const attrsOf = (live: LiveApp, secrets: AppSecrets): App["Attributes"] => ({
  appId: live.id,
  slug: live.slug ?? "",
  name: live.name,
  owner: "login" in live.owner ? live.owner.login : live.owner.slug,
  clientId: live.client_id ?? "",
  ...secrets,
  htmlUrl: live.html_url,
  permissions: definedPermissions(live.permissions),
  events: [...live.events].sort(),
});

const appBySlug = (octokit: RestOctokit, slug: string) =>
  unlessStatus([404], () =>
    octokit.rest.apps.getBySlug({ app_slug: slug }),
  ).pipe(Effect.map((found) => found?.data ?? undefined));

// `GET /app` as the app itself. A deleted app rejects its own JWT, so a
// rejection only means "gone" once the slug no longer resolves either. The
// token alone never decides: one that cannot see the app would call a
// living registration gone.
const observeApp = (
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

// Props override stored secrets, so a rotated key can be handed over.
const credentials = (
  news: AppProps,
  output: App["Attributes"],
): AppSecrets => ({
  privateKey: news.privateKey ?? output.privateKey,
  clientSecret: news.clientSecret ?? output.clientSecret,
  webhookSecret: output.webhookSecret,
});

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
// registration is observed again; whatever still differs is reported.
const repairAppDrift = (
  news: AppProps,
  live: LiveApp,
  privateKey: Redacted.Redacted<string>,
  octokit: RestOctokit,
  baseUrl: string | undefined,
) =>
  Effect.gen(function* () {
    const drift = appDrift(news, live);
    if (drift.length === 0) return { live, drift };
    const slug = live.slug ?? "";
    const fields = new Set(drift.map((f) => f.field));
    const repaired = yield* withBrowser(
      Effect.gen(function* () {
        if (
          fields.has("name") ||
          fields.has("description") ||
          fields.has("url")
        ) {
          yield* updateAppSettings({
            settingsUrl: appSettingsUrl({ owner: news.owner, slug, baseUrl }),
            name: news.name,
            description: news.description ?? "",
            url: news.url,
          });
        }
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
        return yield* observeApp(
          { appId: live.id, slug, privateKey, owner: news.owner },
          octokit,
          baseUrl,
        );
      }),
    );
    const observed = Option.getOrUndefined(repaired) ?? live;
    return { live: observed, drift: appDrift(news, observed) };
  });

export const AppProvider = () =>
  Provider.succeed(App, {
    // There is no create API and no transfer API, so the registration is
    // never replaced: every change goes through `reconcile`, which either
    // syncs it, asks the human, or fails with the settings URL.
    reconcile: Effect.fn(function* ({ news, output, session }) {
      if (news.events?.length && news.webhook === undefined) {
        return yield* new GitHubAppEventsRequireWebhook({
          message: `GitHub App ${news.name} subscribes to events (${news.events.join(", ")}) but has no webhook. Set \`webhook.url\`, or remove \`events\`.`,
        });
      }
      const octokit = yield* octokitFor(news.baseUrl);
      const baseUrl = yield* effectiveGitHubBaseUrl(news.baseUrl);

      // Observe — only the private key can read the registration.
      const observed: LiveApp | undefined =
        output === undefined
          ? undefined
          : yield* observeApp(
              { ...output, ...credentials(news, output), owner: news.owner },
              octokit,
              baseUrl,
            );

      // Ensure — a human registers the app from the manifest.
      const registered = observed === undefined;
      const { live: found, secrets } =
        observed === undefined || output === undefined
          ? yield* registerApp(news, octokit, baseUrl).pipe(
              Effect.map((data) => ({
                live: data,
                secrets: {
                  clientSecret: Redacted.make(data.client_secret),
                  privateKey: Redacted.make(data.pem),
                  webhookSecret:
                    data.webhook_secret === null
                      ? undefined
                      : Redacted.make(data.webhook_secret),
                } satisfies AppSecrets,
              })),
            )
          : { live: observed, secrets: credentials(news, output) };

      // Sync — registration settings have no API: a browser session sets
      // them, otherwise they are reported.
      const { live, drift } = registered
        ? { live: found, drift: [] }
        : yield* repairAppDrift(
            news,
            found,
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
            page: drift.every(
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

      return attrsOf(live, { ...secrets, webhookSecret });
    }),

    // With state, the registration is read through its private key. Without
    // state, one found by slug belongs to someone else until `--adopt`
    // takes it over with the key passed in `privateKey`.
    read: Effect.fn(function* ({ olds, output }) {
      const octokit = yield* octokitFor(olds.baseUrl);
      const baseUrl = yield* effectiveGitHubBaseUrl(olds.baseUrl);
      if (output !== undefined) {
        const secrets = credentials(olds, output);
        const live = yield* observeApp(
          { ...output, ...secrets, owner: olds.owner },
          octokit,
          baseUrl,
        );
        return live === undefined ? undefined : attrsOf(live, secrets);
      }
      const slug = appSlug(olds);
      const found = yield* appBySlug(octokit, slug);
      if (found === undefined) return undefined;
      const url = appSettingsUrl({ owner: olds.owner, slug, baseUrl });
      if (olds.privateKey === undefined) {
        return yield* new GitHubAppAdoptionNeedsKey({ slug, url });
      }
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
      return Unowned(
        attrsOf(live, {
          privateKey: olds.privateKey,
          clientSecret: olds.clientSecret,
          webhookSecret: undefined,
        }),
      );
    }),

    delete: Effect.fn(function* ({ olds, output }) {
      const octokit = yield* octokitFor(olds.baseUrl);
      const baseUrl = yield* effectiveGitHubBaseUrl(olds.baseUrl);
      const gone = observeApp(
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
