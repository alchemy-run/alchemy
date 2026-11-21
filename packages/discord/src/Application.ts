import * as discord from "@distilled.cloud/discord/discord";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { sameJson } from "./internal/Discord.ts";
import type { Providers } from "./Providers.ts";

/** Default install link settings for one way of installing the app. */
export interface InstallParams {
  /** OAuth2 scopes, e.g. `["bot", "applications.commands"]`. */
  scopes: string[];
  /** Permissions the bot asks for, as a decimal string. */
  permissions?: string;
}

export interface ApplicationProps {
  /** Description on the app's profile, up to 400 characters. */
  description?: string;
  /** Up to 5 tags describing the app (20 characters each). */
  tags?: string[];
  /** Icon, as a data URI. Sent when it changes from the last deploy. */
  icon?: string;
  /** Rich Presence cover image, as a data URI. Sent when it changes. */
  coverImage?: string;
  /**
   * The app's install link settings per install kind. Discord's own "Add
   * App" button uses them.
   */
  installParams?: {
    /** Installing to a server (the bot). */
    guildInstall?: InstallParams;
    /** Installing to a user account (user-installed commands). */
    userInstall?: InstallParams;
  };
  /** A custom install URL instead of Discord's default link. */
  customInstallUrl?: string;
  /** Linked Roles verification URL (see `RoleConnectionMetadata`). */
  roleConnectionsVerificationUrl?: string;
  /**
   * Public flags to set, e.g. `GATEWAY_MESSAGE_CONTENT_LIMITED` (1 << 19).
   * Only the limited (unverified) intent flags are settable.
   */
  flags?: number;
}

export interface ApplicationAttributes {
  /** Application id (also the OAuth2 client id). */
  applicationId: string;
  /** Application name (set in the Developer Portal). */
  name: string;
  /** Hex Ed25519 public key that signs interaction and event webhooks. */
  publicKey: string;
  /** The bot user's id. */
  botUserId: string | undefined;
  /** Link that installs the bot into a server with its default permissions. */
  installUrl: string;
  /** The settings before the stack managed them; destroy restores them. */
  initial: Record<string, unknown>;
}

/**
 * The settings of the Discord application the bot token belongs to:
 * description, tags, install links and the Linked Roles URL.
 *
 * There is one per token, and the Developer Portal creates it; this manages
 * its settings. Only the settings you set are managed: the first deploy
 * records their original values and destroy restores them. The interactions
 * endpoint and event webhooks have their own resources
 * (`InteractionsEndpoint`, `EventWebhook`), which the event sources declare.
 *
 * ### Configuring the Application
 * **Example:** Profile and install link
 * ```typescript
 * const app = yield* Discord.Application("App", {
 *   description: "Deploy notifications and slash commands for Alchemy",
 *   tags: ["devops", "deploys"],
 *   installParams: {
 *     guildInstall: {
 *       scopes: ["bot", "applications.commands"],
 *       permissions: Discord.combinePermissions(
 *         Discord.Permissions.SendMessages,
 *         Discord.Permissions.EmbedLinks,
 *       ),
 *     },
 *   },
 * });
 * // app.installUrl adds the bot to a server
 * ```
 *
 * @resource
 * @product Application
 */
export interface Application extends Resource<
  "Discord.Application",
  ApplicationProps,
  ApplicationAttributes,
  never,
  Providers
> {}

export const Application = Resource<Application>("Discord.Application");

type App = discord.PrivateApplicationResponse;

const installParamsBody = (p: InstallParams | undefined) =>
  p === undefined
    ? undefined
    : {
        oauth2_install_params: {
          scopes: p.scopes,
          permissions: p.permissions === undefined ? undefined : Number(p.permissions),
        },
      };

/** Wire fields the props set (icon and cover image are handled apart). */
const desired = (news: ApplicationProps): Record<string, unknown> => {
  const body: Record<string, unknown> = {};
  if (news.description !== undefined) body.description = news.description;
  if (news.tags !== undefined) body.tags = news.tags;
  if (news.customInstallUrl !== undefined) body.custom_install_url = news.customInstallUrl;
  if (news.roleConnectionsVerificationUrl !== undefined) {
    body.role_connections_verification_url = news.roleConnectionsVerificationUrl;
  }
  if (news.flags !== undefined) body.flags = news.flags;
  if (news.installParams !== undefined) {
    body.integration_types_config = {
      ...(news.installParams.guildInstall
        ? { "0": installParamsBody(news.installParams.guildInstall) }
        : {}),
      ...(news.installParams.userInstall
        ? { "1": installParamsBody(news.installParams.userInstall) }
        : {}),
    };
  }
  return body;
};

const observedValue = (app: App, wire: string): unknown => {
  const value = (app as unknown as Record<string, unknown>)[wire];
  if (wire !== "integration_types_config" || value === undefined) return value ?? null;
  // Normalize `{ "0": { oauth2_install_params: { scopes, permissions: "8" } } }`
  // to the request shape (permissions as numbers).
  return Object.fromEntries(
    Object.entries(value as Record<string, any>)
      .filter(([, v]) => v?.oauth2_install_params)
      .map(([k, v]) => [
        k,
        {
          oauth2_install_params: {
            scopes: v.oauth2_install_params.scopes,
            permissions: Number(v.oauth2_install_params.permissions),
          },
        },
      ]),
  );
};

const toAttributes = (app: App, initial: Record<string, unknown>): ApplicationAttributes => ({
  applicationId: app.id,
  name: app.name,
  publicKey: app.verify_key,
  botUserId: app.bot?.id,
  installUrl: `https://discord.com/oauth2/authorize?client_id=${app.id}`,
  initial,
});

export const ApplicationProvider = () =>
  Provider.succeed(Application, {
    nuke: { singleton: true },
    stables: ["applicationId", "publicKey", "botUserId", "installUrl"],

    read: Effect.fn(function* ({ output }) {
      const app = yield* discord.getMyApplication({});
      return toAttributes(app, output?.initial ?? {});
    }),

    reconcile: Effect.fn(function* ({ news, olds, output }) {
      const app = yield* discord.getMyApplication({});
      const want = desired(news);
      const initial = { ...output?.initial };
      for (const wire of Object.keys(want)) {
        if (!(wire in initial)) initial[wire] = observedValue(app, wire);
      }
      const patch: Record<string, unknown> = {};
      for (const [wire, value] of Object.entries(want)) {
        if (!sameJson(observedValue(app, wire), value)) patch[wire] = value;
      }
      if (news.icon !== undefined && news.icon !== olds?.icon) patch.icon = news.icon;
      if (news.coverImage !== undefined && news.coverImage !== olds?.coverImage) {
        patch.cover_image = news.coverImage;
      }
      if (Object.keys(patch).length === 0) return toAttributes(app, initial);
      const updated = yield* discord.updateMyApplication(
        patch as discord.UpdateMyApplicationRequest,
      );
      return toAttributes(updated, initial);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (Object.keys(output.initial).length === 0) return;
      yield* discord.updateMyApplication(output.initial as discord.UpdateMyApplicationRequest);
    }),

    list: () => Effect.succeed([]),
  });
