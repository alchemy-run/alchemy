import * as objectStorage from "@distilled.cloud/stackit/object_storage";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import { labelRecord, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { ensureObjectStorageEnabled, getObjectStorageTenant } from "./internal.ts";

export interface ProjectProps {
  /**
   * Project to enable Object Storage for. Defaults to the profile's project.
   * Changing it replaces the resource.
   */
  projectId?: string;
  /**
   * Region of the tenant. Defaults to the profile's region (`eu01`). Changing
   * it replaces the resource.
   */
  region?: string;
  /**
   * Labels on the project's Object Storage tenant. Alchemy only touches the
   * keys listed here: a key you remove is removed from the tenant, and labels
   * set outside Alchemy stay.
   */
  labels?: Record<string, string>;
  /**
   * Disable Object Storage when this resource is deleted, but only if this
   * resource enabled it (`enabledByAlchemy`). This deletes the project's whole
   * tenant in the region, including buckets and credentials Alchemy doesn't
   * manage, which is why it is opt-in.
   * @default false
   */
  disableOnDelete?: boolean;
}

export interface ProjectAttributes {
  /** Project Object Storage is enabled for. */
  projectId: string;
  /** Region of the tenant. */
  region: string;
  /** Scope of the project: `PUBLIC`, or a client-specific one. */
  scope: string;
  /** Every label on the tenant, including those set outside Alchemy. */
  labels: Record<string, string>;
  /** The label keys this resource manages. */
  managedLabels: string[];
  /**
   * Whether this resource enabled Object Storage. `false` when the tenant
   * already existed when the resource was first deployed, for example because
   * a bucket enabled it implicitly.
   */
  enabledByAlchemy: boolean;
  /** Whether delete disables Object Storage (see `disableOnDelete`). */
  disableOnDelete: boolean;
}

export type Project = Resource<
  "Stackit.ObjectStorage.Project",
  ProjectProps,
  ProjectAttributes,
  never,
  Providers
>;

/**
 * A project's Object Storage tenant: enables the service, manages the tenant's
 * labels, and optionally disables the service again on delete.
 *
 * You rarely need this resource. Every other `Stackit.ObjectStorage` resource
 * enables Object Storage on its own at deploy time, and never disables it.
 * Declare a `Project` to enable the service before using it outside Alchemy,
 * to label the tenant, or to disable the service when the stack is destroyed.
 *
 * Ownership: the tenant is project-wide and Alchemy puts no ownership labels on
 * it, so an existing tenant is taken over without `--adopt`. Instead the
 * resource records whether *it* enabled the service (`enabledByAlchemy`). For
 * the same reason `alchemy unsafe nuke` skips this type.
 *
 * See [STACKIT's Object Storage docs](https://docs.stackit.cloud/products/storage/object-storage/).
 *
 * :::caution[Changing `projectId` or `region` replaces the Tenant]
 * The service is enabled at the new place. The old place keeps Object Storage unless
 * this resource enabled it and is set to disable it on delete.
 * :::
 *
 * ### Enabling Object Storage
 * **Example:** Enable Object Storage in the profile's project
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const tenant = yield* Stackit.ObjectStorage.Project("Tenant", {});
 * ```
 *
 * **Example:** Enable Object Storage in another project and region
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const tenant = yield* Stackit.ObjectStorage.Project("Tenant", {
 *   projectId: "00000000-0000-0000-0000-000000000000",
 *   region: "eu01",
 * });
 * ```
 *
 * ### Labeling the tenant
 * **Example:** Tenant labels
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const tenant = yield* Stackit.ObjectStorage.Project("Tenant", {
 *   labels: { contact: "platform-team", environment: "production" },
 * });
 * ```
 *
 * Destroying the resource removes the labels it set and leaves the rest.
 *
 * ### Using it with buckets
 * **Example:** Order a bucket after the tenant
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const tenant = yield* Stackit.ObjectStorage.Project("Tenant", {
 *   disableOnDelete: true,
 * });
 * const bucket = yield* Stackit.ObjectStorage.Bucket("Assets", {
 *   projectId: tenant.projectId,
 * });
 * ```
 *
 * Reference `tenant.projectId` as above whenever you rely on
 * `enabledByAlchemy`. Without that reference the two deploy in parallel, and a
 * bucket that enables the service first leaves `enabledByAlchemy` at `false`,
 * so `disableOnDelete` then does nothing. The reference also deletes the bucket
 * before the tenant.
 *
 * ### Disabling Object Storage <!-- api-prose -->
 * With `disableOnDelete: true`, deleting a resource that enabled the service
 * deletes the project's tenant in that region, including buckets and
 * credentials this stack doesn't manage. A tenant that already existed is never
 * disabled. A later deploy of any `Stackit.ObjectStorage` resource in the
 * project enables the service again, with a new tenant.
 *
 * @resource
 * @product STACKIT Object Storage
 * @category Storage
 */
export const Project = Resource<Project>("Stackit.ObjectStorage.Project");

const tenantName = (projectId: string, region: string) =>
  `STACKIT Object Storage tenant of project ${projectId} (${region})`;

export const ProjectProvider = () =>
  Provider.succeed(Project, {
    stables: ["projectId", "region"],
    // Project-wide, with no ownership marker to filter by, and disabling it
    // deletes the tenant.
    nuke: { skip: true },

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // Delete-first: an unresolved scope can resolve to the current tenant,
      // and a create-first replacement would see it enabled, record that
      // Alchemy didn't enable it, and let the old generation disable it.
      if (hasUnresolvedTrigger<ProjectProps>(news, ["projectId", "region"])) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<ProjectProps>(news);
      const env = yield* StackitEnvironment.current;
      if (
        (resolved.projectId ?? env.projectId) !== output.projectId ||
        (resolved.region ?? env.region) !== output.region
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const region = output?.region ?? olds?.region ?? env.region;
      const status = yield* getObjectStorageTenant({ projectId, region });
      if (status === undefined) return undefined;
      // No ownership marker exists, and taking over an enabled tenant is
      // harmless (see the resource docs), so never `Unowned`.
      return {
        projectId,
        region,
        scope: status.scope,
        labels: labelRecord(status.labels),
        managedLabels: output?.managedLabels ?? [],
        enabledByAlchemy: output?.enabledByAlchemy ?? false,
        disableOnDelete: output?.disableOnDelete ?? olds?.disableOnDelete === true,
      };
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const region = news.region ?? output?.region ?? env.region;

      // Observe, then ensure. The implicit helper other resources use is the
      // one that enables, so both paths create a tenant the same way.
      const existing = yield* getObjectStorageTenant({ projectId, region });
      const enabledNow = existing === undefined;
      const enabled = existing ?? (yield* ensureObjectStorageEnabled({ projectId, region }));
      const visible = enabledNow
        ? yield* waitFor({
            resource: tenantName(projectId, region),
            read: getObjectStorageTenant({ projectId, region }),
            ready: (status) => status !== undefined,
            state: (status) => (status === undefined ? "not visible" : "visible"),
            timeout: "1 minute",
          })
        : existing;
      let status = visible ?? enabled;

      // Sync — `UpdateService` replaces the whole map, so labels this resource
      // doesn't manage are sent back unchanged.
      const desired = toLabels(news.labels);
      const live = labelRecord(status.labels);
      const previous = output?.managedLabels ?? [];
      const kept = Object.fromEntries(
        Object.entries(live).filter(([key]) => !previous.includes(key) || key in desired),
      );
      const labels = { ...kept, ...desired };
      const unchanged =
        Object.keys(labels).length === Object.keys(live).length &&
        Object.entries(labels).every(([key, value]) => live[key] === value);
      if (!unchanged) {
        status = yield* objectStorage.updateService({ projectId, region, labels });
      }

      return {
        projectId,
        region,
        scope: status.scope,
        labels: labelRecord(status.labels),
        managedLabels: Object.keys(desired),
        // Provenance can't be observed in the cloud; keep the first answer.
        enabledByAlchemy: (output?.enabledByAlchemy ?? false) || enabledNow,
        disableOnDelete: news.disableOnDelete === true,
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      const { projectId, region } = output;
      if (output.enabledByAlchemy && output.disableOnDelete) {
        yield* objectStorage
          .disableService({ projectId, region })
          .pipe(Effect.catchTag("NotFound", () => Effect.void));
        yield* waitUntilGone({
          resource: tenantName(projectId, region),
          read: getObjectStorageTenant({ projectId, region }),
          timeout: "5 minutes",
        });
        return;
      }
      // The tenant stays; only this resource's labels go.
      const status = yield* getObjectStorageTenant({ projectId, region });
      if (status === undefined) return;
      const live = labelRecord(status.labels);
      if (!output.managedLabels.some((key) => key in live)) return;
      yield* objectStorage
        .updateService({
          projectId,
          region,
          labels: Object.fromEntries(
            Object.entries(live).filter(([key]) => !output.managedLabels.includes(key)),
          ),
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
