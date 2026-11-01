import * as modelExperiments from "@distilled.cloud/stackit/model_experiments";
import { Unowned } from "alchemy/AdoptPolicy";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { type ProjectScope, readGeneration, resolveProjectScope } from "../IaaS/internal.ts";
import { findOwnedAiItem, labelPatch, userAiLabels } from "../internal/aiTokens.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import { ensureServiceEnabled } from "../internal/enable.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import { desiredGenerationLabels, isAlchemyOwned } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  conflictRetry,
  getInstanceOrUndefined,
  LIFECYCLE_TIMEOUT,
  listScopeInstances,
  MODEL_EXPERIMENTS_SERVICE_ID,
  NAME_MAX_LENGTH,
  scopeRequest,
} from "./internal.ts";

export interface InstanceProps {
  /**
   * Name of the instance: at most 64 letters, digits, spaces, `_` and `-`. Updates in place.
   *
   * @default a name generated from the stack, stage and logical ID
   */
  name?: string;
  /**
   * Description, at most 160 letters, digits, spaces and `.`, `:`, `/`, `-`. Updates in place; omit
   * to leave the live value alone.
   */
  description?: string;
  /**
   * How long experiments marked for deletion are kept before they are purged, from `1d` to `90d`,
   * such as `30d` or `12h`. Updates in place; omit to leave the live value alone.
   *
   * @default the API's default
   */
  deletedExperimentRetention?: string;
  /** User labels. Alchemy's ownership labels are always merged in. Updates in place. */
  labels?: Record<string, string>;
  /** Project that owns the instance. Changing it replaces the instance. @default the profile's project */
  projectId?: string;
  /** Region of the instance. Changing it replaces the instance. @default the profile's region */
  region?: string;
}

export interface InstanceAttributes {
  /** STACKIT instance id (UUID). */
  instanceId: string;
  /** Project that owns the instance. */
  projectId: string;
  /** Region of the instance. */
  region: string;
  /** Name of the instance. */
  name: string;
  /** Description, if any. */
  description: string | undefined;
  /** How long experiments marked for deletion are kept. */
  deletedExperimentRetention: string | undefined;
  /** MLflow's tracking URL: `MLFLOW_TRACKING_URI`. */
  url: string;
  /** The bucket holding the instance's artifacts. */
  bucketName: string | undefined;
  /** `active` after a deploy. */
  state: string;
  /** What went wrong, on an `impaired` instance. */
  errorMessage: string | undefined;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
}

export type Instance = Resource<
  "Stackit.ModelExperiments.Instance",
  InstanceProps,
  InstanceAttributes,
  never,
  Providers
>;

/**
 * An instance of STACKIT AI Model Experiments: a managed MLflow tracking server, with its
 * artifacts in a bucket the service names. Log to it with a `Stackit.ModelExperiments.Token`,
 * through the bindings or the MLflow SDK at `url`.
 *
 * A deploy waits until the instance is `active`, and an `impaired` one fails it with STACKIT's
 * message. The Go SDK allows 45 minutes for that. Only `projectId` and `region` replace the
 * instance, which loses its experiments; everything else updates in place. The first deploy
 * enables the service (`cloud.stackit.model-experiments`) for the project.
 *
 * Ownership is tracked with labels. An instance with the same `name` that lacks them is reported
 * as unowned, and only taken over with `--adopt`.
 *
 * ### Creating an Instance
 * **Example:** An instance with a generated name
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.ModelExperiments.Instance("Experiments", {});
 * ```
 *
 * ### Configuring the Instance
 * **Example:** Name, retention and labels
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.ModelExperiments.Instance("Experiments", {
 *   name: "research",
 *   description: "Team experiments",
 *   deletedExperimentRetention: "30d",
 *   labels: { team: "research" },
 * });
 * ```
 *
 * ### Logging Experiments
 * **Example:** A token for the MLflow SDK
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const instance = yield* Stackit.ModelExperiments.Instance("Experiments", {});
 * const token = yield* Stackit.ModelExperiments.Token("Tracking", {
 *   instanceId: instance.instanceId,
 * });
 * // MLFLOW_TRACKING_URI is instance.url, and MLFLOW_TRACKING_TOKEN is token.token.
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Moving to another project makes a new, empty instance
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // The old instance, with its experiments, is deleted. Nothing is copied.
 * const instance = yield* Stackit.ModelExperiments.Instance("Experiments", {
 *   projectId: "00000000-0000-0000-0000-000000000000",
 * });
 * ```
 *
 * @resource
 * @product STACKIT AI Model Experiments
 * @category ModelExperiments
 */
