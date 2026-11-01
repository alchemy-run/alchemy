import * as git from "@distilled.cloud/stackit/git";
import { Unowned } from "alchemy/AdoptPolicy";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { recordsEqual } from "alchemy/Util/equal";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { readGeneration } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { sameMembers } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import {
  desiredGenerationLabels,
  hasAlchemyLabels,
  hasInstanceLabel,
  isAlchemyOwned,
  labelRecord,
  stripInternalLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  getInstanceOrUndefined,
  INSTANCE_NAME_MAX_LENGTH,
  INSTANCE_TIMEOUT,
  retryWhileInTransition,
} from "./internal.ts";

/** A plan of a STACKIT Git instance. */
export type InstanceFlavor = "git-10" | "git-100";

/** Who gets e-mail notifications by default. */
export type DefaultEmailNotifications = "enabled" | "disabled" | "onmention" | "andyourown";

/** The CI settings of an instance. */
export interface InstancePipelines {
  /** Whether pipelines run on this instance. STACKIT bills runner minutes. */
  enabled?: boolean;
  /** The action URL of the pipelines. */
  actionUrl?: string;
}

/** The feature toggles of an instance. */
export interface InstanceFeatureToggle {
  /** Who gets e-mail notifications by default. */
  defaultEmailNotifications?: DefaultEmailNotifications;
  /**
   * Whether users can sign in with a local username and password. A `Stackit.Git.Repository`
   * that signs in with a `Stackit.Git.User`'s password may depend on it.
   */
  enableLocalLogin?: boolean;
  /** CI settings. */
  pipelines?: InstancePipelines;
}

export interface InstanceProps {
  /**
   * Name of the instance, which is also the first part of its URL: lowercase letters, digits and
   * hyphens, 5 to 32 characters, starting with a letter and ending in a letter or digit. Changing
   * it replaces the instance and **every repository on it**.
   *
   * If omitted, a unique name is generated from the stack, stage and logical ID.
   */
  name?: string;
  /**
   * Plan of the instance. The API can't change it, so changing it replaces the instance and
   * **every repository on it**. Omit it to leave the live plan alone.
   *
   * @default "git-10"
   */
  flavor?: InstanceFlavor;
  /**
   * The IP ranges, in CIDR notation, that may reach the instance. A machine or host using the
   * instance's Forgejo API needs its egress address in here. Omit to leave the live value alone.
   */
  acl?: string[];
  /** Whether the Admin IdP is enabled. Omit to leave the live value alone. */
  adminLogin?: boolean;
  /** Feature toggles. A field you omit keeps its live value. */
  featureToggle?: InstanceFeatureToggle;
  /**
   * User labels. Alchemy's ownership labels (`alchemy.stack`, `alchemy.stage`, `alchemy.id`) are
   * always merged in. Updates in place.
   */
  labels?: Record<string, string>;
  /**
   * Project that owns the instance. Defaults to the profile's project. Changing it replaces the
   * instance and **every repository on it**.
   */
  projectId?: string;
  /**
   * Allow destroying or replacing the instance, and with it every repository on it. The management
   * API can't list repositories, so Alchemy can't tell whether anything is on the instance: without
   * this, a delete stops with `Stackit.Git.InstanceDeleteRefused`, and a change that replaces the
   * instance fails at plan. Deploy it on its own first: an old instance keeps the props it was
   * deployed with.
   *
   * @default false
   */
  forceDestroy?: boolean;
}

export interface InstanceAttributes {
  /** STACKIT instance id. Stable across updates. */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Name of the instance. */
  name: string;
  /** Plan of the instance. */
  flavor: string;
  /** URL of the instance, and of its Forgejo API under `/api/v1`. */
  url: string;
  /** Forgejo version running on the instance. */
  version: string;
  /** `Ready` after a deploy. */
  state: git.InstanceState;
  /** Bytes of disk in use, when last deployed. */
  consumedDisk: string;
  /** Bytes of object storage in use, when last deployed. */
  consumedObjectStorage: string;
  /** When the instance's creation was triggered. */
  created: string;
  /** The IP ranges that may reach the instance. */
  acl: string[];
  /** Whether the Admin IdP is enabled. */
  adminLogin: boolean;
  /** Feature toggles. */
  featureToggle: git.FeatureToggle;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
}

