import * as organization from "@distilled.cloud/clickhouse-cloud/organization";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { organizationId as currentOrganizationId } from "../Credentials.ts";
import { PreviewNotOffered, requireResult } from "../Errors.ts";
import type { Providers } from "../Providers.ts";

export interface PreviewFeatureProps {
  /**
   * ID of the public preview, e.g. `health-checks` or `table-views`.
   * Changing it replaces the resource.
   */
  previewId: string;
  /**
   * Whether the preview is on.
   * @default true
   */
  enabled?: boolean;
}

export interface PreviewFeatureAttributes {
  /** Organization ID. */
  organizationId: string;
  /** Preview ID. */
  previewId: string;
  /** Preview name. */
  name: string;
  /** What the preview does. */
  description: string;
  /** Documentation of the preview. */
  docsUrl: string;
  /** Whether the preview is on. */
  enabled: boolean;
  /** Whether the preview was on before alchemy first switched it; restored on destroy. */
  originalEnabled: boolean;
}

export type PreviewFeature = Resource<
  "ClickHouseCloud.Organization.PreviewFeature",
  PreviewFeatureProps,
  PreviewFeatureAttributes,
  never,
  Providers
>;

/**
 * A public preview feature switched on (or off) for the organization:
 * console dashboards, approved domains and other features ClickHouse is
 * trying out. The endpoint is in public beta.
 *
 * The first deploy records whether the preview was on, and destroy puts
 * that back. Only previews the organization is offered and may toggle can
 * be switched: anything else fails with `PreviewNotOffered`, naming the
 * previews that are offered. Switching needs an Admin key.
 * @see https://clickhouse.com/docs/cloud/manage/openapi
 *
 * ### Switching a Preview On
 * **Example:** Health-check panels on every service's monitoring page
 * ```typescript
 * yield* ClickHouseCloud.Organization.PreviewFeature("HealthChecks", {
 *   previewId: "health-checks",
 * });
 * ```
 *
 * **Example:** Keep a preview off
 * ```typescript
 * yield* ClickHouseCloud.Organization.PreviewFeature("NoTableViews", {
 *   previewId: "table-views",
 *   enabled: false,
 * });
 * ```
 *
 * @resource
 * @product Organization
 */
export const PreviewFeature = Resource<PreviewFeature>(
  "ClickHouseCloud.Organization.PreviewFeature",
);

const listPreviews = (organizationId: string) =>
  organization
    .listOrganizationPublicPreviews({ organizationId })
    .pipe(Effect.flatMap(requireResult("listOrganizationPublicPreviews")));

const toAttributes = (
  organizationId: string,
  preview: organization.PublicPreview,
  originalEnabled: boolean,
): PreviewFeatureAttributes => ({
  organizationId,
  previewId: preview.id,
  name: preview.name,
  description: preview.description,
  docsUrl: preview.docsUrl,
  enabled: preview.enabled,
  originalEnabled,
});

export const PreviewFeatureProvider = () =>
  Provider.effect(
    PreviewFeature,
    Effect.succeed({
      stables: ["organizationId", "previewId", "originalEnabled"],
      // Organization-wide toggles: nuke leaves them alone.
      nuke: { singleton: true },
      list: () => Effect.succeed([]),
      diff: Effect.fn(function* ({ news, olds }) {
        if (!isResolved(news) || olds === undefined) return undefined;
        if (news.previewId !== olds.previewId) return { action: "replace" } as const;
        return undefined;
      }),
      read: Effect.fn(function* ({ olds, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        const previewId = output?.previewId ?? olds.previewId;
        const preview = (yield* listPreviews(organizationId)).find((p) => p.id === previewId);
        if (preview === undefined) return undefined;
        return toAttributes(organizationId, preview, output?.originalEnabled ?? preview.enabled);
      }),
      reconcile: Effect.fn(function* ({ news, output }) {
        const organizationId = output?.organizationId ?? (yield* currentOrganizationId);
        // Observe
        const all = yield* listPreviews(organizationId);
        const preview = all.find((p) => p.id === news.previewId);
        if (preview === undefined) {
          return yield* new PreviewNotOffered({
            previewId: news.previewId,
            offered: all.map((p) => p.id),
            reason: "not-offered",
          });
        }
        const originalEnabled = output?.originalEnabled ?? preview.enabled;
        const enabled = news.enabled ?? true;
        if (preview.enabled === enabled) {
          return toAttributes(organizationId, preview, originalEnabled);
        }
        if (!preview.canToggle) {
          return yield* new PreviewNotOffered({
            previewId: news.previewId,
            offered: all.map((p) => p.id),
            reason: "not-toggleable",
          });
        }
        // Sync
        const updated = yield* organization
          .updateOrganizationPublicPreview({ organizationId, previewId: news.previewId, enabled })
          .pipe(Effect.flatMap(requireResult("updateOrganizationPublicPreview")));
        return toAttributes(organizationId, updated, originalEnabled);
      }),
      delete: Effect.fn(function* ({ output }) {
        const preview = (yield* listPreviews(output.organizationId)).find(
          (p) => p.id === output.previewId,
        );
        if (preview === undefined || preview.enabled === output.originalEnabled) return;
        yield* organization.updateOrganizationPublicPreview({
          organizationId: output.organizationId,
          previewId: output.previewId,
          enabled: output.originalEnabled,
        });
      }),
    }),
  );
