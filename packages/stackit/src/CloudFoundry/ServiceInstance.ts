import * as cf from "@distilled.cloud/stackit/cloud_foundry";
import { Unowned } from "alchemy/AdoptPolicy";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { readGeneration } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { sameMembers, secretsDiffer } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import {
  desiredGenerationLabels,
  hasAlchemyLabels,
  hasInstanceLabel,
  stripInternalLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  awaitJob,
  CF_NAME_MAX_LENGTH,
  collectCloudFoundryItems,
  labelUpdate,
  observedLabels,
  relationId,
  relationTo,
  requireGuid,
  SERVICE_INSTANCE_TIMEOUT,
  usableCredentials,
  withCloudFoundry,
  type CloudFoundryCredentialsProps,
} from "./internal.ts";

export interface ServiceInstanceProps {
  /** Space holding the instance. Changing it replaces the instance. */
  spaceId: string;
  /** A user with `space_developer` in the space. Updates in place. */
  credentials: CloudFoundryCredentialsProps;
  /**
   * Name of the instance. Updates in place.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * Name of the marketplace offering, as `cf marketplace` lists it. With {@link plan},
   * this makes a managed instance; without them, the instance is user-provided. Changing
   * between the two, or to another offering, replaces the instance: a plan can only move within
   * its offering.
   */
  offering?: string;
  /** Name of the plan in {@link offering}. Updates in place. */
  plan?: string;
  /**
   * Parameters for the service broker of a managed instance. Sent again when they change
   * from the last deploy: the broker decides what they do, and they aren't read back.
   */
  parameters?: Record<string, unknown>;
  /**
   * What a user-provided instance hands to the apps it is bound to, through
   * `VCAP_SERVICES`. Updates in place.
   */
  serviceCredentials?: Record<string, string | Redacted.Redacted<string>>;
  /** Tags apps can find the instance by in `VCAP_SERVICES`. Updates in place. */
  tags?: string[];
  /** Where a user-provided instance streams bound apps' logs. Updates in place. */
  syslogDrainUrl?: string;
  /** Route service of a user-provided instance. Updates in place. */
  routeServiceUrl?: string;
  /** User labels. Alchemy's ownership labels are always merged in. Updates in place. */
  labels?: Record<string, string>;
}

export interface ServiceInstanceAttributes {
  /** Cloud Foundry id of the instance. */
  serviceInstanceId: string;
  /** Name of the instance. */
  name: string;
  /** Space holding the instance. */
  spaceId: string;
  /** `managed`, from the marketplace, or `user-provided`. */
  type: "managed" | "user-provided";
  /** Plan of a managed instance. */
  servicePlanId: string | undefined;
  /** Dashboard of a managed instance, if the broker has one. */
  dashboardUrl: string | undefined;
  /** Tags of the instance. */
  tags: string[];
  /** State of the last operation: `succeeded` after a deploy. */
  lastOperationState: string | undefined;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
}

export type ServiceInstance = Resource<
  "Stackit.CloudFoundry.ServiceInstance",
  ServiceInstanceProps,
  ServiceInstanceAttributes,
  never,
  Providers
>;

/** The marketplace has no such plan for this space. */
export class ServicePlanNotFound extends Data.TaggedError(
  "Stackit.CloudFoundry.ServicePlanNotFound",
)<{
  readonly resourceName: string;
  readonly offering: string;
  readonly plan: string;
  readonly message: string;
}> {}

/** `plan` and `offering` come together. */
export class ServicePlanIncomplete extends Data.TaggedError(
  "Stackit.CloudFoundry.ServicePlanIncomplete",
)<{
  readonly resourceName: string;
  readonly message: string;
}> {}