export type Instance = Resource<
  "Stackit.Git.Instance",
  InstanceProps,
  InstanceAttributes,
  never,
  Providers
>;

/**
 * A STACKIT Git instance: a managed Forgejo server. It is billed per started hour by plan
 * (`git-10` or `git-100`).
 *
 * The name, plan and project are its identity: changing one replaces the instance, and everything
 * on it goes with the old one. The ACL, admin login, feature toggles and labels update in place.
 * Deploys wait until the instance reports `Ready`, for at most 10 minutes.
 *
 * Deleting an instance deletes every repository on it, and the management API can't list them, so
 * **a destroy stops with `Stackit.Git.InstanceDeleteRefused`, and a plan that would replace the
 * instance fails with it before anything changes, until `forceDestroy` is deployed**. That holds
 * for an instance with nothing on it too.
 *
 * Ownership is tracked with labels (`alchemy.stack`, `alchemy.stage`, `alchemy.id`,
 * `alchemy.instance`). The create call takes none, so they are written straight after it. An
 * instance with an explicit name that lacks them, or that an earlier generation of this resource
 * left waiting for its delete, is reported as unowned and only taken over with `--adopt`.
 *
 * ### Creating an Instance
 * **Example:** An instance with a generated name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const forge = yield* Stackit.Git.Instance("Forge", {});
 * // forge.url is https://<name>.git.onstackit.cloud
 * ```
 *
 * **Example:** A named instance on the larger plan
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const forge = yield* Stackit.Git.Instance("Forge", {
 *   name: "acme-forge",
 *   flavor: "git-100",
 *   labels: { team: "platform" },
 * });
 * ```
 *
 * ### Restricting Access
 * **Example:** Only the office and the deploy machine may reach the instance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const forge = yield* Stackit.Git.Instance("Forge", {
 *   acl: ["203.0.113.0/24", "198.51.100.7/32"],
 * });
 * ```
 *
 * ### Configuring Features
 * **Example:** Local login, quiet notifications and pipelines
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const forge = yield* Stackit.Git.Instance("Forge", {
 *   adminLogin: true,
 *   featureToggle: {
 *     enableLocalLogin: true,
 *     defaultEmailNotifications: "onmention",
 *     pipelines: { enabled: true },
 *   },
 * });
 * ```
 *
 * ### Destroying an Instance
 * **Example:** Allow the destroy, knowing it takes the repositories with it
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // Deploy this first, then destroy the stack.
 * const forge = yield* Stackit.Git.Instance("Forge", {
 *   forceDestroy: true,
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Changing the plan means a new, empty instance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // The API can't change a plan. Without forceDestroy already deployed, this plan fails and
 * // nothing changes. Deploy forceDestroy: true on its own first, then this. The repositories
 * // on the old instance are gone: move them first.
 * const forge = yield* Stackit.Git.Instance("Forge", {
 *   name: "acme-forge",
 *   flavor: "git-100",
 * });
 * ```
 *
 * @resource
 * @product STACKIT Git
 * @category Git
 */
export const Instance = Resource<Instance>("Stackit.Git.Instance");

/**
 * A delete of an instance nothing opted in to. Deleting it would delete every repository on it,
 * and the management API can't list them.
 */
export class InstanceDeleteRefused extends Data.TaggedError("Stackit.Git.InstanceDeleteRefused")<{
  readonly instanceId: string;
  readonly resourceName: string;
  readonly message: string;
}> {}

const DEFAULT_FLAVOR: InstanceFlavor = "git-10";

const generatedName = (id: string) =>
  createPhysicalName({ id, lowercase: true, maxLength: INSTANCE_NAME_MAX_LENGTH });

