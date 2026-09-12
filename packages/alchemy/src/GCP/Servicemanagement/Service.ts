import * as servicemanagement from "@distilled.cloud/gcp/servicemanagement_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  configOwnershipText,
  encodeTitle,
  getByName,
  getLatestConfig,
  hasOwnershipMarker,
  isGeneratedServiceName,
  isMissingForbidden,
  isRetentionMessage,
  listProducerServices,
  ownedByAlchemy,
  ownershipLabels,
  parseTitle,
  ServiceNotResolved,
  toServiceName,
  undeleteService,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export { ServiceNotResolved };

export type ServiceProps = {
  /**
   * DNS service name (for example
   * `hello.endpoints.my-project.cloud.goog`). If omitted, Alchemy
   * generates `{alch-…}.endpoints.{project}.cloud.goog` from the stack,
   * stage, and logical id. Immutable — changing it replaces the service.
   * After delete the name is reserved for 30 days; reconcile undeletes
   * instead of recreating.
   */
  serviceName?: string;
  /**
   * Display title stored on the service config. Managed services have no
   * labels field, so Alchemy prefixes an `[alchemy …]` ownership marker
   * (also written to `documentation.summary`) and strips it from
   * attributes. `list` / nuke use the marker (or the generated `alch-`
   * name prefix).
   */
  title?: string;
  /**
   * Producer project id. Defaults to the current stack project.
   * Immutable — changing it replaces the service.
   */
  producerProjectId?: string;
};