/**
 * A service instance in a STACKIT Cloud Foundry space: a managed one from the marketplace
 * (`offering` and `plan`), or a user-provided one holding `serviceCredentials`. Bind it
 * to an app with the app's `services`, and read it from `VCAP_SERVICES`.
 *
 * Changing `spaceId`, `offering`, or between managed and user-provided, replaces the instance.
 * Everything else updates in place. Deploys wait for the broker, and destroys wait until
 * the instance is gone.
 *
 * Ownership is tracked with Cloud Foundry labels (`alchemy.stack`, `alchemy.stage`,
 * `alchemy.id`, `alchemy.instance`). An instance with the same explicit name that lacks
 * them is reported as unowned, and only taken over with `--adopt`. `alchemy unsafe nuke`
 * can't list instances, because it has no Cloud Foundry credentials: they go with their
 * organization.
 *
 * ### Creating an Instance
 * **Example:** A managed instance from the marketplace
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import { Deployer } from "./deployer.ts";
 *
 * const deployer = yield* Deployer;
 * const database = yield* Stackit.CloudFoundry.ServiceInstance("Db", {
 *   ...deployer,
 *   offering: "postgresql",
 *   plan: "small",
 *   parameters: { version: "16" },
 * });
 * ```
 *
 * **Example:** A user-provided instance holding credentials
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Redacted from "effect/Redacted";
 * import { Deployer } from "./deployer.ts";
 *
 * const deployer = yield* Deployer;
 * const payments = yield* Stackit.CloudFoundry.ServiceInstance("Payments", {
 *   ...deployer,
 *   serviceCredentials: { apiKey: Redacted.make("...") },
 *   tags: ["payments"],
 * });
 * ```
 *
 * ### Binding it to an App
 * **Example:** Read the instance through `VCAP_SERVICES`
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import { Deployer } from "./deployer.ts";
 *
 * const deployer = yield* Deployer;
 * const database = yield* Stackit.CloudFoundry.ServiceInstance("Db", {
 *   ...deployer,
 *   offering: "postgresql",
 *   plan: "small",
 * });
 * const app = yield* Stackit.CloudFoundry.App("Api", {
 *   ...deployer,
 *   main: "./src/api.ts",
 *   registry: { repository: "ghcr.io/my-org/api" },
 *   services: [database.serviceInstanceId],
 * });
 * ```
 *
 * :::caution[Changing `spaceId`, `offering`, or the kind of instance, replaces the Instance]
 * A managed instance's data goes with it, unless its broker keeps it.
 * :::
 *
 * @resource
 * @product STACKIT Cloud Foundry
 * @category CloudFoundry
 */
export const ServiceInstance = Resource<ServiceInstance>("Stackit.CloudFoundry.ServiceInstance");

/** An instance as the API answers it, whichever kind it is. */
type LiveInstance = cf.ManagedServiceInstance | cf.UserProvidedServiceInstance;

const isManaged = (news: Pick<ServiceInstanceProps, "offering" | "plan">) =>
  news.offering !== undefined || news.plan !== undefined;

const toName = (id: string, name: string | undefined) =>
  name !== undefined
    ? Effect.succeed(name)
    : createPhysicalName({ id, lowercase: true, maxLength: CF_NAME_MAX_LENGTH });

/** A user-provided instance has no broker to wait for, so no last operation. */
const lastOperationOf = (instance: LiveInstance) =>
  instance.type === "managed" ? instance.last_operation : undefined;

const toAttrs = (
  instance: LiveInstance,
  id: string,
  spaceId: string,
): ServiceInstanceAttributes => {
  const managed = instance.type === "managed" ? instance : undefined;
  return {
    serviceInstanceId: id,
    name: instance.name,
    spaceId,
    type: instance.type,
    servicePlanId: relationId(managed?.relationships?.service_plan),
    dashboardUrl: managed?.dashboard_url ?? undefined,
    tags: [...(instance.tags ?? [])],
    lastOperationState: lastOperationOf(instance)?.state,
    labels: stripInternalLabels(observedLabels(instance)),
  };
};

const getInstanceOrUndefined = (guid: string) =>
  cf.getServiceInstance({ guid }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const findByName = (spaceId: string, name: string) =>
  collectCloudFoundryItems(
    cf.listServiceInstances.items({ per_page: 100, space_guids: spaceId, names: name }),
  ).pipe(Effect.map((instances) => instances.find((instance) => instance.name === name)));

const resolvePlan = (id: string, spaceId: string, offering: string, plan: string) =>
  Effect.gen(function* () {
    const plans = yield* collectCloudFoundryItems(
      cf.listServicePlans.items({
        per_page: 100,
        names: plan,
        service_offering_names: offering,
        space_guids: spaceId,
      }),
    );
    const guid = plans[0]?.guid;
    if (guid === undefined) {
      return yield* new ServicePlanNotFound({
        resourceName: id,
        offering,
        plan,
        message: `${id}: the marketplace has no plan ${plan} of ${offering} for this space`,
      });
    }
    return guid;
  });

const sortKeys = (value: unknown): unknown =>
  Redacted.isRedacted(value)
    ? sortKeys(Redacted.value(value))
    : Array.isArray(value)
      ? value.map(sortKeys)
      : value !== null && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([key, entry]) => [key, sortKeys(entry)]),
          )
        : value;

/** Whether two JSON values differ, whatever order their keys are in. */
const jsonDiffers = (left: unknown, right: unknown) =>
  secretsDiffer(sortKeys(left), sortKeys(right));

