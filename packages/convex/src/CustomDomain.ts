import * as management from "@distilled.cloud/convex/management";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { team } from "./Credentials.ts";
import type { DeploymentAttributes } from "./Deployment.ts";
import { createOnce } from "./internal/retry.ts";
import { assertTeam } from "./internal/team.ts";
import type { Providers } from "./Providers.ts";

export interface CustomDomainProps {
  /** The deployment to serve. Changing it replaces the domain. */
  deployment: Pick<DeploymentAttributes, "deploymentName">;
  /** The hostname, such as `api.example.com`. Changing it replaces the domain. */
  domain: string;
  /**
   * What the domain serves: `convexCloud` for the API or `convexSite` for HTTP
   * actions. Changing it replaces the domain.
   */
  requestDestination: "convexCloud" | "convexSite";
}

export interface CustomDomainAttributes {
  /** The deployment this domain serves. */
  deploymentName: string;
  /** Numeric ID of the owning team. */
  teamId: number;
  /** The hostname. */
  domain: string;
  /** What the domain serves. */
  requestDestination: string;
  /** When Convex verified the domain, in milliseconds, or undefined until it has. */
  verificationTime: number | undefined;
}

export type CustomDomain = Resource<
  "Convex.CustomDomain",
  CustomDomainProps,
  CustomDomainAttributes,
  never,
  Providers
>;

/**
 * A custom domain on a Convex deployment.
 *
 * :::caution
 * Custom domains need the Convex Professional plan. Below it, a deploy fails
 * with `VanityDomainsDisabled`.
 * :::
 *
 * ### Adding a Domain
 * **Example:** Serve the API from your own domain
 * ```typescript
 * yield* Convex.CustomDomain("Api", {
 *   deployment,
 *   domain: "api.example.com",
 *   requestDestination: "convexCloud",
 * });
 * ```
 *
 * @see https://docs.convex.dev/production/hosting/custom
 *
 * @resource
 * @product Deployment
 */
export const CustomDomain = Resource<CustomDomain>("Convex.CustomDomain");

const find = Effect.fn(function* (deploymentName: string, domain: string, destination: string) {
  const { domains } = yield* management.listCustomDomains({ deploymentName });
  return domains.find((item) => item.domain === domain && item.requestDestination === destination);
});

const toAttrs = Effect.fn(function* (
  deploymentName: string,
  domain: string,
  requestDestination: string,
  item: management.PlatformCustomDomainResponse | undefined,
) {
  return {
    deploymentName,
    teamId: yield* team,
    domain,
    requestDestination,
    verificationTime: item?.verificationTime ?? undefined,
  } satisfies CustomDomainAttributes;
});

export const CustomDomainProvider = () =>
  Provider.effect(
    CustomDomain,
    Effect.succeed({
      stables: ["deploymentName", "domain", "requestDestination"],
      diff: Effect.fn(function* ({ news, olds, output }) {
        if (!isResolved(news)) return undefined;
        if (
          (output !== undefined && news.deployment.deploymentName !== output.deploymentName) ||
          (output !== undefined && news.domain !== output.domain) ||
          (olds !== undefined && news.requestDestination !== olds.requestDestination)
        ) {
          return { action: "replace" } as const;
        }
      }),
      read: Effect.fn(function* ({ olds, output }) {
        const deploymentName = output?.deploymentName ?? olds?.deployment.deploymentName;
        const domain = output?.domain ?? olds?.domain;
        const destination = output?.requestDestination ?? olds?.requestDestination;
        if (!deploymentName || !domain || !destination) return undefined;
        // Below the Professional plan no domain can exist, and a failed create
        // has to stay destroyable.
        const item = yield* find(deploymentName, domain, destination).pipe(
          Effect.catchTag(["VanityDomainsDisabled", "DeploymentNotFound"], () => Effect.undefined),
        );
        return item && (yield* toAttrs(deploymentName, domain, destination, item));
      }),
      reconcile: Effect.fn(function* ({ news, session }) {
        const deploymentName = news.deployment.deploymentName;

        // Observe
        const domain = news.domain;
        const destination = news.requestDestination;
        const existing = yield* find(deploymentName, domain, destination);

        // Ensure. There's nothing mutable beyond the identity.
        if (existing === undefined) {
          yield* session.note(`Adding domain ${domain}...`);
          yield* createOnce(
            management.createCustomDomain({
              deploymentName,
              domain,
              requestDestination: destination,
            }),
          );
        }
        const item = existing ?? (yield* find(deploymentName, domain, destination));
        return yield* toAttrs(deploymentName, domain, destination, item);
      }),
      // Domains go with their deployment.
      list: () => Effect.succeed([]),
      delete: Effect.fn(function* ({ output }) {
        yield* assertTeam(output.teamId, `domain ${output.domain}`);
        yield* management
          .deleteCustomDomain({
            deploymentName: output.deploymentName,
            domain: output.domain,
            requestDestination: output.requestDestination,
          })
          .pipe(Effect.catchTag("DeploymentNotFound", () => Effect.void));
      }),
    }),
  );
