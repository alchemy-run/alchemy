import * as gkehub from "@distilled.cloud/gcp/unstable/gkehub_v1";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, diffLabels, hasAlchemyLabels } from "../Labels.ts";
import { waitForOperation as waitForGcpOperation } from "../Operation.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LOCATION,
  ResourceNotResolved,
  hasAlchemyLabelMap,
  lastSegment,
  normalizeLocation,
  toPhysicalId,
  userLabels,
  waitUntilGone,
} from "./internal.ts";

export type MembershipProps = {
  /**
   * Membership id (the `{membership}` segment of
   * `projects/{project}/locations/{location}/memberships/{membership}`). If
   * omitted, a unique id is generated. Immutable — changing it replaces the
   * membership.
   */
  membershipId?: string;
  /**
   * Location of the membership. Immutable — changing it replaces the
   * membership.
   * @default "global"
   */
  location?: string;
  /**
   * The GKE cluster to register: its `projects/{p}/locations/{l}/clusters/{c}`
   * name, or a `//container.googleapis.com/...` resource link. Immutable —
   * changing it replaces the membership.
   */
  cluster: string;
  /** Description. */
  description?: string;
  /** User labels. Alchemy adds its ownership labels. */
  labels?: Record<string, string>;
};

export type Membership = Resource<
  "GCP.GKEHub.Membership",
  MembershipProps,
  {
    /** Full name `projects/{project}/locations/{location}/memberships/{membership}`. */
    name: string;
    /** Membership id. */
    membershipId: string;
    /** Project id. */
    project: string;
    /** Location. */
    location: string;
    /** Resource link of the registered cluster. */
    cluster: string;
    /** Description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Membership state (`READY`, `CREATING`, …). */
    state: string | undefined;
    /** Google-assigned unique id. */
    uniqueId: string | undefined;
  },
  never,
  Providers
>;

/**
 * Registers a GKE cluster with the project's fleet, so fleet features
 * (Config Sync, Service Mesh, Policy Controller) can target it through
 * `GCP.GKEHub.MembershipsFeature`.
 *
 * The id, location and cluster are fixed; description and labels update in
 * place. Create and delete are long-running operations.
 *
 * ### Registering a Cluster
 * **Example:** A GKE cluster in the fleet
 * ```typescript
 * const cluster = yield* GCP.Container.Cluster("App", { location: "us-central1" });
 * const membership = yield* GCP.GKEHub.Membership("App", {
 *   cluster: cluster.name,
 * });
 * ```
 *
 * ### Enabling a Fleet Feature
 * **Example:** Config Sync on the registered cluster
 * ```typescript
 * yield* GCP.GKEHub.MembershipsFeature("ConfigSync", {
 *   membership: membership.name,
 *   featureId: "configmanagement",
 *   spec: { configmanagement: { configSync: { enabled: true } } },
 * });
 * ```
 *
 * @resource
 * @category GKE Hub
 */
export const Membership = Resource<Membership>("GCP.GKEHub.Membership");

const resourceLinkOf = (cluster: string) =>
  cluster.startsWith("//")
    ? cluster
    : `//container.googleapis.com/${cluster.replace(/^https:\/\/container\.googleapis\.com\/v1\//, "")}`;

const waitForOperation = (operation: gkehub.Operation) =>
  waitForGcpOperation(operation, (name) => gkehub.getProjectsLocationsOperations({ name }), {
    budget: "15 minutes",
  });

const getByName = (name: string) =>
  name.length === 0
    ? Effect.undefined
    : gkehub
        .getProjectsLocationsMemberships({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const toAttrs = (membership: gkehub.Membership, project: string): Membership["Attributes"] => {
  const name = membership.name ?? "";
  const parts = name.split("/");
  return {
    name,
    membershipId: lastSegment(name),
    project: parts[1] ?? project,
    location: parts[3] ?? DEFAULT_LOCATION,
    cluster: membership.endpoint?.gkeCluster?.resourceLink ?? "",
    description: membership.description,
    labels: userLabels(membership.labels),
    state: membership.state?.code,
    uniqueId: membership.uniqueId,
  };
};

export const MembershipProvider = () =>
  Provider.succeed(Membership, {
    stables: ["name", "membershipId", "project", "location", "cluster", "uniqueId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousCluster = olds?.cluster ?? output?.cluster;
      const previousLocation = olds?.location ?? output?.location;
      const previousId = olds?.membershipId ?? output?.membershipId;
      if (
        (previousCluster !== undefined &&
          resourceLinkOf(previousCluster) !== resourceLinkOf(news.cluster)) ||
        (previousLocation !== undefined &&
          normalizeLocation(previousLocation) !== normalizeLocation(news.location)) ||
        (previousId !== undefined &&
          news.membershipId !== undefined &&
          news.membershipId !== previousId)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const membershipId = yield* toPhysicalId(id, olds?.membershipId, output?.membershipId);
      const existing = yield* getByName(
        output?.name ?? `projects/${env.project}/locations/${location}/memberships/${membershipId}`,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels))) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* gkehub.listProjectsLocationsMemberships
          .pages({ parent: `projects/${env.project}/locations/-`, pageSize: 100 })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.resources ?? [])),
            Stream.filter((membership) => hasAlchemyLabelMap(membership.labels)),
            Stream.map((membership) => toAttrs(membership, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const membershipId = yield* toPhysicalId(id, news.membershipId, output?.membershipId);
      const name = `projects/${env.project}/locations/${location}/memberships/${membershipId}`;
      const labels = { ...news.labels, ...(yield* createInternalLabels(id)) };

      // Observe
      let current = yield* getByName(output?.name ?? name);

      // Ensure
      if (current === undefined) {
        const operation = yield* gkehub
          .createProjectsLocationsMemberships({
            parent: `projects/${env.project}/locations/${location}`,
            membershipId,
            body: {
              description: news.description,
              labels,
              endpoint: { gkeCluster: { resourceLink: resourceLinkOf(news.cluster) } },
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.undefined));
        if (operation !== undefined) yield* waitForOperation(operation);
        current = yield* getByName(name);
      } else {
        // Sync description and labels against the live membership.
        const delta = diffLabels(tagRecord(current.labels), labels);
        const labelsChanged = delta.added.length + delta.updated.length + delta.removed.length > 0;
        const descriptionChanged =
          news.description !== undefined && (current.description ?? "") !== news.description;
        if (labelsChanged || descriptionChanged) {
          const operation = yield* gkehub.patchProjectsLocationsMemberships({
            name: current.name ?? name,
            updateMask: [labelsChanged && "labels", descriptionChanged && "description"]
              .filter(Boolean)
              .join(","),
            body: { labels, description: news.description },
          });
          yield* waitForOperation(operation);
          current = yield* getByName(current.name ?? name);
        }
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ resourceName: name });
      }
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* gkehub
        .deleteProjectsLocationsMemberships({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
      if (operation !== undefined) yield* waitForOperation(operation);
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
