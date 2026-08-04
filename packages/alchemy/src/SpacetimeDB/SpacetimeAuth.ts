import * as Effect from "effect/Effect";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import type { Providers } from "./Providers.ts";

/**
 * SpacetimeAuth is SpacetimeDB's managed OIDC provider (beta). Projects are
 * created in the web dashboard; this resource tracks the client configuration
 * your stack needs and exposes typed outputs for Workers / Vite envs.
 *
 * @see https://spacetimedb.com/docs/core-concepts/authentication/spacetimeauth/
 */
export interface SpacetimeAuthProjectProps {
  /**
   * Human-readable project name (for docs / dashboard navigation).
   */
  projectName: string;

  /**
   * OIDC client ID issued when you create a client in the SpacetimeAuth
   * dashboard.
   */
  clientId: string;

  /**
   * OIDC issuer URL for the project (from the SpacetimeAuth dashboard).
   * Typically `https://auth.spacetimedb.com/<project>` or similar.
   */
  issuer: string;

  /**
   * Authorized redirect URIs registered on the client.
   */
  redirectUris?: string[];

  /**
   * Optional audience / API identifier.
   */
  audience?: string;

  /**
   * Scopes requested by the client.
   *
   * @default ["openid", "profile"]
   */
  scopes?: string[];

  /**
   * Dashboard path segment for deep-linking (project slug). When set,
   * `dashboardUrl` points at the SpacetimeAuth project page.
   */
  projectSlug?: string;
}

export interface SpacetimeAuthProjectAttributes {
  projectName: string;
  clientId: string;
  issuer: string;
  audience: string | undefined;
  scopes: string[];
  redirectUris: string[];
  /**
   * SpacetimeAuth dashboard URL for this project.
   */
  dashboardUrl: string;
  /**
   * Convenience: OpenID configuration document URL.
   */
  openIdConfigUrl: string;
}

export type SpacetimeAuthProject = Resource<
  "SpacetimeDB.SpacetimeAuthProject",
  SpacetimeAuthProjectProps,
  SpacetimeAuthProjectAttributes,
  never,
  Providers
>;

/**
 * Track a SpacetimeAuth (OIDC) project configuration in your stack.
 *
 * SpacetimeAuth projects are provisioned in the
 * [web dashboard](https://spacetimedb.com) (beta — no public create API yet).
 * This resource is **config-as-code**: it validates and persists the client
 * coordinates, exposes them as outputs for Vite/`Worker` env bindings, and
 * links to the dashboard.
 *
 * @resource
 * @see https://spacetimedb.com/docs/core-concepts/authentication/spacetimeauth/
 *
 * @section Wire into a Vite SPA
 * @example Bind Auth Outputs to a Vite SPA
 * ```typescript
 * const auth = yield* SpacetimeDB.SpacetimeAuthProject("Auth", {
 *   projectName: "my-game",
 *   clientId: process.env.SPACETIMEAUTH_CLIENT_ID!,
 *   issuer: "https://auth.spacetimedb.com/my-game",
 *   redirectUris: ["http://localhost:5173/callback"],
 * });
 *
 * yield* Cloudflare.Website.Vite("Web", {
 *   env: {
 *     VITE_SPACETIMEAUTH_CLIENT_ID: auth.clientId,
 *     VITE_SPACETIMEAUTH_ISSUER: auth.issuer,
 *   },
 * });
 * ```
 */
export const SpacetimeAuthProject = Resource<SpacetimeAuthProject>(
  "SpacetimeDB.SpacetimeAuthProject",
  { aliases: ["SpacetimeDB.SpacetimeAuth"] },
);

const AUTH_DASHBOARD = "https://spacetimedb.com/login";

export const SpacetimeAuthProjectProvider = () =>
  Provider.succeed(SpacetimeAuthProject, {
    stables: ["clientId", "issuer"],
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news) || !olds) return undefined;
      if (
        news.clientId !== olds.clientId ||
        news.issuer !== olds.issuer ||
        news.projectName !== olds.projectName
      ) {
        // clientId/issuer identify the physical OIDC client — changing them
        // is a replacement of the config binding, not an in-place edit of a
        // cloud object we own.
        return { action: "replace" } as const;
      }
      const oldScopes = (olds.scopes ?? ["openid", "profile"]).join(",");
      const newScopes = (news.scopes ?? ["openid", "profile"]).join(",");
      if (
        oldScopes !== newScopes ||
        (news.audience ?? null) !== (olds.audience ?? null) ||
        (news.redirectUris ?? []).join(",") !==
          (olds.redirectUris ?? []).join(",") ||
        (news.projectSlug ?? news.projectName) !==
          (olds.projectSlug ?? olds.projectName)
      ) {
        return { action: "update" } as const;
      }
      return undefined;
    }),
    reconcile: Effect.fn(function* ({ news }) {
      if (!news.clientId?.trim()) {
        return yield* Effect.die(
          new Error("SpacetimeAuth.clientId is required"),
        );
      }
      if (!news.issuer?.trim()) {
        return yield* Effect.die(new Error("SpacetimeAuth.issuer is required"));
      }
      const scopes = news.scopes ?? ["openid", "profile"];
      const issuer = news.issuer.replace(/\/+$/, "");
      const slug = news.projectSlug ?? news.projectName;
      return {
        projectName: news.projectName,
        clientId: news.clientId,
        issuer,
        audience: news.audience,
        scopes,
        redirectUris: news.redirectUris ?? [],
        dashboardUrl: `${AUTH_DASHBOARD}?project=${encodeURIComponent(slug)}`,
        openIdConfigUrl: `${issuer}/.well-known/openid-configuration`,
      } satisfies SpacetimeAuthProjectAttributes;
    }),
    // Config-only — nothing to delete in the cloud.
    delete: () => Effect.void,
  });
