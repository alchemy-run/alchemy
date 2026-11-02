import * as git from "@distilled.cloud/stackit/git";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { StackitEnvironment } from "../Environment.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import { sameMembers } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import { CHILD_TIMEOUT, getRunnerOrUndefined, type InstanceScope } from "./internal.ts";

export interface RunnerProps {
  /** Id of the instance the runner serves. Changing it replaces the runner. */
  instanceId: string;
  /**
   * The labels a job's `runs-on` picks the runner by. There is no update call, so changing them
   * replaces the runner.
   */
  labels: string[];
  /**
   * Job family the runner uses, one of the names `Stackit.Git.ListRunnerFamilies` returns. There
   * is no update call, so changing it replaces the runner. Omit it for STACKIT's default.
   */
  familyName?: string;
  /** Project of the instance. Changing it replaces the runner. @default the profile's project */
  projectId?: string;
}

export interface RunnerAttributes {
  /** STACKIT runner id. */
  runnerId: string;
  /** Id of the instance the runner serves. */
  instanceId: string;
  /** Project of the instance. */
  projectId: string;
  /** The labels a job's `runs-on` picks the runner by. */
  labels: string[];
  /** Job family the runner uses, if one was set. */
  familyName: string | undefined;
  /** Status STACKIT reported when the runner was last deployed. */
  status: string;
  /** When the runner was created. */
  createdAt: string;
}

export type Runner = Resource<
  "Stackit.Git.Runner",
  RunnerProps,
  RunnerAttributes,
  never,
  Providers
>;

/**
 * The CI runner of a STACKIT Git instance, which runs the jobs of pipelines pushed to it. It is
 * not an Alchemy runtime: nothing deploys through it. STACKIT bills runner minutes.
 *
 * An instance has one runner, and the API has no update call, so a change of labels or family
 * deletes the old runner, then creates the new one. A deploy returns once STACKIT reports the
 * runner, not once it can take jobs: the API doesn't document its status values.
 *
 * The API has no labels here, and runners go with their instance, so there is no `list`. A runner
 * already on an instance with no state is reported as unowned and only taken over with `--adopt`.
 *
 * See [STACKIT's Git docs](https://docs.stackit.cloud/products/developer-platform/git/).
 *
 * :::caution[Changing `instanceId`, `labels`, `familyName` or `projectId` replaces the Runner]
 * An instance has one runner and the API has no update call, so the old runner is
 * deleted first, then the new one is created. Jobs have no runner in between.
 * :::
 *
 * ### Creating a Runner
 * **Example:** A runner for jobs with `runs-on: stackit-docker`
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const forge = yield* Stackit.Git.Instance("Forge", {
 *   featureToggle: { pipelines: { enabled: true } },
 * });
 * const runner = yield* Stackit.Git.Runner("Ci", {
 *   instanceId: forge.instanceId,
 *   labels: ["stackit-docker"],
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** New labels replace the runner
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const forge = yield* Stackit.Git.Instance("Forge", {});
 * // The old runner is deleted first: an instance has one. Jobs wait until the new one is up.
 * const runner = yield* Stackit.Git.Runner("Ci", {
 *   instanceId: forge.instanceId,
 *   labels: ["stackit-docker", "stackit-ubuntu-22"],
 * });
 * ```
 *
 * @resource
 * @product STACKIT Git
 * @category Git
 */
export const Runner = Resource<Runner>("Stackit.Git.Runner");

/** The instance's one runner isn't the one this resource can use. */
export class RunnerConflict extends Data.TaggedError("Stackit.Git.RunnerConflict")<{
  readonly instanceId: string;
  readonly runnerId: string;
  readonly message: string;
}> {}

const toAttrs = (scope: InstanceScope, runner: git.Runner): RunnerAttributes => ({
  runnerId: runner.id,
  instanceId: scope.instanceId,
  projectId: scope.projectId,
  labels: [...runner.labels],
  familyName: runner.familyName,
  status: runner.status,
  createdAt: runner.created_at,
});

const resolveScope = Effect.fn(function* (
  props: Pick<RunnerProps, "projectId" | "instanceId">,
  output: Pick<RunnerAttributes, "projectId"> | undefined,
) {
  const env = yield* StackitEnvironment.current;
  return {
    projectId: props.projectId ?? output?.projectId ?? env.projectId,
    instanceId: props.instanceId,
  } satisfies InstanceScope;
});

