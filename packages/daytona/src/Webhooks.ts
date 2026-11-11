import * as webhooks from "@distilled.cloud/daytona/webhooks";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { declarable } from "./internal/Declared.ts";
import {
  movesOrganization,
  organizationIdFor,
  type OrganizationRef,
} from "./internal/Organization.ts";
import type { Ref } from "./internal/Ref.ts";
import { waitForState } from "./internal/Wait.ts";
import type { Providers } from "./Providers.ts";

export interface WebhooksProps {
  /**
   * Organization to act on, e.g. a `Daytona.Organization`. Defaults to the
   * credentials' organization. Changing it replaces the resource.
   */
  organization?: Ref<OrganizationRef>;
  /**
   * Bump to re-sync the organization's webhook endpoints with Daytona's
   * event types on the next deploy.
   */
  refresh?: number;
}

export interface WebhooksAttributes {
  /** Organization ID. */
  organizationId: string;
  /** The Svix application Daytona delivers events through. */
  svixApplicationId: string;
  /** Refresh counter applied. */
  refreshed: number;
}

export type Webhooks = Resource<
  "Daytona.Webhooks",
  WebhooksProps,
  WebhooksAttributes,
  never,
  Providers
>;

/**
 * Turn on webhooks for the Daytona organization: sandbox, snapshot and
 * volume events delivered to endpoints you register in Daytona's webhook
 * portal. Daytona delivers through Svix, which owns the endpoints, so this
 * resource only enables delivery; open the portal with
 * `getWebhookControllerAppPortalAccess` (on {@link ReadOrganization}) to
 * add endpoints. Webhooks can't be turned off again through the API, so
 * destroy leaves them enabled.
 * @see https://www.daytona.io/docs/en/webhooks/
 *
 * ### Enabling Webhooks
 * **Example:** Enable delivery for the organization
 * ```typescript
 * export const Events = Daytona.Webhooks("Events", {});
 * ```
 *
 * @resource
 * @product Organization
 */
export const Webhooks = declarable<Webhooks>()(Resource<Webhooks>("Daytona.Webhooks"));

const status = (organizationId: string) =>
  webhooks.getWebhookControllerInitializationStatus({ organizationId }).pipe(
    Effect.map((s) => ({
      ...s,
      state: s.svixApplicationId ? "ready" : s.lastError ? "error" : "pending",
    })),
    // Before initialization Daytona has no status to report.
    Effect.catchTag("WebhooksNotInitialized", () =>
      Effect.succeed({ svixApplicationId: undefined, lastError: undefined, state: "pending" }),
    ),
  );

export const WebhooksProvider = () =>
  Provider.effect(
    Webhooks,
    Effect.succeed({
      stables: ["organizationId", "svixApplicationId"],
      nuke: { singleton: true },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, output }) {
        if (!isResolved(news) || output === undefined) return undefined;
        if (yield* movesOrganization(news.organization, output))
          return { action: "replace" } as const;
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const organizationId = yield* organizationIdFor(news.organization);
        // Observe
        let current = yield* status(organizationId);
        // Ensure
        if (current.svixApplicationId == null) {
          yield* webhooks.webhookControllerInitializeWebhooks({ organizationId });
          current = yield* waitForState({
            kind: "webhooks",
            id: organizationId,
            observe: status(organizationId),
            want: ["ready"],
            fail: ["error"],
            reason: (s) => s.lastError,
            budget: "2 minutes",
          });
        }
        // Sync
        const refresh = news.refresh ?? 0;
        if (output !== undefined && refresh !== output.refreshed) {
          yield* webhooks.refreshWebhookControllerEndpoints({ organizationId });
        }
        return {
          organizationId,
          svixApplicationId: current.svixApplicationId ?? "",
          refreshed: refresh,
        };
      }),
      delete: () => Effect.void,
    }),
  );
