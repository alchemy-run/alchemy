import * as intake from "@distilled.cloud/stackit/intake";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual, isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { readGeneration, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import {
  conflictRetry,
  emptyToUndefined,
  findOwnedGeneration,
  generatedDisplayName,
} from "../internal/displayNames.ts";
import { childrenLeftAfterSettling, waitFor, waitUntilGone } from "../internal/wait.ts";
import {
  desiredGenerationLabels,
  hasAlchemyLabels,
  isAlchemyOwned,
  labelRecord,
  stripInternalLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  getRunnerOrUndefined,
  listIntakes,
  listRunners,
  onRegion,
  POLL,
  RUNNER_TIMEOUT,
  type IntakeScope,
} from "./internal.ts";

export interface RunnerProps {
  /**
   * Name of the runner: 1 to 32 letters, digits, spaces and hyphens. Updates in place.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  displayName?: string;
  /**
   * Largest message the runner takes, in KiB. Together with `maxMessagesPerHour` it sets
   * the capacity STACKIT reserves and bills. Raising the capacity updates in place;
   * lowering it replaces the runner, which drops what the runner holds. See the caution
   * below.
   */
  maxMessageSizeKiB: number;
  /**
   * Messages per hour the runner takes. See `maxMessageSizeKiB`.
   */
  maxMessagesPerHour: number;
  /** Description. Updates in place; omit to leave the live value alone. */
  description?: string;
  /** User labels. Alchemy's ownership labels are always merged in. Updates in place. */
  labels?: Record<string, string>;
  /** Project that owns the runner. Changing it replaces the runner. @default the profile's project */
  projectId?: string;
  /** Region of the runner. Changing it replaces the runner. @default the profile's region */
  region?: string;
}

export interface RunnerAttributes {
  /** STACKIT runner id (UUID). Stable across updates. */
  runnerId: string;
  /** Project that owns the runner. */
  projectId: string;
  /** Region of the runner. */
  region: string;
  /** Name of the runner. */
  displayName: string;
  /** Description, if any. */
  description: string | undefined;
  /** Largest message the runner takes, in KiB. */
  maxMessageSizeKiB: number;
  /** Messages per hour the runner takes. */
  maxMessagesPerHour: number;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
  /** State; `active` after a deploy. */
  state: string;
  /** The runner's Kafka endpoint, `host:port`. */
  uri: string;
  /** When the runner was created (RFC 3339). */
  createTime: string;
}

export type Runner = Resource<
  "Stackit.Intake.Runner",
  RunnerProps,
  RunnerAttributes,
  never,
  Providers
>;

/** A runner still has intakes on it when it is deleted. */
export class RunnerNotEmpty extends Data.TaggedError("Stackit.Intake.RunnerNotEmpty")<{
  readonly runnerId: string;
  readonly intakes: ReadonlyArray<string>;
  readonly message: string;
}> {}

/**
 * A STACKIT Intake Runner: the reserved capacity and Kafka endpoint that
 * `Stackit.Intake.Intake` pipelines run on. Applications publish JSON to it over the
 * Kafka protocol, and it buffers messages for up to 24 hours, refusing new ones once the
 * buffer is full.
 *
 * STACKIT bills the reserved capacity for as long as the runner exists, whatever flows
 * through it.
 *
 * Deleting a runner that still has intakes on it fails with
 * `Stackit.Intake.RunnerNotEmpty`, which names them: the API would otherwise leave the
 * runner stuck deleting until they go. Only `alchemy unsafe nuke` deletes it past them.
 *
 * Ownership is tracked with labels. A runner of the same name without them is reported
 * as unowned, and only taken over with `--adopt`.
 *
 * See [STACKIT's Intake docs](https://docs.stackit.cloud/products/data-and-ai/intake/).
 *
 * :::caution[Changing `projectId` or `region`, or lowering the capacity, replaces the Runner]
 * Raising `maxMessageSizeKiB` or `maxMessagesPerHour` updates in place. A replacement
 * drops what the runner holds. Deleting the old runner fails with
 * `Stackit.Intake.RunnerNotEmpty` while intakes are still on it.
 * :::
 *
 * ### Creating a Runner
 * **Example:** About 1 GB per hour of capacity
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const runner = yield* Stackit.Intake.Runner("Ingest", {
 *   maxMessageSizeKiB: 1024,
 *   maxMessagesPerHour: 1024,
 * });
 * ```
 *
 * **Example:** A named runner in a given region
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const runner = yield* Stackit.Intake.Runner("Ingest", {
 *   displayName: "ingest",
 *   description: "Clickstream ingest",
 *   maxMessageSizeKiB: 64,
 *   maxMessagesPerHour: 100000,
 *   region: "eu01",
 *   labels: { team: "data" },
 * });
 * ```
 *
 * ### Running an Intake on It
 * **Example:** A runner, an intake and a user
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const password = Config.Redacted("INTAKE_PASSWORD");
 * const runner = yield* Stackit.Intake.Runner("Ingest", {
 *   maxMessageSizeKiB: 1024,
 *   maxMessagesPerHour: 1024,
 * });
 * const events = yield* Stackit.Intake.Intake("Events", {
 *   runnerId: runner.runnerId,
 *   catalog: {
 *     uri: "https://my-dremio.data-platform.stackit.run/iceberg",
 *     warehouse: "lake",
 *   },
 * });
 * yield* Stackit.Intake.User("Producer", {
 *   intakeId: events.intakeId,
 *   password,
 * });
 * ```
 *
 * ### Replacement Cautions
 * **Example:** Lowering the capacity creates a new runner
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * // STACKIT only raises capacity: the product of the two limits has to grow. A smaller
 * // product creates a new runner, moves the intakes to it, and deletes the old one with
 * // whatever it still buffers, so producers have to reconnect to the new `uri`.
 * const runner = yield* Stackit.Intake.Runner("Ingest", {
 *   maxMessageSizeKiB: 64,
 *   maxMessagesPerHour: 1024,
 * });
 * ```
 *
 * @resource
 * @product STACKIT Intake
 * @category Intake
 */
export const Runner = Resource<Runner>("Stackit.Intake.Runner");

const toAttrs = (scope: IntakeScope, live: intake.IntakeRunnerResponse): RunnerAttributes => ({
  runnerId: live.id,
  projectId: scope.projectId,
  region: scope.region,
  displayName: live.displayName,
  description: emptyToUndefined(live.description),
  maxMessageSizeKiB: live.maxMessageSizeKiB,
  maxMessagesPerHour: live.maxMessagesPerHour,
  labels: stripInternalLabels(live.labels),
  state: live.state,
  uri: live.uri,
  createTime: live.create_time,
});

type RunnerPatch = Omit<
  intake.UpdateIntakeRunnerRequest,
  "projectId" | "regionId" | "intakeRunnerId"
>;

/** The delta between a live runner and the desired props (empty when in sync). */
const runnerDelta = (
  live: intake.IntakeRunnerResponse,
  news: RunnerProps,
  displayName: string,
  labels: Record<string, string>,
): RunnerPatch => ({
  ...(live.displayName !== displayName ? { displayName } : {}),
  ...(news.description !== undefined && (live.description ?? "") !== news.description
    ? { description: news.description }
    : {}),
  ...(live.maxMessageSizeKiB !== news.maxMessageSizeKiB
    ? { maxMessageSizeKiB: news.maxMessageSizeKiB }
    : {}),
  ...(live.maxMessagesPerHour !== news.maxMessagesPerHour
    ? { maxMessagesPerHour: news.maxMessagesPerHour }
    : {}),
  // Compared with the observed labels; the API replaces the map with what it is sent.
  ...(deepEqual(labelRecord(live.labels), labels) ? {} : { labels }),
});

const waitForActive = (
  scope: IntakeScope,
  intakeRunnerId: string,
  applied: (live: intake.IntakeRunnerResponse) => boolean = () => true,
) =>
  waitFor({
    resource: `STACKIT Intake runner ${intakeRunnerId}`,
    read: intake.getIntakeRunner({ ...onRegion(scope), intakeRunnerId }),
    ready: (live) => live.state === "active" && applied(live),
    failed: (live) => live.state === "failed" || live.state === "deleting",
    state: (live) => live.state,
    timeout: RUNNER_TIMEOUT,
    ...POLL,
  });

const waitForGone = (scope: IntakeScope, intakeRunnerId: string) =>
  waitUntilGone({
    resource: `STACKIT Intake runner ${intakeRunnerId}`,
    read: getRunnerOrUndefined(scope, intakeRunnerId),
    state: (live) => live.state,
    timeout: RUNNER_TIMEOUT,
    ...POLL,
  });

/**
 * Refuse before the delete: with intakes left, the API puts the runner into `deleting` and
 * keeps it there, which can't be taken back. What a destroy or a move deleted is gone by now,
 * so what remains is someone else's.
 */
const assertNoIntakes = (scope: IntakeScope, runnerId: string) =>
  Effect.gen(function* () {
    const left = yield* childrenLeftAfterSettling(
      listIntakes(scope).pipe(
        Effect.map((intakes) => intakes.filter((item) => item.intakeRunnerId === runnerId)),
      ),
    );
    if (left.length === 0) return;
    const names = left.map((item) => item.displayName);
    return yield* new RunnerNotEmpty({
      runnerId,
      intakes: names,
      message: `Intake runner ${runnerId} still has intakes on it: ${names.join(", ")}. Deleting it would leave it stuck deleting until they go. Delete them or move them first.`,
    });
  });

export const RunnerProvider = () =>
  Provider.succeed(Runner, {
    stables: ["runnerId", "projectId", "region"],

    list: Effect.fn(function* () {
      const scope = yield* resolveProjectScope(undefined, undefined);
      const runners = yield* listRunners(scope);
      return runners
        .filter((live) => isAlchemyOwned(live.labels))
        .map((live) => toAttrs(scope, live));
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // An unresolved project or region can resolve to the one the runner is in. A
      // generated name carries the generation, an explicit one survives it.
      if (hasUnresolvedTrigger<RunnerProps>(news, ["projectId", "region"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<RunnerProps>(news, "displayName") !== undefined,
        } as const;
      }
      const resolved = triggerProps<RunnerProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      if (scope.projectId !== output.projectId || scope.region !== output.region) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // A runner holds buffered messages, so an unknown capacity doesn't replace it: the
      // update runs once the values resolve, and the API refuses a smaller one.
      const size = rawProp<RunnerProps>(news, "maxMessageSizeKiB");
      const rate = rawProp<RunnerProps>(news, "maxMessagesPerHour");
      if (!isResolved(size) || !isResolved(rate)) return undefined;
      // STACKIT only takes a capacity whose product grows. Compared with the props last
      // deployed where there are any, so a value the API normalizes can't replace it.
      const deployedSize = olds?.maxMessageSizeKiB ?? output.maxMessageSizeKiB;
      const deployedRate = olds?.maxMessagesPerHour ?? output.maxMessagesPerHour;
      if (resolved.maxMessageSizeKiB * resolved.maxMessagesPerHour < deployedSize * deployedRate) {
        // Never delete first: the old runner still has intakes on it until they move to
        // the new one, and a runner with intakes is refused. A display name
        // isn't an identifier here, the id is.
        return { action: "replace", deleteFirst: false } as const;
      }
      // Everything else updates in place (engine default: props changed).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      if (output?.runnerId !== undefined) {
        const byId = yield* getRunnerOrUndefined(scope, output.runnerId);
        if (byId !== undefined && byId.state !== "deleting") return toAttrs(scope, byId);
      }
      const runners = (yield* listRunners(scope)).filter((live) => live.state !== "deleting");
      const generation = readGeneration({ instanceId, output, previous });
      const owned = yield* findOwnedGeneration(id, generation, runners, (live) => live.labels);
      if (owned !== undefined) return toAttrs(scope, owned);
      const name = output?.displayName ?? olds?.displayName ?? (yield* generatedDisplayName(id));
      const named = runners.find((live) => live.displayName === name);
      if (named === undefined) return undefined;
      // A replacement here keeps the name and comes up before the old runner goes (see
      // `diff`), and the engine hands this answer to reconcile, which would then update
      // the generation about to be deleted. An earlier generation isn't foreign either: it
      // just isn't what the replacement claims.
      if (
        previous !== undefined &&
        (previous.runnerId === named.id || (yield* hasAlchemyLabels(id, named.labels)))
      ) {
        return undefined;
      }
      return Unowned(toAttrs(scope, named));
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const displayName =
        news.displayName ?? output?.displayName ?? (yield* generatedDisplayName(id));
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);

      // 1. Observe — `output` is a cache for the id, and only speaks for this runner
      // while it sits in the desired project and region. Without it, only this
      // generation's runner can be claimed, by its labels.
      let live: intake.IntakeRunnerResponse | undefined;
      if (output?.projectId === scope.projectId && output.region === scope.region) {
        live = yield* getRunnerOrUndefined(scope, output.runnerId);
      }
      if (live === undefined) {
        const runners = yield* listRunners(scope);
        live = yield* findOwnedGeneration(id, instanceId, runners, (item) => item.labels);
      }
      // A delete in flight (an interrupted destroy): let it finish.
      if (live?.state === "deleting") {
        yield* waitForGone(scope, live.id);
        live = undefined;
      }

      // 2. Ensure
      if (live === undefined) {
        live = yield* intake
          .createIntakeRunner({
            ...onRegion(scope),
            displayName,
            maxMessageSizeKiB: news.maxMessageSizeKiB,
            maxMessagesPerHour: news.maxMessagesPerHour,
            labels,
            ...(news.description !== undefined ? { description: news.description } : {}),
          })
          .pipe(Effect.retry(conflictRetry));
      }
      const runnerId = live.id;
      live = yield* waitForActive(scope, runnerId);

      // 3. Sync — one update carrying every drifted aspect, diffed against the live runner.
      const patch = runnerDelta(live, news, displayName, labels);
      if (Object.keys(patch).length > 0) {
        yield* intake
          .updateIntakeRunner({ ...onRegion(scope), intakeRunnerId: runnerId, ...patch })
          .pipe(Effect.retry(conflictRetry));
        live = yield* waitForActive(scope, runnerId, (observed) => {
          // Only that the desired labels are there, not that nothing else is.
          const { labels: _labels, ...rest } = runnerDelta(observed, news, displayName, labels);
          const observedLabels = labelRecord(observed.labels);
          return (
            Object.keys(rest).length === 0 &&
            Object.entries(labels).every(([key, value]) => observedLabels[key] === value)
          );
        });
      }

      // 4. Return
      return toAttrs(scope, live);
    }),

    delete: Effect.fn(function* ({ output, force }) {
      const scope = { projectId: output.projectId, region: output.region };
      const live = yield* getRunnerOrUndefined(scope, output.runnerId);
      if (live === undefined) return;
      if (live.state !== "deleting") {
        // Only `alchemy unsafe nuke` deletes a runner past intakes that aren't in a stack.
        if (!force) yield* assertNoIntakes(scope, output.runnerId);
        yield* intake
          .deleteIntakeRunner({
            ...onRegion(scope),
            intakeRunnerId: output.runnerId,
            ...(force ? { force: true } : {}),
          })
          .pipe(
            Effect.retry(conflictRetry),
            Effect.catchTag("NotFound", () => Effect.void),
          );
      }
      yield* waitForGone(scope, output.runnerId);
    }),
  });
