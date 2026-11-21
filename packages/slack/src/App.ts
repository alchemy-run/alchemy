import * as Apps from "@distilled.cloud/slack/apps";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { withAppConfigToken } from "./Credentials.ts";
import type { Providers } from "./Providers.ts";

/**
 * A Slack app manifest: the app's whole configuration, in Slack's own
 * snake_case format, so a manifest copied from Slack's docs or the app
 * settings page ("App Manifest") works as-is.
 *
 * Only the common sections are typed. Anything else Slack accepts can be
 * added under the same keys.
 *
 * @see https://docs.slack.dev/reference/app-manifest
 */
export interface AppManifest {
  _metadata?: { major_version?: number; minor_version?: number };
  display_information?: {
    /**
     * App name, at most 35 characters. If omitted, a unique name is
     * generated from the app, stage and logical ID.
     */
    name?: string;
    description?: string;
    long_description?: string;
    /** Background color of the app's tile, as a hex code (`#2c2d30`). */
    background_color?: string;
  };
  features?: {
    bot_user?: { display_name: string; always_online?: boolean };
    app_home?: {
      home_tab_enabled?: boolean;
      messages_tab_enabled?: boolean;
      messages_tab_read_only_enabled?: boolean;
    };
    slash_commands?: Array<{
      command: string;
      description: string;
      url?: string;
      usage_hint?: string;
      should_escape?: boolean;
    }>;
    shortcuts?: Array<{
      name: string;
      type: "message" | "global";
      callback_id: string;
      description: string;
    }>;
    unfurl_domains?: string[];
    assistant_view?: { assistant_description: string; suggested_prompts?: unknown[] };
    [feature: string]: unknown;
  };
  oauth_config?: {
    scopes?: { bot?: string[]; user?: string[] };
    redirect_urls?: string[];
    token_management_enabled?: boolean;
  };
  settings?: {
    event_subscriptions?: {
      /** Public URL Slack posts Events API deliveries to. */
      request_url?: string;
      bot_events?: string[];
      user_events?: string[];
    };
    interactivity?: {
      is_enabled: boolean;
      request_url?: string;
      message_menu_options_url?: string;
    };
    org_deploy_enabled?: boolean;
    socket_mode_enabled?: boolean;
    token_rotation_enabled?: boolean;
    allowed_ip_address_ranges?: string[];
    function_runtime?: "remote" | "slack";
    [setting: string]: unknown;
  };
  [section: string]: unknown;
}

export interface AppProps {
  /**
   * The app's manifest. Every deploy sends the whole manifest
   * (`apps.manifest.update` replaces the configuration), so settings changed
   * in the app's settings page are reset to what the manifest says.
   */
  manifest: AppManifest;
}

export interface AppAttributes {
  /** App ID (`A…`). */
  appId: string;
  /** Workspace the app was created in. */
  teamId: string;
  /** OAuth client ID. */
  clientId: string;
  /**
   * OAuth client secret. Slack returns it only when the app is created, so an
   * adopted app has none.
   */
  clientSecret: Redacted.Redacted<string> | undefined;
  /**
   * Signing secret Slack signs every request to the app's URLs with. Slack
   * returns it only when the app is created, so an adopted app has none.
   */
  signingSecret: Redacted.Redacted<string> | undefined;
  /** Legacy verification token (prefer `signingSecret`). */
  verificationToken: Redacted.Redacted<string> | undefined;
  /**
   * URL that installs the app to a workspace with the manifest's scopes. Open
   * it once: Slack only issues a bot token after a person approves the install.
   */
  oauthAuthorizeUrl: string;
  /** The manifest as deployed. */
  manifest: AppManifest;
}

export type App = Resource<"Slack.App", AppProps, AppAttributes, never, Providers>;

/**
 * A Slack app, managed through the App Manifest API: its name, bot user,
 * scopes, slash commands, event subscriptions and interactivity URLs.
 *
 * The App Manifest API needs an **app configuration token**, which the Slack
 * profile keeps as a refresh token (`alchemy profile edit --add Slack`);
 * Alchemy rotates it as it expires. The app is created in the workspace the
 * configuration token belongs to.
 *
 * Creating an app does not install it: Slack issues a bot token only after a
 * person approves the install. Open `oauthAuthorizeUrl` once, then capture
 * the token with {@link BotToken}. Slack apps carry no tags, and there is no
 * API to list them, so `alchemy unsafe nuke` can't find leaked apps.
 *
 * ### Creating an App
 * **Example:** A bot that can post and read mentions
 * ```typescript
 * const app = yield* Slack.App("Bot", {
 *   manifest: {
 *     display_information: { name: "Deploy Bot" },
 *     features: { bot_user: { display_name: "deploy-bot", always_online: true } },
 *     oauth_config: {
 *       scopes: { bot: ["chat:write", "app_mentions:read", "channels:read"] },
 *     },
 *   },
 * });
 * ```
 *
 * **Example:** A slash command served by your own endpoint
 * ```typescript
 * const app = yield* Slack.App("Ops", {
 *   manifest: {
 *     features: {
 *       bot_user: { display_name: "ops" },
 *       slash_commands: [
 *         {
 *           command: "/deploy",
 *           description: "Deploy a service",
 *           url: "https://ops.example.com/slack/commands",
 *         },
 *       ],
 *     },
 *     oauth_config: { scopes: { bot: ["commands"] } },
 *   },
 * });
 * ```
 *
 * ### Receiving Events
 * To point the app's Events API URL at a Worker, let {@link consumeEvents}
 * create the app inside the Worker: it sets `request_url` to the Worker's URL
 * and binds the signing secret into it.
 *
 * @resource
 * @product App
 */
