import * as intake from "@distilled.cloud/stackit/intake";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { readGeneration, resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import {
  conflictRetry,
  emptyToUndefined,
  findOwnedGeneration,
  generatedDisplayName,
} from "../internal/displayNames.ts";
import { secretsDiffer } from "../internal/equal.ts";
import { childrenLeftAfterSettling, waitFor, waitUntilGone } from "../internal/wait.ts";
import { desiredGenerationLabels, labelRecord, stripInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  getIntakeOrUndefined,
  INTAKE_TIMEOUT,
  listIntakes,
  listIntakeUsers,
  listOwnedIntakes,
  onRegion,
  POLL,
  type IntakeScope,
} from "./internal.ts";

/** How an intake authenticates at the Iceberg catalog. */
export type IntakeCatalogAuth =
  | {
      /** No authentication. */
      type: "none";
    }
  | {
      /** A Dremio personal access token. */
      type: "dremio";
      /**
       * The token. It doesn't renew by itself: when it expires, the intake can no longer
       * reach the catalog until you deploy a new one.
       */
      personalAccessToken: string | Redacted.Redacted<string>;
      /** The Dremio instance's OAuth 2.0 token endpoint. */
      tokenEndpoint: string;
    };

/** The Iceberg table an intake writes to. */
export interface IntakeCatalogConfig {
  /** URI of the Iceberg REST catalog. */
  uri: string;
  /** Iceberg warehouse to connect to. */
  warehouse: string;
  /**
   * Namespace to write to. STACKIT creates it if it doesn't exist. Omit to keep STACKIT's
   * default.
   */
  namespace?: string;
  /** Name of the table. Omit to keep STACKIT's default. */
  tableName?: string;
  /**
   * How the table is partitioned: `none`, `intake-time` (daily, by ingestion time) or
   * `manual` (by `partitionBy`). A change only takes effect once the table changes too.
   * Omit to keep STACKIT's default.
   */
  partitioning?: "none" | "intake-time" | "manual";
  /** Iceberg partitioning expressions, with `partitioning: "manual"`. */
  partitionBy?: string[];
  /**
   * Authentication at the catalog.
   * @default { type: "none" }
   */
  auth?: IntakeCatalogAuth;
}

export interface IntakeProps {
  /**
   * Id of the runner the intake runs on. Updates in place, so an intake moves to a new
   * runner without replacing its users.
   */
  runnerId: string;
  /** The Iceberg table to write to. Updates in place. */
  catalog: IntakeCatalogConfig;
  /**
   * Name of the intake: 1 to 32 letters, digits, spaces and hyphens. Updates in place.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  displayName?: string;
  /** Description. Updates in place; omit to leave the live value alone. */
  description?: string;
  /** User labels. Alchemy's ownership labels are always merged in. Updates in place. */
  labels?: Record<string, string>;
  /** Project of the intake. Changing it replaces the intake. @default the profile's project */
  projectId?: string;
  /** Region of the intake. Changing it replaces the intake. @default the profile's region */
  region?: string;
}

export interface IntakeCatalogAttributes {
  /** URI of the Iceberg REST catalog. */
  uri: string;
  /** Iceberg warehouse. */
  warehouse: string;
  /** Namespace written to. */
  namespace: string | undefined;
  /** Name of the table. */
  tableName: string | undefined;
  /** How the table is partitioned. */
  partitioning: string | undefined;
  /** Partitioning expressions. */
  partitionBy: string[] | undefined;
  /** Kind of authentication at the catalog. */
  authType: string;
  /** The Dremio token endpoint, with `dremio` authentication. */
  tokenEndpoint: string | undefined;
}

export interface IntakeAttributes {
  /** STACKIT intake id (UUID). Stable across updates. */
  intakeId: string;
  /** Project of the intake. */
  projectId: string;
  /** Region of the intake. */
  region: string;
  /** Name of the intake. */
  displayName: string;
  /** Description, if any. */
  description: string | undefined;
  /** Id of the runner the intake runs on. */
  runnerId: string;
  /** The Iceberg table, without the token. */
  catalog: IntakeCatalogAttributes;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
  /** State; `active` after a deploy. */
  state: string;
  /** STACKIT's description of the failure, while `state` is `failed`. */
  failureMessage: string | undefined;
  /** Kafka endpoint to publish to, `host:port`. Changes with the runner. */
  uri: string;
  /** Kafka topic to publish to. */
  topic: string;
  /** Kafka topic holding messages that couldn't be delivered. */
  deadLetterTopic: string;
  /** Messages sent to the dead letter topic. */
  undeliveredMessageCount: number;
  /** When the intake was created (RFC 3339). */
  createTime: string;
}

export type Intake = Resource<
  "Stackit.Intake.Intake",
  IntakeProps,
  IntakeAttributes,
  never,
  Providers
>;

/**
 * A STACKIT Intake: a pipeline on a `Stackit.Intake.Runner` that takes JSON messages from
 * a Kafka topic and flushes them into one Apache Iceberg table, about five minutes after
 * they arrive. Messages it can't deliver, such as non-JSON ones, go to a dead letter
 * topic.
 *
 * Everything but the project and region updates in place, including the runner. A
 * Dremio token is compared with the last deployed props and re-sent when it differs, so
 * one rotated outside Alchemy isn't detected.
 *
 * A deploy waits until the intake is `active`, and fails with STACKIT's message when it
 * reports `failed`. The next deploy re-applies the props to a failed intake.
 *
 * Ownership is tracked with labels. An intake of the same name without them is reported
 * as unowned, and only taken over with `--adopt`.
 *
 * ### Creating an Intake
 * **Example:** Write to a table through a Dremio catalog
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const token = yield* Config.redacted("DREMIO_TOKEN");
 * const runner = yield* Stackit.Intake.Runner("Ingest", {
 *   maxMessageSizeKiB: 1024,
 *   maxMessagesPerHour: 1024,
 * });
 * const events = yield* Stackit.Intake.Intake("Events", {
 *   runnerId: runner.runnerId,
 *   catalog: {
 *     uri: "https://my-dremio.data-platform.stackit.run/iceberg",
 *     warehouse: "lake",
 *     namespace: "clickstream",
 *     tableName: "events",
 *     auth: {
 *       type: "dremio",
 *       personalAccessToken: token,
 *       tokenEndpoint: "https://my-dremio.data-platform.stackit.run/oauth/token",
 *     },
 *   },
 * });
 * ```
 *
 * ### Partitioning the Table
 * **Example:** Partition by an Iceberg expression
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const runner = yield* Stackit.Intake.Runner("Ingest", {
 *   maxMessageSizeKiB: 1024,
 *   maxMessagesPerHour: 1024,
 * });
 * const events = yield* Stackit.Intake.Intake("Events", {
 *   runnerId: runner.runnerId,
 *   catalog: {
 *     uri: "https://iceberg.example.com/catalog",
 *     warehouse: "lake",
 *     partitioning: "manual",
 *     partitionBy: ["day(created_at)"],
 *   },
 * });
 * ```
 *
 * ### Publishing to It
 * **Example:** Produce from a long-running host
 * ```typescript
 * import * as Docker from "@alchemy.run/docker";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Ingest = Stackit.Intake.Runner("Ingest", {
 *   maxMessageSizeKiB: 1024,
 *   maxMessagesPerHour: 1024,
 * });
 * export const Events = Ingest.pipe(
 *   Effect.flatMap((runner) =>
 *     Stackit.Intake.Intake("Events", {
 *       runnerId: runner.runnerId,
 *       catalog: { uri: "https://iceberg.example.com/catalog", warehouse: "lake" },
 *     }),
 *   ),
 * );
 * export const Producer = Events.pipe(
 *   Effect.flatMap((events) =>
 *     Stackit.Intake.User("Producer", {
 *       intakeId: events.intakeId,
 *       password: "replace-with-a-secret-Pw1!",
 *     }),
 *   ),
 * );
 *
 * export default class Api extends Docker.Service<Api>()(
 *   "Api",
 *   { main: import.meta.filename, port: 3000 },
 *   Effect.gen(function* () {
 *     const events = yield* Events;
 *     const producer = yield* Producer;
 *     const produce = yield* Stackit.Intake.Produce(events, producer);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         yield* produce({ messages: [{ value: JSON.stringify({ hello: "world" }) }] });
 *         return yield* HttpServerResponse.json({ sent: true });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.Intake.ProduceKafka)),
 * ) {}
 * ```
 *
 * @resource
 * @product STACKIT Intake
 * @category Intake
 */
export const Intake = Resource<Intake>("Stackit.Intake.Intake");

/** An intake still has users when it is deleted. */
export class IntakeNotEmpty extends Data.TaggedError("Stackit.Intake.IntakeNotEmpty")<{
  readonly intakeId: string;
  readonly users: ReadonlyArray<string>;
  readonly message: string;
}> {}

const toAttrs = (scope: IntakeScope, live: intake.IntakeResponse): IntakeAttributes => ({
  intakeId: live.id,
  projectId: scope.projectId,
  region: scope.region,
  displayName: live.displayName,
  description: emptyToUndefined(live.description),
  runnerId: live.intakeRunnerId,
  catalog: {
    uri: live.catalog.uri,
    warehouse: live.catalog.warehouse,
    namespace: live.catalog.namespace,
    tableName: live.catalog.tableName,
    partitioning: live.catalog.partitioning,
    partitionBy: live.catalog.partitionBy === null ? undefined : live.catalog.partitionBy,
    authType: live.catalog.auth?.type ?? "none",
    tokenEndpoint: live.catalog.auth?.dremio?.tokenEndpoint,
  },
  labels: stripInternalLabels(live.labels),
  state: live.state,
  failureMessage: emptyToUndefined(live.failure_message),
  uri: live.uri,
  topic: live.topic,
  deadLetterTopic: live.deadLetterTopic,
  undeliveredMessageCount: live.undeliveredMessageCount ?? 0,
  createTime: live.create_time,
});

const toRequestAuth = (auth: IntakeCatalogAuth): intake.CatalogAuth =>
  auth.type === "dremio"
    ? {
        type: "dremio",
        dremio: {
          personalAccessToken: auth.personalAccessToken,
          tokenEndpoint: auth.tokenEndpoint,
        },
      }
    : { type: "none" };

const toRequestCatalog = (catalog: IntakeCatalogConfig): intake.IntakeCatalog => ({
  uri: catalog.uri,
  warehouse: catalog.warehouse,
  ...(catalog.namespace !== undefined ? { namespace: catalog.namespace } : {}),
  ...(catalog.tableName !== undefined ? { tableName: catalog.tableName } : {}),
  ...(catalog.partitioning !== undefined ? { partitioning: catalog.partitioning } : {}),
  ...(catalog.partitionBy !== undefined ? { partitionBy: [...catalog.partitionBy] } : {}),
  ...(catalog.auth !== undefined ? { auth: toRequestAuth(catalog.auth) } : {}),
});

/** The parts of the catalog that differ from the props, without the authentication. */
const catalogDelta = (
  live: intake.IntakeCatalog,
  desired: IntakeCatalogConfig,
): intake.IntakeCatalogPatch => ({
  ...(live.uri !== desired.uri ? { uri: desired.uri } : {}),
  ...(live.warehouse !== desired.warehouse ? { warehouse: desired.warehouse } : {}),
  ...(desired.namespace !== undefined && live.namespace !== desired.namespace
    ? { namespace: desired.namespace }
    : {}),
  ...(desired.tableName !== undefined && live.tableName !== desired.tableName
    ? { tableName: desired.tableName }
    : {}),
  ...(desired.partitioning !== undefined && live.partitioning !== desired.partitioning
    ? { partitioning: desired.partitioning }
    : {}),
  ...(desired.partitionBy !== undefined && !deepEqual(live.partitionBy, desired.partitionBy)
    ? { partitionBy: [...desired.partitionBy] }
    : {}),
});

/** Whether the authentication the API shows differs from the props. */
const authDrifted = (live: intake.IntakeCatalog, desired: IntakeCatalogConfig) => {
  const auth: IntakeCatalogAuth = desired.auth ?? { type: "none" };
  if ((live.auth?.type ?? "none") !== auth.type) return true;
  return auth.type === "dremio" && live.auth?.dremio?.tokenEndpoint !== auth.tokenEndpoint;
};

type IntakePatch = Omit<intake.UpdateIntakeRequest, "projectId" | "regionId" | "intakeId">;

/** Polls a `failed` state may be left over from before a repairing update. */
const STALE_FAILED_POLLS = 6;

const waitForActive = (
  scope: IntakeScope,
  intakeId: string,
  options: {
    readonly applied?: (live: intake.IntakeResponse) => boolean;
    readonly staleFailedPolls?: number;
  } = {},
) => {
  let polls = 0;
  return waitFor({
    resource: `STACKIT Intake ${intakeId}`,
    read: intake.getIntake({ ...onRegion(scope), intakeId }),
    ready: (live) => live.state === "active" && (options.applied?.(live) ?? true),
    failed: (live) => {
      polls++;
      if (live.state === "deleting") return "the intake is being deleted";
      return live.state === "failed" && polls > (options.staleFailedPolls ?? 0)
        ? (live.failure_message ?? "failed")
        : undefined;
    },
    state: (live) => live.state,
    timeout: INTAKE_TIMEOUT,
    ...POLL,
  });
};

const waitForGone = (scope: IntakeScope, intakeId: string) =>
  waitUntilGone({
    resource: `STACKIT Intake ${intakeId}`,
    read: getIntakeOrUndefined(scope, intakeId),
    state: (live) => live.state,
    timeout: INTAKE_TIMEOUT,
    ...POLL,
  });

/**
 * Refuse before the delete: with users left, the API puts the intake into `deleting` and
 * keeps it there, which can't be taken back. What a destroy deleted is gone by now, so what
 * remains is someone else's.
 */
const assertNoUsers = (scope: IntakeScope, intakeId: string) =>
  Effect.gen(function* () {
    const left = yield* childrenLeftAfterSettling(listIntakeUsers(scope, intakeId));
    if (left.length === 0) return;
    const names = left.map((user) => user.displayName);
    return yield* new IntakeNotEmpty({
      intakeId,
      users: names,
      message: `Intake ${intakeId} still has users: ${names.join(", ")}. Deleting it would leave it stuck deleting until they go. Delete them first.`,
    });
  });

export const IntakeProvider = () =>
  Provider.succeed(Intake, {
    stables: ["intakeId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.Intake.Runner"] },

    list: Effect.fn(function* () {
      const scope = yield* resolveProjectScope(undefined, undefined);
      const owned = yield* listOwnedIntakes(scope);
      return owned.map((live) => toAttrs(scope, live));
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // The runner isn't a trigger: an intake moves to a new runner in place. An
      // unresolved project or region can resolve to the one the intake is in. A
      // generated name carries the generation, an explicit one survives it.
      if (hasUnresolvedTrigger<IntakeProps>(news, ["projectId", "region"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<IntakeProps>(news, "displayName") !== undefined,
        } as const;
      }
      const resolved = triggerProps<IntakeProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      if (scope.projectId !== output.projectId || scope.region !== output.region) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Everything else updates in place (engine default: props changed, which reads
      // through `Redacted`).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      if (output?.intakeId !== undefined) {
        const byId = yield* getIntakeOrUndefined(scope, output.intakeId);
        if (byId !== undefined && byId.state !== "deleting") return toAttrs(scope, byId);
      }
      const intakes = (yield* listIntakes(scope)).filter((live) => live.state !== "deleting");
      const generation = readGeneration({ instanceId, output, previous });
      const owned = yield* findOwnedGeneration(id, generation, intakes, (live) => live.labels);
      if (owned !== undefined) return toAttrs(scope, owned);
      const name = output?.displayName ?? olds?.displayName ?? (yield* generatedDisplayName(id));
      const named = intakes.find((live) => live.displayName === name);
      if (named === undefined) return undefined;
      const attrs = toAttrs(scope, named);
      return previous?.intakeId === named.id ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const displayName =
        news.displayName ?? output?.displayName ?? (yield* generatedDisplayName(id));
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);

      // 1. Observe — `output` is a cache for the id, and only speaks for this intake while
      // it sits in the desired project and region. Without it, only this generation's
      // intake can be claimed, by its labels.
      let live: intake.IntakeResponse | undefined;
      if (output?.projectId === scope.projectId && output.region === scope.region) {
        live = yield* getIntakeOrUndefined(scope, output.intakeId);
      }
      if (live === undefined) {
        const intakes = yield* listIntakes(scope);
        live = yield* findOwnedGeneration(id, instanceId, intakes, (item) => item.labels);
      }
      // A delete in flight (an interrupted destroy): let it finish.
      if (live?.state === "deleting") {
        yield* waitForGone(scope, live.id);
        live = undefined;
      }

      // 2. Ensure
      let created = false;
      if (live === undefined) {
        live = yield* intake
          .createIntake({
            ...onRegion(scope),
            displayName,
            intakeRunnerId: news.runnerId,
            catalog: toRequestCatalog(news.catalog),
            labels,
            ...(news.description !== undefined ? { description: news.description } : {}),
          })
          .pipe(Effect.retry(conflictRetry));
        created = true;
      }
      const intakeId = live.id;

      // Wait out work in flight. A failed intake is synced as it is: the update below
      // re-applies the props, which is the only repair the API has.
      if (live.state === "reconciling" || created) {
        live = yield* waitFor({
          resource: `STACKIT Intake ${intakeId}`,
          read: intake.getIntake({ ...onRegion(scope), intakeId }),
          ready: (observed) => observed.state !== "reconciling",
          failed: (observed) =>
            created && observed.state === "failed"
              ? (observed.failure_message ?? "failed")
              : undefined,
          state: (observed) => observed.state,
          timeout: INTAKE_TIMEOUT,
          ...POLL,
        });
      }
      const wasFailed = live.state === "failed";

      // 3. Sync — every drifted aspect against the live intake. The token can't be compared
      // with it, so authentication is re-sent when the deployed props held another token,
      // or when there are no deployed props to compare with (an adoption or a crashed
      // create). The API needs the runner in every update.
      const catalogPatch = catalogDelta(live.catalog, news.catalog);
      const resendAuth =
        authDrifted(live.catalog, news.catalog) ||
        (!created &&
          news.catalog.auth?.type === "dremio" &&
          (olds === undefined || secretsDiffer(olds.catalog.auth, news.catalog.auth)));
      const catalog: intake.IntakeCatalogPatch = {
        ...catalogPatch,
        ...(resendAuth ? { auth: toRequestAuth(news.catalog.auth ?? { type: "none" }) } : {}),
      };
      const patch: Omit<IntakePatch, "intakeRunnerId"> = {
        ...(live.displayName !== displayName ? { displayName } : {}),
        ...(news.description !== undefined && (live.description ?? "") !== news.description
          ? { description: news.description }
          : {}),
        ...(Object.keys(catalog).length > 0 ? { catalog } : {}),
        ...(deepEqual(labelRecord(live.labels), labels) ? {} : { labels }),
      };
      if (Object.keys(patch).length > 0 || live.intakeRunnerId !== news.runnerId || wasFailed) {
        yield* intake
          .updateIntake({
            ...onRegion(scope),
            intakeId,
            intakeRunnerId: news.runnerId,
            ...patch,
          })
          .pipe(Effect.retry(conflictRetry));
        live = yield* waitForActive(scope, intakeId, {
          staleFailedPolls: wasFailed ? STALE_FAILED_POLLS : 0,
          applied: (observed) =>
            observed.intakeRunnerId === news.runnerId &&
            observed.displayName === displayName &&
            (news.description === undefined || (observed.description ?? "") === news.description) &&
            Object.keys(catalogDelta(observed.catalog, news.catalog)).length === 0 &&
            !authDrifted(observed.catalog, news.catalog),
        });
      } else if (live.state !== "active") {
        live = yield* waitForActive(scope, intakeId);
      }

      // 4. Return
      return toAttrs(scope, live);
    }),

    delete: Effect.fn(function* ({ output, force }) {
      const scope = { projectId: output.projectId, region: output.region };
      const live = yield* getIntakeOrUndefined(scope, output.intakeId);
      if (live === undefined) return;
      if (live.state !== "deleting") {
        // Only `alchemy unsafe nuke` deletes an intake past users that aren't in a stack.
        if (!force) yield* assertNoUsers(scope, output.intakeId);
        yield* intake
          .deleteIntake({
            ...onRegion(scope),
            intakeId: output.intakeId,
            ...(force ? { force: true } : {}),
          })
          .pipe(
            Effect.retry(conflictRetry),
            Effect.catchTag("NotFound", () => Effect.void),
          );
      }
      yield* waitForGone(scope, output.intakeId);
    }),
  });
