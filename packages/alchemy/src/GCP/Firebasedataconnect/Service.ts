import * as firebasedataconnect from "@distilled.cloud/gcp/firebasedataconnect_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  fieldMask,
  fingerprint,
  listAtLocation,
  listLabeledPages,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  ResourceNotResolved,
  retryTransient,
  sameText,
  stringMap,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
  waitUntilReady,
} from "./internal.ts";

export type ServiceProps = {
  /**
   * Service id (the `{service}` segment of
   * `projects/{project}/locations/{location}/services/{service}`).
   * If omitted, a unique RFC1035 name is generated from the stack,
   * stage, and logical id. Immutable — changing it replaces the
   * service. Must start with a letter, contain only lowercase letters,
   * digits, and hyphens, and be at most 63 characters.
   */
  serviceId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the service. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default "us-central1"
   */
  location?: string;
  /**
   * Human-readable name. 63 character limit.
   */
  displayName?: string;
  /**
   * User annotations (preserved by external tools).
   */
  annotations?: Record<string, string>;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type Service = Resource<
  "GCP.Firebasedataconnect.Service",
  ServiceProps,
  {
    /** Full resource name. */
    name: string;
    /** Service id (last path segment). */
    serviceId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Human-readable name. */
    displayName: string | undefined;
    /** True while Data Connect is applying an LRO. */
    reconciling: boolean;
    /** User annotations. */
    annotations: Record<string, string>;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-generated resource uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
    /** Server-computed etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Firebase Data Connect service — the parent of a GraphQL schema and
 * connectors.
 *
 * Changing `serviceId` or `location` replaces the service. Display
 * name, labels, and annotations update in place.
 *
 * ### Creating a Service
 * **Example:** Generated name
 * ```typescript
 * const service = yield* GCP.Firebasedataconnect.Service("App", {
 *   labels: { env: "test" },
 * });
 * ```
 *
 * **Example:** Explicit id
 * ```typescript
 * const service = yield* GCP.Firebasedataconnect.Service("App", {
 *   serviceId: "movies",
 *   displayName: "movie tracker",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Service
 * **Example:** Display name and labels
 * ```typescript
 * const service = yield* GCP.Firebasedataconnect.Service("App", {
 *   serviceId: existing.serviceId,
 *   displayName: "movie tracker v2",
 *   labels: { env: "prod", team: "data" },
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Firebasedataconnect
 */
export const Service = Resource<Service>("GCP.Firebasedataconnect.Service");

const resourceName = (project: string, location: string, serviceId: string) =>
  `projects/${project}/locations/${location}/services/${serviceId}`;

const toAttrs = (
  item: firebasedataconnect.Service,
  project: string,
): Service["Attributes"] => {
  const name = item.name ?? "";
  const parsed = parseName(name, "services");
  return {
    name,
    serviceId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: item.displayName,
    reconciling: item.reconciling === true,
    annotations: stringMap(item.annotations),
    labels: userLabels(item.labels),
    uid: item.uid,
    createTime: item.createTime,
    updateTime: item.updateTime,
    etag: item.etag,
  };
};

const getByName = (name: string) =>
  firebasedataconnect
    .getProjectsLocationsServices({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listOwned = (project: string) =>
  listAtLocation(project, (parent) =>
    listLabeledPages(
      firebasedataconnect.listProjectsLocationsServices.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.services,
      (item) => item.labels,
    ),
  );

export const ServiceProvider = () =>
  Provider.succeed(Service, {
    stables: ["name", "serviceId", "project", "location", "uid", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      return replaceOnIdentity({
        previousId: olds?.serviceId ?? output?.serviceId,
        nextId: news.serviceId ?? olds?.serviceId ?? output?.serviceId,
        previousLocation: normalizeLocation(olds?.location ?? output?.location),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceId = yield* toPhysicalId(
        id,
        olds?.serviceId,
        output?.serviceId,
        "service",
      );
      const location = normalizeLocation(olds?.location ?? output?.location);
      const name =
        output?.name ?? resourceName(env.project, location, serviceId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceId = yield* toPhysicalId(
        id,
        news.serviceId,
        output?.serviceId,
        "service",
      );
      const location = normalizeLocation(news.location ?? output?.location);
      const name = resourceName(env.project, location, serviceId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredAnnotations = news.annotations ?? {};

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* retryTransient(
          firebasedataconnect.createProjectsLocationsServices({
            parent: parentOf(env.project, location),
            serviceId,
            body: {
              displayName: news.displayName,
              annotations: desiredAnnotations,
              labels: desiredLabels,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, {
            times: 10,
            interval: "5 seconds",
          });
        }
        current = yield* waitUntilExists(getByName(name), name);
      }

      if (current === undefined) {
        return yield* new ResourceNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const mask = fieldMask([
        (upsert.length > 0 || removed.length > 0) && "labels",
        fingerprint(stringMap(current.annotations)) !==
          fingerprint(desiredAnnotations) && "annotations",
        !sameText(current.displayName, news.displayName) && "displayName",
      ]);

      if (mask.length > 0) {
        const operation = yield* retryTransient(
          firebasedataconnect.patchProjectsLocationsServices({
            name: current.name ?? name,
            updateMask: mask,
            body: {
              etag: current.etag,
              displayName: news.displayName,
              annotations: desiredAnnotations,
              labels: desiredLabels,
            },
          }),
        );
        yield* waitForOperation(operation, {
          times: 10,
          interval: "5 seconds",
        });
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      current = yield* waitUntilReady(
        getByName(current.name ?? name),
        current.name ?? name,
      );
      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* retryTransient(
        firebasedataconnect.deleteProjectsLocationsServices({
          name: output.name,
          force: true,
        }),
      ).pipe(
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          times: 8,
          schedule: Schedule.spaced("2 seconds"),
        }),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
      if (operation !== undefined) {
        yield* waitForOperation(operation, {
          notFoundOk: true,
          times: 10,
          interval: "5 seconds",
        });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });
