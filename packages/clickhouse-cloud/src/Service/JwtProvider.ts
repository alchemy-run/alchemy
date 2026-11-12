import * as service from "@distilled.cloud/clickhouse-cloud/service";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { requireResult } from "../Errors.ts";
import type { Providers } from "../Providers.ts";

export interface JwtProviderProps {
  /** ID of the service, e.g. a `ClickHouseCloud.Service.Service`'s `serviceId`. Changing it replaces the provider. */
  serviceId: string;
  /**
   * Provider name: lowercase letters, digits and hyphens, up to 59
   * characters. Changing it replaces the provider.
   */
  name: string;
  /** Issuer (`iss`) the tokens must carry. */
  issuer: string;
  /** Audience (`aud`) the tokens must carry. */
  audience: string;
  /** URL of the issuer's JWKS (RS256 keys); fetched and validated when saved. */
  jwksUrl: string;
  /** Claim holding the ClickHouse roles the user gets. Omit for none. */
  rolesClaim?: string;
}

export interface JwtProviderAttributes {
  /** Service ID. */
  serviceId: string;
  /** Organization ID. */
  organizationId: string;
  /** Provider name. */
  name: string;
  /** Issuer. */
  issuer: string;
  /** Audience. */
  audience: string;
  /** JWKS URL. */
  jwksUrl: string;
  /** Roles claim. */
  rolesClaim: string | undefined;
}

export type JwtProvider = Resource<
  "ClickHouseCloud.Service.JwtProvider",
  JwtProviderProps,
  JwtProviderAttributes,
  never,
  Providers
>;

/**
 * A JWT authentication provider on a service: clients connect with a JWT
 * from the issuer (an identity provider, GitHub Actions, a cloud's workload
 * identity) instead of a password, signed in as `default` with the roles in
 * `rolesClaim`. The endpoint is in beta.
 *
 * A service holds up to five providers. Every prop but the name and service
 * updates the provider in place. Needs the Enterprise tier.
 * @see https://clickhouse.com/docs/cloud/security/jwt-authentication
 *
 * ### Signing In with JWTs
 * **Example:** Trust GitHub Actions tokens for one repository's workflows
 * ```typescript
 * const analytics = yield* ClickHouseCloud.Service.Service("Analytics", {
 *   provider: "aws",
 *   region: "us-east-1",
 *   ipAccessList: [{ source: "0.0.0.0/0" }],
 * });
 * yield* ClickHouseCloud.Service.JwtProvider("GitHubActions", {
 *   serviceId: analytics.serviceId,
 *   name: "github-actions",
 *   issuer: "https://token.actions.githubusercontent.com",
 *   audience: "clickhouse",
 *   jwksUrl: "https://token.actions.githubusercontent.com/.well-known/jwks",
 *   rolesClaim: "clickhouse_roles",
 * });
 * ```
 *
 * :::caution
 * Changing `serviceId` or `name` replaces the provider: clients configured
 * for the old one stop signing in.
 * :::
 *
 * @resource
 * @product Service
 */
export const JwtProvider = Resource<JwtProvider>("ClickHouseCloud.Service.JwtProvider");

const toAttributes = (
  organizationId: string,
  serviceId: string,
  provider: service.JwtProvider,
): JwtProviderAttributes => ({
  serviceId,
  organizationId,
  name: provider.name,
  issuer: provider.issuer,
  audience: provider.audience,
  jwksUrl: provider.jwksUrl,
  rolesClaim: provider.rolesClaim,
});

const getProvider = (organizationId: string, serviceId: string, name: string) =>
  service.getJwtProvider({ organizationId, serviceId, jwtProviderName: name }).pipe(
    Effect.flatMap(requireResult("getJwtProvider")),
    Effect.catchTag("NotFound", () => Effect.undefined),
  );

export const JwtProviderProvider = () =>
  Provider.effect(
    JwtProvider,
    Effect.succeed({
      stables: ["serviceId", "organizationId", "name"],
      nuke: { singleton: true, dependsOn: ["ClickHouseCloud.Service.Service"] },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (news.serviceId !== olds.serviceId || news.name !== olds.name) {
          return { action: "replace" } as const;
        }
        return undefined;
      }),
      read: Effect.fn(function* ({ olds, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const serviceId = output?.serviceId ?? olds.serviceId;
        const provider = yield* getProvider(organizationId, serviceId, output?.name ?? olds.name);
        return provider === undefined
          ? undefined
          : toAttributes(organizationId, serviceId, provider);
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const { serviceId, name } = news;
        const config = {
          issuer: news.issuer,
          audience: news.audience,
          jwksUrl: news.jwksUrl,
          rolesClaim: news.rolesClaim,
        };
        // Observe
        const observed = yield* getProvider(organizationId, serviceId, name);
        // Ensure: create is idempotent for an identical configuration.
        if (observed === undefined) {
          const created = yield* service
            .createJwtProvider({ organizationId, serviceId, name, ...config })
            .pipe(Effect.flatMap(requireResult("createJwtProvider")));
          return toAttributes(organizationId, serviceId, created);
        }
        // Sync: the update is a PUT carrying every field.
        if (
          observed.issuer === config.issuer &&
          observed.audience === config.audience &&
          observed.jwksUrl === config.jwksUrl &&
          (observed.rolesClaim ?? undefined) === config.rolesClaim
        ) {
          return toAttributes(organizationId, serviceId, observed);
        }
        const updated = yield* service
          .updateJwtProvider({ organizationId, serviceId, jwtProviderName: name, ...config })
          .pipe(Effect.flatMap(requireResult("updateJwtProvider")));
        return toAttributes(organizationId, serviceId, updated);
      }),
      delete: Effect.fn(function* ({ output }) {
        yield* service
          .deleteJwtProvider({
            organizationId: output.organizationId,
            serviceId: output.serviceId,
            jwtProviderName: output.name,
          })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
      }),
    }),
  );