export const App = Resource<App>("Slack.App");

/** The manifest with a generated name when none is set. */
const desiredManifest = (id: string, manifest: AppManifest) =>
  Effect.gen(function* () {
    const name =
      manifest.display_information?.name ?? (yield* createPhysicalName({ id, maxLength: 35 }));
    return {
      ...manifest,
      _metadata: manifest._metadata ?? { major_version: 1, minor_version: 1 },
      display_information: { ...manifest.display_information, name },
    } satisfies AppManifest;
  });

/** Whether every value `desired` sets is the same in `observed`. */
const covers = (observed: unknown, desired: unknown): boolean => {
  if (Array.isArray(desired)) {
    return (
      Array.isArray(observed) &&
      observed.length === desired.length &&
      desired.every((value, index) => covers(observed[index], value))
    );
  }
  if (desired !== null && typeof desired === "object") {
    if (observed === null || typeof observed !== "object") return false;
    return Object.entries(desired).every(
      ([key, value]) =>
        value === undefined || covers((observed as Record<string, unknown>)[key], value),
    );
  }
  return observed === desired;
};

const asRedacted = (value: string | Redacted.Redacted<string> | undefined) =>
  value === undefined ? undefined : Redacted.isRedacted(value) ? value : Redacted.make(value);

/** The deployed manifest, or `undefined` once the app is gone. */
const exportManifest = (appId: string) =>
  Apps.exportManifest({ app_id: appId }).pipe(
    Effect.map((response) => response.manifest as AppManifest),
    Effect.catchTag(["AppNotFound", "InvalidAppId"], () => Effect.undefined),
  );

/**
 * Whether Slack rejected the manifest because a request URL didn't answer
 * its `url_verification` challenge yet — a Worker deployed seconds ago may
 * not be reachable, so the call is retried.
 */
const isUnverifiedUrl = (error: { readonly _tag: string; readonly body?: unknown }) =>
  error._tag === "InvalidManifest" && JSON.stringify(error.body ?? "").includes("request_url");

const verificationRetry = {
  while: isUnverifiedUrl,
  times: 8,
  schedule: Schedule.exponential(Duration.seconds(2), 1.5),
} as const;

export const AppProvider = () =>
  Provider.succeed(App, {
    stables: ["appId", "teamId", "clientId", "clientSecret", "signingSecret", "verificationToken"],

    // Apps can't be listed through the Web API.
    list: () => Effect.succeed([]),

    read: Effect.fn(function* ({ output }) {
      if (output?.appId === undefined) return undefined;
      const manifest = yield* withAppConfigToken(exportManifest(output.appId));
      return manifest === undefined ? undefined : { ...output, manifest };
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const manifest = yield* desiredManifest(id, news.manifest);
      return yield* withAppConfigToken(
        Effect.gen(function* () {
          // Observe — the app ID is server-assigned; the cached one is our
          // only handle, and an app deleted out of band reads as missing.
          const observed =
            output?.appId !== undefined ? yield* exportManifest(output.appId) : undefined;

          // Ensure — create the app from the manifest.
          if (output === undefined || observed === undefined) {
            const created = yield* Apps.createManifest({
              manifest: JSON.stringify(manifest),
            }).pipe(Effect.retry(verificationRetry));
            return {
              appId: created.app_id,
              teamId: created.team_id ?? "",
              clientId: created.credentials.client_id ?? "",
              clientSecret: asRedacted(created.credentials.client_secret),
              signingSecret: asRedacted(created.credentials.signing_secret),
              verificationToken: asRedacted(created.credentials.verification_token),
              oauthAuthorizeUrl: created.oauth_authorize_url ?? "",
              manifest: (yield* exportManifest(created.app_id)) ?? manifest,
            } satisfies AppAttributes;
          }

          // Sync — send the manifest only when the deployed one differs.
          if (!covers(observed, manifest)) {
            yield* Apps.updateManifest({
              app_id: output.appId,
              manifest: JSON.stringify(manifest),
            }).pipe(Effect.retry(verificationRetry));
          }
          return {
            ...output,
            manifest: (yield* exportManifest(output.appId)) ?? manifest,
          } satisfies AppAttributes;
        }),
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* withAppConfigToken(
        Apps.deleteManifest({ app_id: output.appId }).pipe(
          Effect.catchTag(["AppNotFound", "InvalidAppId"], () => Effect.void),
        ),
      );
    }),
  });