const waitForOperation = (id: string, guid: string) =>
  waitFor({
    resource: `Cloud Foundry service instance ${id}`,
    read: cf.getServiceInstance({ guid }),
    ready: (instance) => {
      const operation = lastOperationOf(instance);
      return operation === undefined || operation.state === "succeeded";
    },
    failed: (instance) => {
      const operation = lastOperationOf(instance);
      return operation?.state === "failed" ? (operation.description ?? "failed") : undefined;
    },
    state: (instance) => lastOperationOf(instance)?.state,
    timeout: SERVICE_INSTANCE_TIMEOUT,
    maxInterval: "30 seconds",
  });

export const ServiceInstanceProvider = () =>
  Provider.succeed(ServiceInstance, {
    stables: ["serviceInstanceId", "spaceId", "type"],
    nuke: { dependsOn: ["Stackit.CloudFoundry.Space"] },

    // Listing needs Cloud Foundry credentials, which nuke doesn't have and only state
    // holds. Instances go with their space.
    list: () => Effect.succeed([]),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An unresolved space can resolve to the one the instance is in, and an explicit
      // name can't exist twice there. A generated name carries the generation.
      if (hasUnresolvedTrigger<ServiceInstanceProps>(news, ["spaceId", "offering"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<ServiceInstanceProps>(news, "name") !== undefined,
        } as const;
      }
      const resolved = triggerProps<ServiceInstanceProps>(news);
      // Only whether they are set matters, and an unresolved value is set.
      const type = isManaged(resolved) ? "managed" : "user-provided";
      if (resolved.spaceId !== output.spaceId) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // A plan update stays within its offering, so another offering is another instance. Only
      // `olds` knows the offering: the instance holds its plan's id.
      const otherOffering =
        olds?.offering !== undefined &&
        resolved.offering !== undefined &&
        resolved.offering !== olds.offering;
      if (type !== output.type || otherOffering) {
        return {
          action: "replace",
          deleteFirst: rawProp<ServiceInstanceProps>(news, "name") !== undefined,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      if (!usableCredentials(olds?.credentials)) return undefined;
      const { credentials, spaceId } = olds;
      return yield* Effect.gen(function* () {
        let instance =
          output?.serviceInstanceId !== undefined
            ? yield* getInstanceOrUndefined(output.serviceInstanceId)
            : undefined;
        if (instance === undefined) {
          const name = output?.name ?? (yield* toName(id, olds.name));
          instance = yield* findByName(output?.spaceId ?? spaceId, name);
        }
        if (instance?.guid === undefined) return undefined;
        const attrs = toAttrs(instance, instance.guid, output?.spaceId ?? spaceId);
        if (previous?.serviceInstanceId === instance.guid && previous.spaceId === attrs.spaceId) {
          return attrs;
        }
        // Once state or a replacement exists, only this generation is ours. An older generation
        // still waiting for its delete would otherwise become the new one, and then be deleted.
        const labels = observedLabels(instance);
        const generation = readGeneration({ instanceId, output, previous });
        const ours =
          (yield* hasAlchemyLabels(id, labels)) &&
          (generation === undefined || hasInstanceLabel(generation, labels));
        return ours ? attrs : Unowned(attrs);
      }).pipe(withCloudFoundry(id, credentials));
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
      const { spaceId, credentials } = news;
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);
      const generatedName = yield* toName(id, undefined);
      const name = news.name ?? generatedName;
      const managed = isManaged(news);
      if (managed && (news.offering === undefined || news.plan === undefined)) {
        return yield* new ServicePlanIncomplete({
          resourceName: id,
          message: `${id}: \`offering\` and \`plan\` come together`,
        });
      }

      return yield* Effect.gen(function* () {
        const planId = managed
          ? yield* resolvePlan(id, spaceId, news.offering!, news.plan!)
          : undefined;
        const desiredCredentials = news.serviceCredentials;

        // 1. Observe. `output` only speaks for this instance in this space.
        let instance =
          output?.spaceId === spaceId
            ? yield* getInstanceOrUndefined(output.serviceInstanceId)
            : undefined;
        if (instance === undefined) {
          const found = yield* findByName(spaceId, name);
          // Crash recovery: this generation's labels.
          const foundLabels = observedLabels(found ?? {});
          if (
            found !== undefined &&
            (yield* hasAlchemyLabels(id, foundLabels)) &&
            hasInstanceLabel(instanceId, foundLabels)
          ) {
            instance = found;
          }
        }

        // 2. Ensure. A managed create answers 202 with no body: read it back by name.
        if (instance === undefined) {
          const created = yield* cf.createServiceInstance(
            managed
              ? {
                  type: "managed",
                  name,
                  relationships: {
                    space: relationTo(spaceId),
                    service_plan: relationTo(planId!),
                  },
                  ...(news.parameters !== undefined ? { parameters: news.parameters } : {}),
                  ...(news.tags !== undefined ? { tags: [...news.tags] } : {}),
                  metadata: { labels },
                }
              : {
                  type: "user-provided",
                  name,
                  relationships: { space: relationTo(spaceId) },
                  ...(desiredCredentials !== undefined ? { credentials: desiredCredentials } : {}),
                  ...(news.tags !== undefined ? { tags: [...news.tags] } : {}),
                  ...(news.syslogDrainUrl !== undefined
                    ? { syslog_drain_url: news.syslogDrainUrl }
                    : {}),
                  ...(news.routeServiceUrl !== undefined
                    ? { route_service_url: news.routeServiceUrl }
                    : {}),
                  metadata: { labels },
                },
          );
          yield* awaitJob(
            `Cloud Foundry service instance ${name} create`,
            created.location,
            SERVICE_INSTANCE_TIMEOUT,
          );
          instance =
            created.guid !== undefined
              ? yield* getInstanceOrUndefined(created.guid)
              : yield* findByName(spaceId, name);
        }
        const guid = yield* requireGuid(`service instance ${name}`, instance ?? {});
        const live = instance!;

        // 3. Sync. One PATCH with what differs from what's observed. Parameters can't be
        // read back, so they compare with the last deploy.
        const liveManaged = live.type === "managed" ? live : undefined;
        const liveProvided = live.type === "user-provided" ? live : undefined;
        const labelChanges = labelUpdate(observedLabels(live), labels, olds?.labels);
        const observedCredentials =
          desiredCredentials !== undefined && liveProvided !== undefined
            ? yield* cf.getServiceInstanceCredentials({ guid })
            : undefined;
        const delta: Omit<cf.UpdateServiceInstanceRequest, "guid"> = {
          ...(live.name !== name ? { name } : {}),
          ...(news.tags !== undefined && !sameMembers(live.tags, news.tags)
            ? { tags: [...news.tags] }
            : {}),
          ...(planId !== undefined &&
          relationId(liveManaged?.relationships?.service_plan) !== planId
            ? { relationships: { service_plan: relationTo(planId) } }
            : {}),
          ...(news.parameters !== undefined && jsonDiffers(olds?.parameters, news.parameters)
            ? { parameters: news.parameters }
            : {}),
          ...(desiredCredentials !== undefined &&
          jsonDiffers(observedCredentials, desiredCredentials)
            ? { credentials: desiredCredentials }
            : {}),
          ...(news.syslogDrainUrl !== undefined &&
          liveProvided !== undefined &&
          liveProvided.syslog_drain_url !== news.syslogDrainUrl
            ? { syslog_drain_url: news.syslogDrainUrl }
            : {}),
          ...(news.routeServiceUrl !== undefined &&
          liveProvided !== undefined &&
          liveProvided.route_service_url !== news.routeServiceUrl
            ? { route_service_url: news.routeServiceUrl }
            : {}),
          ...(labelChanges !== undefined ? { metadata: { labels: labelChanges } } : {}),
        };
        if (Object.keys(delta).length > 0) {
          const updated = yield* cf.updateServiceInstance({ guid, ...delta });
          yield* awaitJob(
            `Cloud Foundry service instance ${name} update`,
            updated.location,
            SERVICE_INSTANCE_TIMEOUT,
          );
        }

        // 4. Return, once the broker has finished.
        const settled = yield* waitForOperation(name, guid);
        return toAttrs(settled, guid, spaceId);
      }).pipe(withCloudFoundry(id, credentials));
    }),

    delete: Effect.fn(function* ({ id, olds, output }) {
      const guid = output.serviceInstanceId;
      const resource = `Cloud Foundry service instance ${output.name}`;
      yield* Effect.gen(function* () {
        const deleted = yield* cf
          .deleteServiceInstance({ guid })
          .pipe(Effect.catchTag("NotFound", () => Effect.undefined));
        if (deleted !== undefined) {
          yield* awaitJob(`${resource} delete`, deleted.location, SERVICE_INSTANCE_TIMEOUT);
        }
        yield* waitUntilGone({
          resource,
          read: getInstanceOrUndefined(guid),
          failed: (instance) => {
            const operation = lastOperationOf(instance);
            return operation?.type === "delete" && operation.state === "failed"
              ? (operation.description ?? "delete failed")
              : undefined;
          },
          state: (instance) => lastOperationOf(instance)?.state,
          timeout: SERVICE_INSTANCE_TIMEOUT,
          maxInterval: "30 seconds",
        });
      }).pipe(withCloudFoundry(id, olds.credentials));
    }),
  });
