import * as deployment from "@distilled.cloud/convex/deployment";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { DeploymentAttributes } from "./Deployment.ts";
import { GONE, onDeployment } from "./internal/deployment.ts";
import type { Providers } from "./Providers.ts";

export interface CanonicalUrlProps {
  /** The deployment. Changing it replaces this resource. */
  deployment: Pick<DeploymentAttributes, "url">;
  /**
   * Which URL to set: `convexCloud` for the API or `convexSite` for HTTP
   * actions. Changing it replaces this resource.
   */
  requestDestination: "convexCloud" | "convexSite";
  /** The URL functions see as their canonical one. */
  url: string;
}

export interface CanonicalUrlAttributes {
  /** The URL used to reach the deployment's API. */
  deploymentUrl: string;
  /** Which URL this sets. */
  requestDestination: string;
  /** The canonical URL. */
  url: string;
}

export type CanonicalUrl = Resource<
  "Convex.CanonicalUrl",
  CanonicalUrlProps,
  CanonicalUrlAttributes,
  never,
  Providers
>;

/**
 * The canonical URL of a Convex deployment, usually a custom domain. Removing
 * this resource restores the default.
 *
 * ### Setting a Canonical URL
 * **Example:** Serve HTTP actions from your own domain
 * ```typescript
 * yield* Convex.CanonicalUrl("Site", {
 *   deployment,
 *   requestDestination: "convexSite",
 *   url: "https://site.example.com",
 * });
 * ```
 *
 * @see https://docs.convex.dev/deployment-api/update-canonical-url
 *
 * @resource
 * @product Deployment
 */
export const CanonicalUrl = Resource<CanonicalUrl>("Convex.CanonicalUrl");

const observed = (url: string, destination: string) =>
  onDeployment(url, deployment.getCanonicalUrls({})).pipe(
    Effect.map((urls) => (destination === "convexSite" ? urls.convexSiteUrl : urls.convexCloudUrl)),
  );

export const CanonicalUrlProvider = () =>
  Provider.effect(
    CanonicalUrl,
    Effect.succeed({
      stables: ["deploymentUrl", "requestDestination"],
      diff: Effect.fn(function* ({ news, olds, output }) {
        if (!isResolved(news)) return undefined;
        if (
          (output !== undefined && news.deployment.url !== output.deploymentUrl) ||
          (olds !== undefined && news.requestDestination !== olds.requestDestination)
        ) {
          return { action: "replace" } as const;
        }
      }),
      read: Effect.fn(function* ({ output }) {
        return output;
      }),
      reconcile: Effect.fn(function* ({ news, session }) {
        const url = news.deployment.url;
        const current = yield* observed(url, news.requestDestination);
        if (current !== news.url) {
          yield* session.note(`Setting canonical URL ${news.url}...`);
          yield* onDeployment(
            url,
            deployment.updateCanonicalUrl({
              requestDestination: news.requestDestination,
              url: news.url,
            }),
          );
        }
        return {
          deploymentUrl: url,
          requestDestination: news.requestDestination,
          url: news.url,
        };
      }),
      // There is one per deployment, and it goes with the deployment.
      list: () => Effect.succeed([]),
      delete: Effect.fn(function* ({ output }) {
        yield* onDeployment(
          output.deploymentUrl,
          deployment.updateCanonicalUrl({
            requestDestination: output.requestDestination,
            url: null,
          }),
        ).pipe(Effect.catchTag(GONE, () => Effect.void));
      }),
    }),
  );
