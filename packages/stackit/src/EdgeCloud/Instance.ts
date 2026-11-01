import * as edge from "@distilled.cloud/stackit/edge";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { conflictRetry, emptyToUndefined } from "../internal/displayNames.ts";
import { ensureServiceEnabled } from "../internal/enable.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  EDGE_SERVICE_ID,
  type EdgeScope,
  generatedDisplayName,
  getInstanceByNameOrUndefined,
  getInstanceOrUndefined,
  INSTANCE_TIMEOUT,
  isGeneratedDisplayName,
  isSameInstance,
  POLL,
} from "./internal.ts";

/** Another instance holds the display name, and nothing proves it is ours. */
export class InstanceNameTaken extends Data.TaggedError("Stackit.EdgeCloud.InstanceNameTaken")<{
  readonly resourceName: string;
  readonly message: string;
}> {}

export interface InstanceProps {
  /**
   * Name of the instance: 4 to 8 lowercase letters, digits or hyphens, starting with
   * a letter and ending with a letter or digit. Unique in a project and region.
   * STACKIT can't rename an instance, so changing it replaces the instance. Removing
   * it keeps the current name.
   *
   * @default a generated name of the form `a7-xxxxx`, holding part of this generation's instance id
   */
  displayName?: string;
  /**
   * Service plan, which sets the size of the instance, as a UUID.
   * `Stackit.EdgeCloud.ListPlans` lists what a project can use. Updates in place.
   */
  planId: string;
  /** Free text to tell instances apart, at most 256 characters. Updates in place. */
  description?: string;
  /** Project that owns the instance. Changing it replaces the instance. @default the profile's project */
  projectId?: string;
  /** Region of the instance. Changing it replaces the instance. @default the profile's region */
  region?: string;
}

/** One entry of an instance's IP allow list. The API has no operation to set them. */
export interface InstanceAclEntry {
  /** Unique id of the entry. */
  uuid: string;
  /** The IP CIDR range of the entry. */
  ipRange: string;
  /** Description of the entry, if any. */
  description: string | undefined;
}

export interface InstanceAttributes {
  /**
   * Id of the instance, `<displayName>-<project hash>`, so another instance created
   * under the same name in the same project has the same id.
   */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Region of the instance. */
  region: string;
  /** Name of the instance. */
  displayName: string;
  /** Service plan of the instance. */
  planId: string;
  /** Description of the instance, if any. */
  description: string | undefined;
  /** Instance status; `active` after a deploy. */
  status: string;
  /** URL of the instance's management UI. */
  frontendUrl: string;
  /** When the creation of the instance was triggered. */
  created: string;
  /** The IP allow list the API reports for the instance. */
  acl: InstanceAclEntry[];
}

export type Instance = Resource<
  "Stackit.EdgeCloud.Instance",
  InstanceProps,
  InstanceAttributes,
  never,
  Providers
>;

/**
 * A STACKIT Edge Cloud instance: the control plane for Kubernetes on hardware you
 * provide. The API is a beta, and STACKIT's Terraform provider describes the service
 * as a private beta you ask support to join. Its public price list has no row for it, so check the price with STACKIT:
 * a plan's `minEdgeHosts` is the minimum number of hosts charged.
 *
 * The plan and description update in place. The name, project and region replace
 * the instance, and a replacement is a new control plane with a new id. Alchemy
 * carries nothing over from the old one. Deploys wait until the instance reports
 * `active`.
 *
 * The API has no labels. A generated name holds this generation's instance id, so
 * it proves ownership. An explicit name found without state is reported as unowned
 * and only taken over with `--adopt`, which includes one a crash left behind
 * between the create call and the state write.
 *
 * ### Creating an Instance
 * **Example:** An instance on a chosen plan
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const edge = yield* Stackit.EdgeCloud.Instance("Edge", {
 *   planId: "11111111-2222-3333-4444-555555555555",
 * });
 * ```
 *
 * **Example:** A chosen name and a description
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const edge = yield* Stackit.EdgeCloud.Instance("Edge", {
 *   displayName: "factory1",
 *   planId: "11111111-2222-3333-4444-555555555555",
 *   description: "Factory floor, line 1",
 * });
 * ```
 *
 * ### Reaching the Cluster
 * **Example:** Mint a kubeconfig for tools that manage the hosts
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const edge = yield* Stackit.EdgeCloud.Instance("Edge", {
 *   planId: "11111111-2222-3333-4444-555555555555",
 * });
 * const access = yield* Stackit.EdgeCloud.Kubeconfig("Access", {
 *   instanceId: edge.instanceId,
 *   expirationSeconds: 7 * 24 * 3600,
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Renaming creates a new control plane
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // The instance named `factory1` is deleted and `factory2` is created, with a new
 * // id, so anything using the old id has to follow.
 * const edge = yield* Stackit.EdgeCloud.Instance("Edge", {
 *   displayName: "factory2",
 *   planId: "11111111-2222-3333-4444-555555555555",
 * });
 * ```
 *
 * ### Cleaning Up <!-- api-prose -->
 * `alchemy unsafe nuke` finds instances by the shape of a generated name, because
 * there are no labels to find them by. An instance you named yourself in the form
 * `a7-xxxxx`, with five of `a-z` and `2-7`, looks the same, so keep such names out
 * of a project you nuke.
 *
 * @resource
 * @product STACKIT Edge Cloud
 * @category EdgeCloud
 */