export const Instance = Resource<Instance>("Stackit.ModelExperiments.Instance");

const toAttrs = (scope: ProjectScope, instance: modelExperiments.Instance): InstanceAttributes => ({
  instanceId: instance.id,
  projectId: scope.projectId,
  region: scope.region,
  name: instance.name,
  description: instance.description === "" ? undefined : instance.description,
  deletedExperimentRetention: instance.deletedExperimentRetention,
  url: instance.url,
  bucketName: instance.bucketName,
  state: instance.state,
  errorMessage: instance.errorMessage === "" ? undefined : instance.errorMessage,
  labels: userAiLabels(instance.labels),
});

const UNIT_SECONDS: Readonly<Record<string, number>> = { d: 86_400, h: 3600, m: 60, s: 1 };

/** A retention in seconds: the API may answer `720h` to a `30d`. */
const retentionSeconds = (retention: string | undefined): number | undefined =>
  retention === undefined
    ? undefined
    : [...retention.matchAll(/([0-9.]+)([dhms])/g)].reduce(
        (total, [, amount, unit]) => total + Number(amount) * UNIT_SECONDS[unit!]!,
        0,
      );

/** Whether the desired retention, when one is set, matches the observed one. */
const retentionMatches = (instance: modelExperiments.Instance, desired: string | undefined) =>
  desired === undefined ||
  retentionSeconds(instance.deletedExperimentRetention) === retentionSeconds(desired);

/** Wait until the instance is `active`, and `applied` holds. */
const waitForActive = (
  scope: ProjectScope,
  instanceId: string,
  applied: (instance: modelExperiments.Instance) => boolean = () => true,
) =>
  waitFor({
    resource: `STACKIT Model Experiments instance ${instanceId}`,
    read: modelExperiments
      .getInstance({ ...scopeRequest(scope), instanceId })
      .pipe(Effect.map(({ instance }) => instance)),
    ready: (instance) => instance.state === "active" && applied(instance),
    failed: (instance) =>
      instance.state === "impaired"
        ? (instance.errorMessage ?? instance.state)
        : instance.state === "deleting"
          ? instance.state
          : undefined,
    state: (instance) => instance.state,
    timeout: LIFECYCLE_TIMEOUT,
    interval: "5 seconds",
    maxInterval: "30 seconds",
  });

const waitForGone = (scope: ProjectScope, instanceId: string) =>
  waitUntilGone({
    resource: `STACKIT Model Experiments instance ${instanceId}`,
    read: getInstanceOrUndefined(scope, instanceId),
    failed: (instance) =>
      instance.state === "impaired" ? (instance.errorMessage ?? instance.state) : undefined,
    state: (instance) => instance.state,
    timeout: LIFECYCLE_TIMEOUT,
    interval: "5 seconds",
    maxInterval: "30 seconds",
  });

