import * as organizations from "@distilled.cloud/daytona/organizations";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import { declarable } from "./internal/Declared.ts";
import {
  currentOrganizationId,
  movesOrganization,
  organizationIdFor,
  type OrganizationRef,
} from "./internal/Organization.ts";
import type { Ref } from "./internal/Ref.ts";
import type { Providers } from "./Providers.ts";

export interface OrganizationSettingsProps {
  /**
   * Organization to act on, e.g. a `Daytona.Organization`. Defaults to the
   * credentials' organization. Changing it replaces the resource.
   */
  organization?: Ref<OrganizationRef>;
  /** Region new sandboxes go to when they don't name one. */
  defaultRegionId?: string;
  /**
   * How long a sandbox create may wait in the queue for capacity before it
   * fails. `null` waits indefinitely.
   */
  defaultQueueTimeout?: Duration.Input | null;
  /** Experimental feature flags, as Daytona names them. */
  experimentalConfig?: Record<string, unknown>;
}

interface Captured {
  defaultRegionId: string | undefined;
  defaultQueueTimeout: number | null;
  experimentalConfig: unknown;
}

export interface OrganizationSettingsAttributes {
  /** Organization ID. */
  organizationId: string;
  /** Organization name. */
  name: string;
  /** Default region. */
  defaultRegionId: string | undefined;
  /** Default queue timeout in seconds, or `null`. */
  defaultQueueTimeout: number | null;
  /** Experimental flags. */
  experimentalConfig: unknown;
  /** The settings before alchemy first changed them; restored on destroy. */
  original: Captured;
}

export type OrganizationSettings = Resource<
  "Daytona.OrganizationSettings",
  OrganizationSettingsProps,
  OrganizationSettingsAttributes,
  never,
  Providers
>;

/**
 * Settings of the Daytona organization the credentials belong to: the
 * default region, the queue timeout for creates waiting on capacity, and
 * experimental flags. Only the settings you declare are changed.
 *
 * The organization always exists, so this resource captures the settings
 * it finds on first deploy and puts them back on destroy.
 *
 * ### Configuring the Organization
 * **Example:** Default region and a one-minute queue timeout
 * ```typescript
 * export const Settings = Daytona.OrganizationSettings("Settings", {
 *   defaultRegionId: "eu",
 *   defaultQueueTimeout: "1 minute",
 * });
 * ```
 *
 * @resource
 * @product Organization
 */
export const OrganizationSettings = declarable<OrganizationSettings>()(
  Resource<OrganizationSettings>("Daytona.OrganizationSettings"),
);

const seconds = (d: Duration.Input | null) =>
  d === null ? null : Math.round(Duration.toSeconds(d));

const toAttributes = (
  org: organizations.Organization,
  original: Captured,
): OrganizationSettingsAttributes => ({
  organizationId: org.id,
  name: org.name,
  defaultRegionId: org.defaultRegionId,
  defaultQueueTimeout: org.defaultQueueTimeout,
  experimentalConfig: org.experimentalConfig,
  original,
});

const apply = Effect.fn(function* (
  org: organizations.Organization,
  want: {
    defaultRegionId?: string | undefined;
    defaultQueueTimeout?: number | null | undefined;
    experimentalConfig?: unknown;
  },
) {
  if (want.defaultRegionId !== undefined && want.defaultRegionId !== org.defaultRegionId) {
    yield* organizations.setOrganizationDefaultRegion({
      organizationId: org.id,
      defaultRegionId: want.defaultRegionId,
    });
  }
  if (
    want.defaultQueueTimeout !== undefined &&
    want.defaultQueueTimeout !== org.defaultQueueTimeout
  ) {
    yield* organizations.updateOrganizationDefaultQueueTimeout({
      organizationId: org.id,
      defaultQueueTimeout: want.defaultQueueTimeout,
    });
  }
  if (
    want.experimentalConfig !== undefined &&
    !deepEqual(want.experimentalConfig, org.experimentalConfig)
  ) {
    yield* organizations.updateExperimentalConfig({
      organizationId: org.id,
      body: want.experimentalConfig as organizations.UpdateExperimentalConfigRequest["body"],
    });
  }
});

export const OrganizationSettingsProvider = () =>
  Provider.effect(
    OrganizationSettings,
    Effect.succeed({
      stables: ["organizationId", "original"],
      nuke: { singleton: true },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, output }) {
        if (!isResolved(news) || output === undefined) return undefined;
        if (yield* movesOrganization(news.organization, output))
          return { action: "replace" } as const;
      }),
      read: Effect.fn(function* ({ output }) {
        const org = yield* organizations.getOrganization({
          organizationId: output?.organizationId ?? (yield* currentOrganizationId),
        });
        return toAttributes(
          org,
          output?.original ?? {
            defaultRegionId: org.defaultRegionId,
            defaultQueueTimeout: org.defaultQueueTimeout,
            experimentalConfig: org.experimentalConfig,
          },
        );
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const organizationId = yield* organizationIdFor(news.organization);
        // Observe
        const org = yield* organizations.getOrganization({ organizationId });
        const original = output?.original ?? {
          defaultRegionId: org.defaultRegionId,
          defaultQueueTimeout: org.defaultQueueTimeout,
          experimentalConfig: org.experimentalConfig,
        };
        // Sync only what is declared, against observed settings.
        yield* apply(org, {
          defaultRegionId: news.defaultRegionId,
          defaultQueueTimeout:
            news.defaultQueueTimeout === undefined ? undefined : seconds(news.defaultQueueTimeout),
          experimentalConfig: news.experimentalConfig,
        });
        return toAttributes(yield* organizations.getOrganization({ organizationId }), original);
      }),
      delete: Effect.fn(function* ({ output }) {
        const org = yield* organizations
          .getOrganization({ organizationId: output.organizationId })
          .pipe(Effect.catchTag("OrganizationNotFound", () => Effect.undefined));
        if (org === undefined) return;
        yield* apply(org, output.original);
      }),
    }),
  );