export const Instance = Resource<Instance>("Stackit.EdgeCloud.Instance");

const toAttrs = (scope: EdgeScope, instance: edge.Instance): InstanceAttributes => ({
  instanceId: instance.id,
  projectId: scope.projectId,
  region: scope.region,
  displayName: instance.displayName,
  planId: instance.planId,
  description: emptyToUndefined(instance.description),
  status: instance.status,
  frontendUrl: instance.frontendUrl,
  created: instance.created,
  acl: (instance.acl?.ipAllowList ?? []).map((entry) => ({
    uuid: entry.uuid,
    ipRange: entry.ipRange,
    description: emptyToUndefined(entry.description),
  })),
});

const describeInstance = (instanceId: string) => `STACKIT Edge Cloud instance ${instanceId}`;

/**
 * Wait until the instance is `active` and `applied` holds, for a change just sent. A
 * read from before that change can't pass, and its `error` status doesn't count.
 * Before an instance reports anything (a create that isn't visible yet) the budget
 * decides.
 */
const waitForActive = (
  scope: EdgeScope,
  instanceId: string,
  applied: (instance: edge.Instance) => boolean = () => true,
) =>
  waitFor({
    resource: describeInstance(instanceId),
    read: getInstanceOrUndefined(scope, instanceId),
    ready: (instance) => instance?.status === "active" && applied(instance),
    failed: (instance) => {
      if (instance?.status === "deleting") return "it is being deleted";
      return instance?.status === "error" && applied(instance) ? "it reports error" : undefined;
    },
    state: (instance) => instance?.status ?? "not visible yet",
    timeout: INSTANCE_TIMEOUT,
    ...POLL,
  }).pipe(
    // `ready` only passes an instance.
    Effect.map((instance) => instance as edge.Instance),
  );

const waitForGone = (scope: EdgeScope, instanceId: string) =>
  waitUntilGone({
    resource: describeInstance(instanceId),
    read: getInstanceOrUndefined(scope, instanceId),
    state: (instance) => instance.status,
    timeout: INSTANCE_TIMEOUT,
    ...POLL,
  });

/** Compared normalized: the API may echo an unset text as empty. */
const descriptionDiffers = (instance: edge.Instance, news: InstanceProps) =>
  emptyToUndefined(instance.description) !== emptyToUndefined(news.description);

