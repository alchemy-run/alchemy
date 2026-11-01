import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { disableService, ensureServiceEnabled, getServiceStatus } from "../internal/enable.ts";
import type { Providers } from "../Providers.ts";

export type ServiceProps = {
  /**
   * STACKIT service id, e.g. `cloud.stackit.ske`. List the ids available
   * to a project with `stackit service-enablement list` or the Service
   * Enablement API. Changing it replaces the resource.
   */
  serviceId: string;
  /**
   * Project to enable the service in. Defaults to the profile's project.
   * Changing it replaces the resource.
   */
  projectId?: string;
  /**
   * Region of the enablement. Defaults to the profile's region. Changing it
   * replaces the resource.
   */
  region?: string;
  /**
   * Disable the service when this resource is deleted — but only if this
   * resource enabled it (`enabledByAlchemy`). A service that was already
   * enabled when the resource was first deployed is always left enabled.
   * Set `false` to leave the service enabled in every case, e.g. when
   * resources outside this stack may start using it.
   * @default true
   */
  disableOnDelete?: boolean;
};

export type Service = Resource<
  "Stackit.ServiceEnablement.Service",
  ServiceProps,
  {
    /** STACKIT service id. */
    serviceId: string;
    /** Project the service is enabled in. */
    projectId: string;
    /** Region of the enablement. */
    region: string;
    /** Enablement state; `ENABLED` after every successful deploy. */
    state: string;
    /**
     * Whether this resource enabled the service. `false` when the service
     * was already enabled (by the console, another stack, a dependency, or
     * another Alchemy resource) before this resource was first deployed.
     */
    enabledByAlchemy: boolean;
    /** Whether delete disables the service (see `disableOnDelete`). */
    disableOnDelete: boolean;
    /** Services STACKIT enabled along with this one (hard dependencies). */
    hardDependencies: string[];
  },
  never,
  Providers
>;

/**
 * Enables a STACKIT service (a product API such as SKE, DNS or Object
 * Storage) for a project, through the Service Enablement API.
 *
 * Most Alchemy STACKIT resources enable the service they need on their
 * own, so declare this resource only to enable a service explicitly — for
 * example before using it outside Alchemy, or to disable it again when the
 * stack is destroyed.
 *
 * Ownership: service enablement has no labels, so Alchemy cannot mark a
 * service as its own. Instead the resource records whether *it* enabled
 * the service (`enabledByAlchemy`). An already-enabled service is taken
 * over without `--adopt` — enabling it is a no-op and deleting the resource
 * leaves it enabled. Disabling is project-wide and breaks every resource
 * of that service, so delete disables only a service this resource enabled
 * (and only while `disableOnDelete` is not `false`). Hard dependencies
 * STACKIT enabled alongside the service are never disabled. For the same
 * reason the resource is skipped by `alchemy unsafe nuke`.
 *
 * ### Enabling a service
 * **Example:** Enable Kubernetes Engine (SKE) in the profile's project
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const ske = yield* Stackit.ServiceEnablement.Service("Ske", {
 *   serviceId: "cloud.stackit.ske",
 * });
 * ```
 *
 * **Example:** Enable a service in another project and region
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * yield* Stackit.ServiceEnablement.Service("Ske", {
 *   serviceId: "cloud.stackit.ske",
 *   projectId: "00000000-0000-0000-0000-000000000000",
 *   region: "eu01",
 * });
 * ```
 *
 * ### Keeping a service enabled
 * **Example:** Never disable the service on destroy
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * yield* Stackit.ServiceEnablement.Service("Ske", {
 *   serviceId: "cloud.stackit.ske",
 *   disableOnDelete: false,
 * });
 * ```
 *
 * @resource
 * @product Service Enablement
 */
export const Service = Resource<Service>("Stackit.ServiceEnablement.Service");

export const ServiceProvider = () =>
  Provider.succeed(Service, {
    stables: ["serviceId", "projectId", "region"],
    // A project setting, not a discrete resource: nuke must not disable
    // services project-wide, and there is no ownership marker to filter by.
    nuke: { singleton: true },

    diff: Effect.fn(function* ({ news, olds, output }) {
      // Delete-first: an unresolved prop can resolve to the current service,
      // and a create-first replacement would see it enabled, record that
      // Alchemy didn't enable it, and let the old generation disable it.
      if (
        output !== undefined &&
        hasUnresolvedTrigger<ServiceProps>(news, ["serviceId", "projectId", "region"])
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      if (output === undefined && !isResolved(news)) return undefined;
      const resolved = triggerProps<ServiceProps>(news);
      const env = yield* StackitEnvironment.current;
      const projectId = resolved.projectId ?? env.projectId;
      const region = resolved.region ?? env.region;
      const previous = {
        serviceId: output?.serviceId ?? olds?.serviceId,
        projectId: output?.projectId ?? olds?.projectId,
        region: output?.region ?? olds?.region,
      };
      if (
        (previous.serviceId !== undefined && previous.serviceId !== resolved.serviceId) ||
        (previous.projectId !== undefined && previous.projectId !== projectId) ||
        (previous.region !== undefined && previous.region !== region)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const env = yield* StackitEnvironment.current;
      const serviceId = output?.serviceId ?? olds?.serviceId;
      if (serviceId === undefined) return undefined;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const region = output?.region ?? olds?.region ?? env.region;
      const status = yield* getServiceStatus({ projectId, region, serviceId }).pipe(
        Effect.catchTag("NotFound", () => Effect.undefined),
      );
      if (status?.state !== "ENABLED" && status?.state !== "ENABLING") return undefined;
      // No ownership marker exists, and taking over an enabled service is
      // harmless (see the resource docs), so never `Unowned`.
      return {
        serviceId,
        projectId,
        region,
        state: status.state,
        enabledByAlchemy: output?.enabledByAlchemy ?? false,
        disableOnDelete: output?.disableOnDelete ?? olds?.disableOnDelete !== false,
        hardDependencies: [...(status.dependencies?.hard ?? [])],
      };
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const region = news.region ?? output?.region ?? env.region;
      // Observe + ensure + wait: one idempotent call.
      const { status, enabledNow } = yield* ensureServiceEnabled({
        projectId,
        region,
        serviceId: news.serviceId,
      });
      return {
        serviceId: news.serviceId,
        projectId,
        region,
        state: status.state ?? "ENABLED",
        // Provenance can't be observed in the cloud; keep the first answer.
        enabledByAlchemy: (output?.enabledByAlchemy ?? false) || enabledNow,
        disableOnDelete: news.disableOnDelete !== false,
        hardDependencies: [...(status.dependencies?.hard ?? [])],
      };
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.enabledByAlchemy || !output.disableOnDelete) return;
      yield* disableService({
        projectId: output.projectId,
        region: output.region,
        serviceId: output.serviceId,
      });
    }),
  });