const refusedDelete = (instanceId: string, name: string, remedy: string) =>
  new InstanceDeleteRefused({
    instanceId,
    resourceName: name,
    message: `Deleting STACKIT Git instance ${name} would delete every repository on it, and the management API can't list them. ${remedy}`,
  });

/**
 * A replacement ends in the old instance's delete, which sees the props it was deployed with. So
 * nothing can opt in after this point: refuse at plan, where nothing has happened yet.
 */
const refuseReplacement = (olds: InstanceProps | undefined, output: InstanceAttributes) =>
  Effect.gen(function* () {
    if (olds?.forceDestroy === true) return;
    const current = yield* getInstanceOrUndefined(output.projectId, output.instanceId);
    if (current === undefined) return;
    return yield* refusedDelete(
      output.instanceId,
      output.name,
      "This change replaces the instance, so nothing was changed. Deploy forceDestroy: true on its own first, then make this change.",
    );
  });

const toAttrs = (projectId: string, instance: git.Instance): InstanceAttributes => ({
  instanceId: instance.id,
  projectId,
  name: instance.name,
  flavor: instance.flavor,
  url: instance.url,
  version: instance.version,
  state: instance.state,
  consumedDisk: instance.consumed_disk,
  consumedObjectStorage: instance.consumed_object_storage,
  created: instance.created,
  acl: [...instance.acl],
  adminLogin: instance.admin_login,
  featureToggle: instance.feature_toggle,
  labels: stripInternalLabels(instance.labels),
});

const findByName = (projectId: string, name: string) =>
  git
    .listInstances({ projectId })
    .pipe(Effect.map(({ instances }) => instances.find((instance) => instance.name === name)));

const findByOwnership = (projectId: string, id: string) =>
  Effect.gen(function* () {
    const { instances } = yield* git.listInstances({ projectId });
    for (const instance of instances) {
      if (yield* hasAlchemyLabels(id, instance.labels)) return instance;
    }
    return undefined;
  });

const waitForGone = (projectId: string, instanceId: string) =>
  waitUntilGone({
    resource: `STACKIT Git instance ${instanceId}`,
    read: getInstanceOrUndefined(projectId, instanceId),
    failed: (instance) => (instance.state === "Error" ? "Error" : undefined),
    state: (instance) => instance.state,
    timeout: INSTANCE_TIMEOUT,
    interval: "5 seconds",
    maxInterval: "15 seconds",
  });

/** The desired toggles, or `undefined` when the observed ones hold every field set. */
const featureToggleDelta = (
  observed: git.FeatureToggle,
  desired: InstanceFeatureToggle | undefined,
): git.FeatureToggle | undefined => {
  if (desired === undefined) return undefined;
  const pipelinesDrifted =
    desired.pipelines !== undefined &&
    ((desired.pipelines.enabled !== undefined &&
      observed.pipelines?.enabled !== desired.pipelines.enabled) ||
      (desired.pipelines.actionUrl !== undefined &&
        observed.pipelines?.action_url !== desired.pipelines.actionUrl));
  const drifted =
    pipelinesDrifted ||
    (desired.defaultEmailNotifications !== undefined &&
      observed.default_email_notifications !== desired.defaultEmailNotifications) ||
    (desired.enableLocalLogin !== undefined &&
      observed.enable_local_login !== desired.enableLocalLogin);
  if (!drifted) return undefined;
  // Whole: the spec doesn't say whether a PATCH merges or replaces the toggles.
  return {
    ...observed,
    ...(desired.defaultEmailNotifications !== undefined
      ? { default_email_notifications: desired.defaultEmailNotifications }
      : {}),
    ...(desired.enableLocalLogin !== undefined
      ? { enable_local_login: desired.enableLocalLogin }
      : {}),
    ...(desired.pipelines !== undefined
      ? {
          pipelines: {
            ...observed.pipelines,
            ...(desired.pipelines.enabled !== undefined
              ? { enabled: desired.pipelines.enabled }
              : {}),
            ...(desired.pipelines.actionUrl !== undefined
              ? { action_url: desired.pipelines.actionUrl }
              : {}),
          },
        }
      : {}),
  };
};