export const InstanceProvider = () =>
  Provider.succeed(Instance, {
    stables: ["instanceId", "projectId", "region", "url", "bucketName"],

    list: Effect.fn(function* () {
      const env = yield* StackitEnvironment.current;
      const scope = { projectId: env.projectId, region: env.region };
      const instances = yield* listScopeInstances(scope);
      return instances
        .filter((instance) => isAlchemyOwned(instance.labels))
        .map((instance) => toAttrs(scope, instance));
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An unresolved project or region can resolve to the one the instance sits in, and an
      // explicit name may not exist twice there. A generated name carries the generation.
      if (hasUnresolvedTrigger<InstanceProps>(news, ["projectId", "region"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<InstanceProps>(news, "name") !== undefined,
        } as const;
      }
      const resolved = triggerProps<InstanceProps>(news);
      const env = yield* StackitEnvironment.current;
      if (
        (resolved.projectId ?? env.projectId) !== output.projectId ||
        (resolved.region ?? env.region) !== output.region
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      if (output !== undefined) {
        const byId = yield* getInstanceOrUndefined(scope, output.instanceId);
        if (byId !== undefined && byId.state !== "deleting") return toAttrs(scope, byId);
      }
      const instances = yield* listScopeInstances(scope);
      // A crashed create has neither state nor a previous generation, and any generation of this
      // logical id is ours. A replacement only owns its own.
      const generation = readGeneration({ instanceId, output, previous });
      const owned = yield* findOwnedAiItem(id, instances, generation);
      if (owned !== undefined) return toAttrs(scope, owned);
      const name = output?.name ?? olds?.name;
      const named = instances.find((instance) => instance.name === name);
      if (named === undefined) return undefined;
      const attrs = toAttrs(scope, named);
      // A name says nothing beyond its project and region, so the generation being replaced has
      // to match on all three.
      const isPrevious =
        previous?.instanceId === named.id &&
        previous.projectId === scope.projectId &&
        previous.region === scope.region;
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const request = scopeRequest(scope);
      const name = news.name ?? (yield* createPhysicalName({ id, maxLength: NAME_MAX_LENGTH }));
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);

      yield* ensureServiceEnabled({ ...scope, serviceId: MODEL_EXPERIMENTS_SERVICE_ID });

      // 1. Observe — `output` is a cache for the id, and only names the desired instance while it
      // sits in the same project and region. Without it, only this generation's labels can claim
      // an instance.
      let current: modelExperiments.Instance | undefined;
      if (output?.projectId === scope.projectId && output.region === scope.region) {
        current = yield* getInstanceOrUndefined(scope, output.instanceId);
      }
      if (current === undefined) {
        const instances = yield* listScopeInstances(scope);
        current = yield* findOwnedAiItem(id, instances, instanceId);
      }
      // A delete in flight (an interrupted destroy): let it finish.
      if (current?.state === "deleting") {
        yield* waitForGone(scope, current.id);
        current = undefined;
      }

      // 2. Ensure
      if (current === undefined) {
        const created = yield* modelExperiments.createInstance({
          ...request,
          name,
          labels,
          ...(news.description !== undefined ? { description: news.description } : {}),
          ...(news.deletedExperimentRetention !== undefined
            ? { deletedExperimentRetention: news.deletedExperimentRetention }
            : {}),
        });
        current = created.instance;
      }
      const liveId = current.id;
      if (current.state !== "active") current = yield* waitForActive(scope, liveId);

      // 3. Sync — observed aspects against the desired ones.
      const descriptionDrifted =
        news.description !== undefined && (current.description ?? "") !== news.description;
      const retentionDrifted = !retentionMatches(current, news.deletedExperimentRetention);
      const labelsDelta = labelPatch(current.labels, labels);
      if (
        current.name !== name ||
        descriptionDrifted ||
        retentionDrifted ||
        labelsDelta !== undefined
      ) {
        yield* modelExperiments
          .partialUpdateInstance({
            ...request,
            instanceId: liveId,
            ...(current.name !== name ? { name } : {}),
            ...(descriptionDrifted ? { description: news.description } : {}),
            ...(retentionDrifted
              ? { deletedExperimentRetention: news.deletedExperimentRetention }
              : {}),
            ...(labelsDelta !== undefined ? { labels: labelsDelta } : {}),
          })
          .pipe(Effect.retry(conflictRetry));
        // Waiting for the new values means a read from before the PATCH can't pass.
        current = yield* waitForActive(
          scope,
          liveId,
          (instance) =>
            instance.name === name &&
            (news.description === undefined || (instance.description ?? "") === news.description) &&
            retentionMatches(instance, news.deletedExperimentRetention),
        );
      }

      // 4. Return
      return toAttrs(scope, current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const { instanceId } = output;
      const current = yield* getInstanceOrUndefined(scope, instanceId);
      if (current === undefined) return;
      if (current.state !== "deleting") {
        yield* modelExperiments.deleteInstance({ ...scopeRequest(scope), instanceId }).pipe(
          Effect.retry(conflictRetry),
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
      yield* waitForGone(scope, instanceId);
    }),
  });