export const RunnerProvider = () =>
  Provider.succeed(Runner, {
    stables: ["runnerId", "instanceId", "projectId", "labels", "familyName", "createdAt"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An instance holds one runner, and an unresolved value can resolve to the instance this one
      // sits on: delete the old runner first.
      if (
        hasUnresolvedTrigger<RunnerProps>(news, ["instanceId", "projectId", "labels", "familyName"])
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<RunnerProps>(news);
      const env = yield* StackitEnvironment.current;
      if (
        resolved.instanceId !== output.instanceId ||
        (resolved.projectId ?? env.projectId) !== output.projectId
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      if (
        !sameMembers(resolved.labels, olds?.labels ?? output.labels) ||
        (resolved.familyName !== undefined &&
          resolved.familyName !== (olds?.familyName ?? output.familyName))
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output, previous }) {
      const instanceId = output?.instanceId ?? olds?.instanceId;
      if (instanceId === undefined) return undefined;
      const env = yield* StackitEnvironment.current;
      const scope = {
        projectId: output?.projectId ?? olds?.projectId ?? env.projectId,
        instanceId,
      };
      const runner = yield* getRunnerOrUndefined(scope);
      if (runner === undefined) return undefined;
      const attrs = toAttrs(scope, runner);
      if (output?.runnerId === runner.id) return attrs;
      const isPrevious =
        previous?.runnerId === runner.id &&
        previous.instanceId === instanceId &&
        previous.projectId === scope.projectId;
      return isPrevious ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const scope = yield* resolveScope(news, output);
      const resource = `the runner of STACKIT Git instance ${scope.instanceId}`;

      // 1. Observe
      let current = yield* getRunnerOrUndefined(scope);
      // A singleton: a runner with another id is whatever replaced ours, so it isn't taken over.
      if (
        current !== undefined &&
        output !== undefined &&
        output.instanceId === scope.instanceId &&
        output.projectId === scope.projectId &&
        current.id !== output.runnerId
      ) {
        return yield* new RunnerConflict({
          instanceId: scope.instanceId,
          runnerId: current.id,
          message: `STACKIT Git instance ${scope.instanceId} now has runner ${current.id}, not the ${output.runnerId} this stack deployed. Delete it, or adopt it by removing this resource from state.`,
        });
      }
      // There is no update call, so an adopted runner has to have the settings already.
      if (
        current !== undefined &&
        (!sameMembers(current.labels, news.labels) ||
          (news.familyName !== undefined && current.familyName !== news.familyName))
      ) {
        return yield* new RunnerConflict({
          instanceId: scope.instanceId,
          runnerId: current.id,
          message: `Runner ${current.id} on STACKIT Git instance ${scope.instanceId} has labels ${current.labels.join(", ")}${current.familyName === undefined ? "" : ` and family ${current.familyName}`}, and the API can't change them. Delete it, or deploy with its settings.`,
        });
      }

      // 2. Ensure — a 409 may be our own create racing, so look again before failing.
      if (current === undefined) {
        current = yield* git
          .createRunner({
            ...scope,
            labels: [...news.labels],
            ...(news.familyName !== undefined ? { familyName: news.familyName } : {}),
          })
          .pipe(
            Effect.catchTag("Conflict", (error) =>
              getRunnerOrUndefined(scope).pipe(
                Effect.flatMap((found) =>
                  found === undefined ? Effect.fail(error) : Effect.succeed(found),
                ),
              ),
            ),
          );
      }
      const runnerId = current.id;

      // The create is accepted with a 202. STACKIT documents no status values, so what can be
      // waited for is the runner being readable.
      const visible = yield* waitFor({
        resource,
        read: getRunnerOrUndefined(scope),
        ready: (runner) => runner?.id === runnerId,
        state: (runner) => runner?.status ?? "not visible yet",
        timeout: CHILD_TIMEOUT,
      });

      // 3. Nothing to sync. 4. Return
      return toAttrs(scope, visible ?? current);
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, instanceId: output.instanceId };
      // Only the runner this resource deployed: another one is whatever replaced it.
      const ours = getRunnerOrUndefined(scope).pipe(
        Effect.map((runner) => (runner?.id === output.runnerId ? runner : undefined)),
      );
      if ((yield* ours) === undefined) return;
      yield* git.deleteRunner(scope).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone({
        resource: `the runner of STACKIT Git instance ${output.instanceId}`,
        read: ours,
        state: (runner) => runner.status,
        timeout: CHILD_TIMEOUT,
      });
    }),
  });