/** What a PATCH has to send: every drifted aspect, diffed against the observed instance. */
const instanceDelta = (
  instance: git.Instance,
  news: InstanceProps,
  labels: Record<string, string>,
) => {
  const toggles = featureToggleDelta(instance.feature_toggle, news.featureToggle);
  return {
    ...(news.acl !== undefined && !sameMembers(instance.acl, news.acl)
      ? { acl: [...news.acl] }
      : {}),
    ...(news.adminLogin !== undefined && instance.admin_login !== news.adminLogin
      ? { admin_login: news.adminLogin }
      : {}),
    ...(toggles !== undefined ? { feature_toggle: toggles } : {}),
    ...(!recordsEqual(labelRecord(instance.labels), labels) ? { labels } : {}),
  };
};

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: ["instanceId", "projectId", "name", "flavor", "url", "created"],

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const { instances } = yield* git.listInstances({ projectId: env.projectId });
      return instances
        .filter((instance) => isAlchemyOwned(instance.labels))
        .map((instance) => toAttrs(env.projectId, instance));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An unresolved value can resolve to the one the instance already has, and an explicit name
      // can't exist twice. A generated name carries the generation, so it never collides.
      if (hasUnresolvedTrigger<InstanceProps>(news, ["name", "flavor", "projectId"])) {
        yield* refuseReplacement(olds, output);
        return {
          action: "replace",
          deleteFirst: rawProp<InstanceProps>(news, "name") !== undefined,
        } as const;
      }
      const resolved = triggerProps<InstanceProps>(news);
      const env = yield* StackitEnvironment.current;
      const projectId = resolved.projectId ?? env.projectId;
      const sameName = resolved.name === undefined || resolved.name === output.name;
      if (!sameName || projectId !== output.projectId) {
        yield* refuseReplacement(olds, output);
        return { action: "replace", deleteFirst: false } as const;
      }
      // Against the prop deployed last, when there is one: the API may spell a plan differently.
      const deployedFlavor = olds?.flavor ?? output.flavor;
      if (
        resolved.flavor !== undefined &&
        resolved.flavor.toLowerCase() !== deployedFlavor.toLowerCase()
      ) {
        yield* refuseReplacement(olds, output);
        return { action: "replace", deleteFirst: resolved.name !== undefined } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId: engineInstanceId, olds, output, previous }) {
      const env = yield* StackitEnvironment.current;
      const projectId = output?.projectId ?? olds?.projectId ?? env.projectId;
      const name = output?.name ?? olds?.name ?? (yield* generatedName(id));
      let instance: git.Instance | undefined =
        output?.instanceId !== undefined
          ? yield* getInstanceOrUndefined(projectId, output.instanceId)
          : undefined;
      instance ??= yield* findByName(projectId, name);
      // A generated name with nothing recorded, and no generation being replaced: a crash or lost
      // state. Its labels find it, whatever generation it is.
      if (
        instance === undefined &&
        output === undefined &&
        olds?.name === undefined &&
        previous === undefined
      ) {
        instance = yield* findByOwnership(projectId, id);
      }
      if (instance === undefined || instance.state === "Deleting") return undefined;
      const attrs = toAttrs(projectId, instance);
      if (output?.instanceId === instance.id) return attrs;
      // A generated name carries this generation, and labels only arrive after the create call,
      // so a crash in between still finds its own instance.
      if (output === undefined && olds?.name === undefined) return attrs;
      if (previous?.instanceId === instance.id && previous.projectId === projectId) return attrs;
      // Once state or a replacement exists, only this generation is ours. An older generation
      // still waiting for its delete would otherwise become the new one, and then be deleted.
      const generation = readGeneration({ instanceId: engineInstanceId, output, previous });
      const ours =
        (yield* hasAlchemyLabels(id, instance.labels)) &&
        (generation === undefined || hasInstanceLabel(generation, instance.labels));
      return ours ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId: engineInstanceId, news, output }) {
      const env = yield* StackitEnvironment.current;
      const projectId = news.projectId ?? output?.projectId ?? env.projectId;
      const name = news.name ?? output?.name ?? (yield* generatedName(id));
      const labels = yield* desiredGenerationLabels(id, engineInstanceId, news.labels);
      const resource = `STACKIT Git instance ${name}`;

      // 1. Observe — `output` is a cache for the id, and only names the desired instance while it
      // has the desired name in the desired project.
      let current: git.Instance | undefined =
        output?.projectId === projectId && output.name === name
          ? yield* getInstanceOrUndefined(projectId, output.instanceId)
          : undefined;
      current ??= yield* findByName(projectId, name);
      // A delete in flight (an interrupted destroy): let it finish.
      if (current?.state === "Deleting") {
        yield* waitForGone(projectId, current.id);
        current = undefined;
      }

      // 2. Ensure — a 409 may be our own create racing, so look again before failing.
      if (current === undefined) {
        current = yield* git
          .createInstance({
            projectId,
            name,
            flavor: news.flavor ?? DEFAULT_FLAVOR,
            ...(news.acl !== undefined ? { acl: [...news.acl] } : {}),
          })
          .pipe(
            Effect.catchTag("Conflict", (error) =>
              findByName(projectId, name).pipe(
                Effect.flatMap((found) =>
                  found === undefined ? Effect.fail(error) : Effect.succeed(found),
                ),
              ),
            ),
          );
      }
      const instanceId = current.id;

      const settle = (
        applied: (instance: git.Instance) => boolean,
        options: { readonly ignoreError?: boolean } = {},
      ) =>
        waitFor({
          resource,
          // A new instance can take a moment to be readable.
          read: getInstanceOrUndefined(projectId, instanceId),
          ready: (instance) => instance?.state === "Ready" && applied(instance),
          failed: (instance) =>
            instance?.state === "Error" && options.ignoreError !== true ? "Error" : undefined,
          state: (instance) => instance?.state ?? "not visible yet",
          timeout: INSTANCE_TIMEOUT,
          interval: "5 seconds",
          maxInterval: "15 seconds",
        });

      // An instance already in `Error` is the one case to patch before it settles: new settings are
      // how it can recover, and the failure predates them.
      const failedBefore = current.state === "Error";
      if (!failedBefore) current = (yield* settle(() => true)) ?? current;

      // 3. Sync — one PATCH with every drifted aspect. The response may be a bodyless 202, so the
      // new values are read back. Label removals aren't awaited: the API documents a JSON Patch form
      // for removing fields, so a merge body may leave them.
      const delta = instanceDelta(current, news, labels);
      if (Object.keys(delta).length > 0) {
        yield* retryWhileInTransition(git.patchInstance({ projectId, instanceId, ...delta }));
        const synced = yield* settle(
          (instance) => {
            const { labels: _labels, ...rest } = instanceDelta(instance, news, labels);
            const observed = labelRecord(instance.labels);
            return (
              Object.keys(rest).length === 0 &&
              Object.entries(labels).every(([key, value]) => observed[key] === value)
            );
          },
          { ignoreError: failedBefore },
        );
        current = synced ?? current;
      } else if (failedBefore) {
        current = (yield* settle(() => true)) ?? current;
      }

      // 4. Return
      return toAttrs(projectId, current);
    }),

    delete: Effect.fn(function* ({ olds, output, force }) {
      const { projectId, instanceId } = output;
      const current = yield* getInstanceOrUndefined(projectId, instanceId);
      if (current === undefined) return;
      if (current.state !== "Deleting") {
        // Every repository on the instance goes with it, whoever made them: the prop, or
        // `alchemy unsafe nuke`, is the opt-in.
        if (olds?.forceDestroy !== true && force !== true) {
          return yield* refusedDelete(
            instanceId,
            output.name,
            "Deploy it with forceDestroy: true to allow this. An instance already being replaced keeps the props it was deployed with, so only deleting it by hand finishes that replacement.",
          );
        }
        yield* retryWhileInTransition(git.deleteInstance({ projectId, instanceId })).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
      yield* waitForGone(projectId, instanceId);
    }),
  });