export type Service = Resource<
  "GCP.Servicemanagement.Service",
  ServiceProps,
  {
    /** DNS service name. */
    serviceName: string;
    /** Producer project id. */
    producerProjectId: string;
    /** Project id used when the service was reconciled. */
    project: string;
    /** User-facing title with the Alchemy ownership prefix stripped. */
    title: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Google Service Management managed service (Cloud Endpoints producer
 * service).
 *
 * A managed service is identity-only and immutable. Create and delete
 * return long-running operations. After delete the name stays reserved
 * for 30 days — reconcile undeletes rather than recreating. There is no
 * labels field; Alchemy stamps ownership into the service config title
 * and documentation summary so `list` / `pnpm nuke:gcp` can find owned
 * services. Changing `serviceName` or `producerProjectId` replaces the
 * service. `title` updates in place by writing a new config version.
 *
 * ### Creating a Service
 * **Example:** Generated Endpoints name
 * ```typescript
 * const api = yield* GCP.Servicemanagement.Service("Hello", {
 *   title: "Hello API",
 * });
 * ```
 *
 * **Example:** Explicit DNS name
 * ```typescript
 * const api = yield* GCP.Servicemanagement.Service("Hello", {
 *   serviceName: "hello.endpoints.my-project.cloud.goog",
 *   title: "Hello API",
 * });
 * ```
 *
 * ### Updating a Service
 * **Example:** Change the display title
 * ```typescript
 * const api = yield* GCP.Servicemanagement.Service("Hello", {
 *   serviceName: existing.serviceName,
 *   title: "Hello API v2",
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category Servicemanagement
 */
export const Service = Resource<Service>("GCP.Servicemanagement.Service");

const toAttrs = (
  service: servicemanagement.ManagedService,
  project: string,
  title: string | undefined,
) => {
  const serviceName = service.serviceName ?? "";
  return {
    serviceName,
    producerProjectId: service.producerProjectId ?? project,
    project,
    title: parseTitle(title).title,
  };
};

const toAttrsLive = (
  service: servicemanagement.ManagedService,
  project: string,
) =>
  Effect.gen(function* () {
    const serviceName = service.serviceName ?? "";
    const config =
      serviceName.length > 0 ? yield* getLatestConfig(serviceName) : undefined;
    return toAttrs(service, project, configOwnershipText(config));
  });

const desiredProducer = (
  news: ServiceProps,
  project: string,
  existing?: string,
) => news.producerProjectId ?? existing ?? project;

export const ServiceProvider = () =>
  Provider.succeed(Service, {
    stables: ["serviceName", "producerProjectId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousName = olds?.serviceName ?? output?.serviceName;
      if (
        previousName !== undefined &&
        news.serviceName !== undefined &&
        news.serviceName !== previousName
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousProducer =
        olds?.producerProjectId ?? output?.producerProjectId;
      if (
        previousProducer !== undefined &&
        news.producerProjectId !== undefined &&
        news.producerProjectId !== previousProducer
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceName = yield* toServiceName(
        id,
        olds?.serviceName,
        output?.serviceName,
        env.project,
      );
      const existing = yield* getByName(serviceName);
      if (existing === undefined) return undefined;
      const attrs = yield* toAttrsLive(existing, env.project);
      const config = yield* getLatestConfig(serviceName);
      const stamped = configOwnershipText(config);
      if (yield* ownedByAlchemy(id, stamped)) return attrs;
      if (isGeneratedServiceName(serviceName, env.project)) return attrs;
      return Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const services = yield* listProducerServices(env.project);
        const owned = yield* Effect.forEach(
          services,
          (service) =>
            Effect.gen(function* () {
              const serviceName = service.serviceName ?? "";
              if (serviceName.length === 0) return undefined;
              if (isGeneratedServiceName(serviceName, env.project)) {
                return yield* toAttrsLive(service, env.project);
              }
              const config = yield* getLatestConfig(serviceName);
              if (!hasOwnershipMarker(configOwnershipText(config))) {
                return undefined;
              }
              return toAttrs(service, env.project, configOwnershipText(config));
            }),
          { concurrency: 4 },
        );
        return owned.filter(
          (item): item is NonNullable<typeof item> => item !== undefined,
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const serviceName = yield* toServiceName(
        id,
        news.serviceName,
        output?.serviceName,
        env.project,
      );
      const producerProjectId = desiredProducer(
        news,
        env.project,
        output?.producerProjectId,
      );
      const labels = yield* ownershipLabels(id);
      const desiredTitle = encodeTitle(labels, news.title);

      let current = yield* getByName(serviceName);

      if (current === undefined) {
        const created = yield* servicemanagement
          .createServices({
            body: {
              serviceName,
              producerProjectId,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
            Effect.catchTag("BadRequest", (error) =>
              isRetentionMessage(error.message)
                ? Effect.succeed(undefined)
                : Effect.fail(error),
            ),
          );
        if (created !== undefined && created.done === true) {
          yield* waitForOperation(created);
        }
        current =
          created !== undefined
            ? yield* waitUntilExists(serviceName).pipe(
                Effect.catchTag(
                  "GCP.Servicemanagement.ServiceNotResolved",
                  () => Effect.succeed(undefined),
                ),
              )
            : yield* getByName(serviceName);
      }

      if (current === undefined) {
        current = yield* undeleteService(serviceName);
      }

      if (current === undefined) {
        current = yield* waitUntilExists(serviceName);
      }

      if (current === undefined) {
        return yield* new ServiceNotResolved({ serviceName });
      }

      let config = yield* getLatestConfig(serviceName);
      const observedTitle = configOwnershipText(config) ?? "";
      if (observedTitle !== desiredTitle) {
        const written = yield* servicemanagement
          .createServicesConfigs({
            serviceName,
            body: {
              name: serviceName,
              title: desiredTitle,
              producerProjectId,
              documentation: { summary: desiredTitle },
            },
          })
          .pipe(
            Effect.retry({
              while: (error) =>
                error._tag === "NotFound" ||
                (error._tag === "Forbidden" &&
                  isMissingForbidden(error.message)),
              times: 8,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (written !== undefined) {
          config = written;
        }
      }

      const latest = yield* getByName(serviceName);
      return toAttrs(
        latest ?? current,
        env.project,
        configOwnershipText(config) ?? desiredTitle,
      );
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* servicemanagement
        .deleteServices({ serviceName: output.serviceName })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("1 second"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
          Effect.catchTag("Forbidden", (error) =>
            isMissingForbidden(error.message)
              ? Effect.succeed(undefined)
              : Effect.fail(error),
          ),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true }).pipe(
          Effect.catchTag(
            "GCP.Servicemanagement.OperationPending",
            () => Effect.void,
          ),
        );
      }
      yield* waitUntilGone(output.serviceName);
    }),
  });
