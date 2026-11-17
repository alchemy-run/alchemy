import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { tagRecord } from "alchemy/Tags";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { GcpEnvironment } from "../Environment.ts";
import { inLookupProject } from "../internal/Lookup.ts";
import { createInternalLabels, diffLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_ZONE,
  MAX_MULTICAST_NAME_LENGTH,
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  linkKey,
  normalizeLocation,
  parentOf,
  parseName,
  resourceName,
  rfc1035,
  toMulticastNetwork,
  toNamedResource,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "multicastConsumerAssociations";

export type MulticastConsumerAssociationProps = {
  /**
   * Association id (the `{multicastConsumerAssociation}` segment of
   * `projects/{project}/locations/{location}/multicastConsumerAssociations/{multicastConsumerAssociation}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be at most 48 characters. Immutable — changing it
   * replaces the association.
   */
  multicastConsumerAssociationId?: string;
  /**
   * Zone of the association (`us-central1-a`, …). Immutable — changing
   * it replaces the association. `US-CENTRAL1-A` is accepted and
   * normalized to `us-central1-a`.
   * @default "us-central1-a"
   */
  location?: string;
  /**
   * Consumer VPC network
   * `projects/{project}/locations/global/networks/{network}`. Immutable
   * — changing it replaces the association.
   */
  network: string;
  /**
   * Multicast domain activation in the same zone
   * (`projects/{project}/locations/{location}/multicastDomainActivations/{activation}`).
   * The live API currently requires this field. Immutable — changing it
   * replaces the association.
   */
  multicastDomainActivation?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type MulticastConsumerAssociation = Resource<
  "GCP.NetworkServices.MulticastConsumerAssociation",
  MulticastConsumerAssociationProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/multicastConsumerAssociations/{multicastConsumerAssociation}`. */
    name: string;
    /** Association id (last path segment). */
    multicastConsumerAssociationId: string;
    /** Project id. */
    project: string;
    /** Zone id (`us-central1-a`, …). */
    location: string;
    /** Consumer VPC network resource name. */
    network: string | undefined;
    /** Attached multicast domain activation, if set. */
    multicastDomainActivation: string | undefined;
    /** User-provided description. */
    description: string | undefined;
    /** Deprecated resource-state enum. */
    resourceState: string | undefined;
    /** Nested multicast resource state. */
    state: string | undefined;
    /** Google-generated UUID. */
    uniqueId: string | undefined;
    /** Placement-policy resource name, if set. */
    placementPolicy: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers,
  MulticastConsumerAssociationLookup
>;

/**
 * Props for {@link MulticastConsumerAssociation.lookup}: find a multicast
 * consumer association this stack doesn't manage by its identifiers, in the
 * ambient project unless `project` names another.
 */
export interface MulticastConsumerAssociationLookup {
  /**
   * Association id (the `{multicastConsumerAssociation}` segment of
   * `project
   * s/{project}/locations/{location}/multicastConsumerAssociations/{multicas
   * tConsumerAssociation}`). Must be at most 48 characters.
   */
  multicastConsumerAssociationId: string;
  /**
   * Zone of the association (`us-central1-a`, …). `US-CENTRAL1-A` is
   * accepted and normalized to `us-central1-a`.
   */
  location?: string;
  /**
   * Project the resource lives in.
   * @default the ambient GCP project
   */
  project?: string;
}

/**
 * A multicast consumer association attaches a consumer VPC to Cloud
 * Multicast in a zone so VMs in that network can join multicast groups.
 *
 * Changing `multicastConsumerAssociationId`, `location`, `network`, or
 * `multicastDomainActivation` replaces the association. Description and
 * labels update in place.
 *
 * ### Creating a MulticastConsumerAssociation
 * **Example:** Associate a VPC
 * ```typescript
 * const association = yield* GCP.NetworkServices.MulticastConsumerAssociation(
 *   "Consumers",
 *   {
 *     location: "us-central1-a",
 *     network: `projects/${vpc.project}/locations/global/networks/${vpc.networkName}`,
 *     labels: { env: "prod" },
 *   },
 * );
 * ```
 *
 * ### Looking up an existing multicast consumer association
 * `MulticastConsumerAssociation.lookup` references a multicast consumer
 * association Alchemy doesn't manage (created in the console or by another
 * stack). It is read during plan/deploy, never created, updated or deleted,
 * and binds like a declared multicast consumer association.
 *
 * **Example:** Reference an existing multicast consumer association
 * ```typescript
 * const multicastConsumerAssociation = GCP.NetworkServices.MulticastConsumerAssociation.lookup({
 *   multicastConsumerAssociationId: "my-multicast-consumer-association",
 * });
 * ```
 *
 * @resource
 * @category NetworkServices
 */
export const MulticastConsumerAssociation = Resource<MulticastConsumerAssociation>(
  "GCP.NetworkServices.MulticastConsumerAssociation",
);

const toActivation = (project: string, location: string, value: string | undefined) =>
  value ? toNamedResource(project, location, "multicastDomainActivations", value) : undefined;

const toAttrs = (association: networkservices.MulticastConsumerAssociation, project: string) => {
  const name = association.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_ZONE);
  const location = parsed.location || DEFAULT_ZONE;
  const proj = parsed.project || project;
  return {
    name,
    multicastConsumerAssociationId: parsed.id,
    project: proj,
    location,
    network: association.network ? toMulticastNetwork(proj, association.network) : undefined,
    multicastDomainActivation: toActivation(proj, location, association.multicastDomainActivation),
    description: association.description,
    resourceState: association.resourceState,
    state: association.state?.state,
    uniqueId: association.uniqueId,
    placementPolicy: association.placementPolicy,
    labels: userLabels(association.labels),
    createTime: association.createTime,
    updateTime: association.updateTime,
  };
};

const getByName = (name: string) =>
  networkservices
    .getProjectsLocationsMulticastConsumerAssociations({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const MulticastConsumerAssociationProvider = () =>
  Provider.succeed(MulticastConsumerAssociation, {
    stables: [
      "name",
      "multicastConsumerAssociationId",
      "project",
      "location",
      "network",
      "multicastDomainActivation",
      "uniqueId",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId =
        olds?.multicastConsumerAssociationId ?? output?.multicastConsumerAssociationId;
      const nextId = news.multicastConsumerAssociationId
        ? rfc1035(news.multicastConsumerAssociationId, "mcast-assoc", MAX_MULTICAST_NAME_LENGTH)
        : previousId;
      const previousLocation = normalizeLocation(olds?.location ?? output?.location, DEFAULT_ZONE);
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_ZONE,
      );
      const previousNetwork = linkKey(olds?.network ?? output?.network);
      const nextNetwork = linkKey(news.network);
      const previousActivation = linkKey(
        olds?.multicastDomainActivation ?? output?.multicastDomainActivation,
      );
      const nextActivation = linkKey(news.multicastDomainActivation);
      if (
        (previousId !== undefined && nextId !== undefined && nextId !== previousId) ||
        previousLocation !== nextLocation ||
        (previousNetwork.length > 0 && previousNetwork !== nextNetwork) ||
        (previousActivation.length > 0 &&
          nextActivation.length > 0 &&
          previousActivation !== nextActivation)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    lookup: Effect.fn(function* ({ multicastConsumerAssociationId, location: lookupLocation }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(lookupLocation, DEFAULT_ZONE);
      const name = resourceName(env.project, location, COLLECTION, multicastConsumerAssociationId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      return toAttrs(existing, env.project);
    }, inLookupProject),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const multicastConsumerAssociationId = yield* toPhysicalId(
        id,
        olds?.multicastConsumerAssociationId,
        output?.multicastConsumerAssociationId,
        "mcast-assoc",
        MAX_MULTICAST_NAME_LENGTH,
      );
      const location = normalizeLocation(olds?.location ?? output?.location, DEFAULT_ZONE);
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, multicastConsumerAssociationId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels))) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          networkservices.listProjectsLocationsMulticastConsumerAssociations.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
          }),
          (page) => page.multicastConsumerAssociations,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const multicastConsumerAssociationId = yield* toPhysicalId(
        id,
        news.multicastConsumerAssociationId,
        output?.multicastConsumerAssociationId,
        "mcast-assoc",
        MAX_MULTICAST_NAME_LENGTH,
      );
      const location = normalizeLocation(news.location ?? output?.location, DEFAULT_ZONE);
      const name = resourceName(env.project, location, COLLECTION, multicastConsumerAssociationId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const network = toMulticastNetwork(env.project, news.network);
      const multicastDomainActivation = toActivation(
        env.project,
        location,
        news.multicastDomainActivation,
      );

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkservices
          .createProjectsLocationsMulticastConsumerAssociations({
            parent: parentOf(env.project, location),
            multicastConsumerAssociationId,
            body: {
              description: news.description,
              labels: desiredLabels,
              network,
              multicastDomainActivation,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.undefined),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilPresent(getByName(name), name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["description", (current.description ?? "") !== (news.description ?? "")],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkservices.patchProjectsLocationsMulticastConsumerAssociations({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(getByName(current.name ?? name), current.name ?? name);
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkservices
        .deleteProjectsLocationsMulticastConsumerAssociations({
          name: output.name,
        })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.undefined),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