const inSync = (instance: edge.Instance, news: InstanceProps) =>
  instance.planId === news.planId && !descriptionDiffers(instance, news);

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: ["instanceId", "displayName", "projectId", "region", "created"],

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const { instances } = yield* edge.listInstances({
        projectId: scope.projectId,
        regionId: scope.region,
      });
      return instances
        .filter(
          (instance) =>
            instance.status !== "deleting" && isGeneratedDisplayName(instance.displayName),
        )
        .map((instance) => toAttrs(scope, instance));
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An explicit name can resolve to the one the old instance holds, and it can't
      // exist twice. A generated name carries the generation, so it never collides.
      if (hasUnresolvedTrigger<InstanceProps>(news, ["displayName", "projectId", "region"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<InstanceProps>(news, "displayName") !== undefined,
        } as const;
      }
      const resolved = triggerProps<InstanceProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      // Removing `displayName` keeps the current one: a new name would be a new
      // instance. Every change here frees the old identity, so nothing has to go first.
      if (
        (resolved.displayName !== undefined && resolved.displayName !== output.displayName) ||
        scope.projectId !== output.projectId ||
        scope.region !== output.region
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // The plan and description update in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      if (output?.instanceId !== undefined) {
        const byId = yield* getInstanceOrUndefined(scope, output.instanceId);
        // A delete in flight: reconcile waits it out and creates a new one.
        if (byId?.status === "deleting") return undefined;
        if (byId !== undefined) {
          // The id only holds the name, so a later instance of that name has it too.
          const attrs = toAttrs(scope, byId);
          return isSameInstance(byId, output.created) ? attrs : Unowned(attrs);
        }
      }
      const generated = yield* generatedDisplayName(id);
      const displayName = output?.displayName ?? olds?.displayName ?? generated;
      const found = yield* getInstanceByNameOrUndefined(scope, displayName);
      if (found === undefined || found.status === "deleting") return undefined;
      const attrs = toAttrs(scope, found);
      // A generated name holds this generation's id, so it is ours.
      if (displayName === generated) return attrs;
      // The generation being replaced is ours, but only at its own scope: a name is
      // unique per project and region, so elsewhere it is someone else's.
      if (
        previous?.instanceId === found.id &&
        previous.displayName === found.displayName &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region &&
        isSameInstance(found, previous.created)
      ) {
        return attrs;
      }
      // Without labels, nothing else proves an explicit name is ours.
      return Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const generated = yield* generatedDisplayName(id);
      const displayName = news.displayName ?? output?.displayName ?? generated;
      const ids = { projectId: scope.projectId, regionId: scope.region };
      yield* ensureServiceEnabled({ ...scope, serviceId: EDGE_SERVICE_ID });

      // 1. Observe — `output` is a cache for the id, and only names the desired
      // instance in the same project and region, while it is the instance `output` was
      // read from. Without it, only this generation's generated name can be claimed;
      // `read` already reported an explicit one.
      let current: edge.Instance | undefined;
      if (
        output?.instanceId !== undefined &&
        output.projectId === scope.projectId &&
        output.region === scope.region
      ) {
        const live = yield* getInstanceOrUndefined(scope, output.instanceId);
        if (live !== undefined && isSameInstance(live, output.created)) current = live;
      }
      if (current === undefined) {
        const named = yield* getInstanceByNameOrUndefined(scope, displayName);
        // A delete in flight (an interrupted destroy): let it finish.
        if (named?.status === "deleting") {
          yield* waitForGone(scope, named.id);
        } else if (named !== undefined && displayName === generated) {
          current = named;
        } else if (named !== undefined) {
          return yield* new InstanceNameTaken({
            resourceName: displayName,
            message:
              `STACKIT Edge Cloud instance name '${displayName}' is already taken in project ` +
              `${scope.projectId}, by an instance this stack didn't create.`,
          });
        }
      } else if (current.status === "deleting") {
        yield* waitForGone(scope, current.id);
        current = undefined;
      }

      // 2. Ensure — a conflict on a generated name is a race we lost to ourselves. On
      // an explicit name it is someone else's instance, and still fails.
      if (current === undefined) {
        const created = yield* edge
          .createInstance({
            ...ids,
            displayName,
            planId: news.planId,
            ...(news.description !== undefined ? { description: news.description } : {}),
          })
          .pipe(
            Effect.catchTag("Conflict", (error) =>
              Effect.gen(function* () {
                const raced =
                  displayName === generated
                    ? yield* getInstanceByNameOrUndefined(scope, displayName)
                    : undefined;
                return raced ?? (yield* Effect.fail(error));
              }),
            ),
          );
        current = yield* waitForActive(scope, created.id);
      } else if (current.status === "reconciling") {
        // A change in flight settles first; the sync below compares what it left.
        const settling = current.id;
        current = yield* waitFor({
          resource: describeInstance(settling),
          read: edge.getInstance({ ...ids, instanceId: settling }),
          ready: (instance) => instance.status !== "reconciling",
          state: (instance) => instance.status,
          timeout: INSTANCE_TIMEOUT,
          ...POLL,
        });
      }
      const liveId = current.id;

      // 3. Sync — one PUT for the plan and description, against what is observed.
      if (!inSync(current, news)) {
        yield* edge
          .updateInstance({
            ...ids,
            instanceId: liveId,
            planId: news.planId,
            description: news.description ?? "",
          })
          .pipe(Effect.retry(conflictRetry));
        current = yield* waitForActive(scope, liveId, (instance) => inSync(instance, news));
      } else if (current.status !== "active") {
        current = yield* waitForActive(scope, liveId);
      }

      // 4. Return
      return toAttrs(scope, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const ids = { projectId: scope.projectId, regionId: scope.region };
      let current = yield* getInstanceOrUndefined(scope, output.instanceId);
      if (current === undefined) return;
      // The id only holds the name: a later instance of that name isn't this one, so
      // what state recorded is already gone.
      if (!isSameInstance(current, output.created)) return;
      if (current.status === "deleting") return yield* waitForGone(scope, current.id);
      // A change in flight (an interrupted deploy) settles first, in whatever state.
      if (current.status === "reconciling") {
        current = yield* waitFor({
          resource: describeInstance(output.instanceId),
          read: getInstanceOrUndefined(scope, output.instanceId),
          ready: (instance) => instance?.status !== "reconciling",
          state: (instance) => instance?.status ?? "gone",
          timeout: INSTANCE_TIMEOUT,
          ...POLL,
        });
        if (current === undefined) return;
      }
      yield* edge.deleteInstance({ ...ids, instanceId: current.id }).pipe(
        // The 409 this API documents is two writes at once: it clears by itself.
        Effect.retry(conflictRetry),
        Effect.catchTag("NotFound", () => Effect.void),
      );
      yield* waitForGone(scope, current.id);
    }),
  });
