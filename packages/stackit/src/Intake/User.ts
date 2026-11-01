import * as intake from "@distilled.cloud/stackit/intake";
import { Unowned } from "alchemy/AdoptPolicy";
import { deepEqual } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import { readGeneration, resolveProjectScope } from "../IaaS/internal.ts";
import { toRedacted } from "../internal/dataServices.ts";
import { hasUnresolvedTrigger, rawProp, triggerProps } from "../internal/diff.ts";
import {
  conflictRetry,
  emptyToUndefined,
  findOwnedGeneration,
  generatedDisplayName,
} from "../internal/displayNames.ts";
import { secretsDiffer } from "../internal/equal.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";
import {
  desiredGenerationLabels,
  isAlchemyOwned,
  labelRecord,
  stripInternalLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  getIntakeOrUndefined,
  listIntakeUsers,
  listOwnedIntakes,
  onRegion,
  POLL,
  USER_TIMEOUT,
  type IntakeScope,
} from "./internal.ts";

export interface UserProps {
  /** Id of the intake the user connects to. Changing it replaces the user. */
  intakeId: string;
  /**
   * Password of the user: 12 to 128 characters with at least one lower case letter, one
   * upper case letter, one number and one other character. Updates in place. STACKIT
   * can't return it, so a password changed outside Alchemy isn't detected.
   */
  password: string | Redacted.Redacted<string>;
  /**
   * What the user may do: `intake` publishes to the intake's topic, `dead-letter` only
   * reads its dead letter topic. Updates in place.
   *
   * @default "intake"
   */
  type?: "intake" | "dead-letter";
  /**
   * Name of the user: 1 to 32 letters, digits, spaces and hyphens. Updates in place.
   *
   * @default a unique name generated from the stack, stage and logical ID
   */
  displayName?: string;
  /** Description. Updates in place; omit to leave the live value alone. */
  description?: string;
  /** User labels. Alchemy's ownership labels are always merged in. Updates in place. */
  labels?: Record<string, string>;
  /** Project of the intake. Changing it replaces the user. @default the profile's project */
  projectId?: string;
  /** Region of the intake. Changing it replaces the user. @default the profile's region */
  region?: string;
}

export interface UserAttributes {
  /** STACKIT user id (UUID). Stable across updates. */
  userId: string;
  /** Id of the intake the user connects to. */
  intakeId: string;
  /** Project of the intake. */
  projectId: string;
  /** Region of the intake. */
  region: string;
  /** The SASL user name to connect with. */
  user: string;
  /** The password to connect with. */
  password: Redacted.Redacted<string>;
  /** Name of the user. */
  displayName: string;
  /** Description, if any. */
  description: string | undefined;
  /** What the user may do: `intake` or `dead-letter`. */
  type: string;
  /** User labels (Alchemy ownership labels stripped). */
  labels: Record<string, string>;
  /** State; `active` after a deploy. */
  state: string;
  /**
   * Client configuration STACKIT prepares for this user, with a placeholder for the
   * password. Its endpoint is the one at deploy time.
   */
  clientConfig:
    | {
        /** Configuration for Java Kafka clients. */
        java: string;
        /** Configuration for Kafka clients using librdkafka. */
        librdkafka: string;
      }
    | undefined;
  /** When the user was created (RFC 3339). */
  createTime: string;
}

export type User = Resource<"Stackit.Intake.User", UserProps, UserAttributes, never, Providers>;

/**
 * A user that connects to a `Stackit.Intake.Intake` over the Kafka protocol with SASL:
 * either publishing to its topic, or reading its dead letter topic.
 *
 * You choose the password, and STACKIT never returns it, so Alchemy compares it with the
 * last deployed props. It stays `Redacted` in the `password` attribute, which is what
 * `Stackit.Intake.Produce` and `Stackit.Intake.ConsumeDeadLetter` read.
 *
 * Everything but the intake, project and region updates in place. Ownership is tracked
 * with labels. A user of the same name without them is reported as unowned, and only
 * taken over with `--adopt`.
 *
 * See [STACKIT's Intake docs](https://docs.stackit.cloud/products/data-and-ai/intake/).
 *
 * :::caution[Changing `intakeId`, `projectId` or `region` replaces the User]
 * A new user is created at the new place with the password you chose, and the old one
 * is deleted.
 * :::
 *
 * ### Creating a User
 * **Example:** A user that publishes
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
 *   catalog: { uri: "https://iceberg.example.com/catalog", warehouse: "lake" },
 * });
 * const producer = yield* Stackit.Intake.User("Producer", {
 *   intakeId: events.intakeId,
 *   password,
 * });
 * ```
 *
 * **Example:** A user that reads the dead letter topic
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * const password = Config.Redacted("INTAKE_DLQ_PASSWORD");
 * const runner = yield* Stackit.Intake.Runner("Ingest", {
 *   maxMessageSizeKiB: 1024,
 *   maxMessagesPerHour: 1024,
 * });
 * const events = yield* Stackit.Intake.Intake("Events", {
 *   runnerId: runner.runnerId,
 *   catalog: { uri: "https://iceberg.example.com/catalog", warehouse: "lake" },
 * });
 * const deadLetters = yield* Stackit.Intake.User("DeadLetters", {
 *   intakeId: events.intakeId,
 *   type: "dead-letter",
 *   displayName: "dead-letters",
 *   password,
 * });
 * ```
 *
 * ### Rotating the Password
 * **Example:** Change the prop and deploy
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Config from "effect/Config";
 *
 * // Hosts bound to this user get the new password on the same deploy.
 * const password = Config.Redacted("INTAKE_PASSWORD_2026_11");
 * const runner = yield* Stackit.Intake.Runner("Ingest", {
 *   maxMessageSizeKiB: 1024,
 *   maxMessagesPerHour: 1024,
 * });
 * const events = yield* Stackit.Intake.Intake("Events", {
 *   runnerId: runner.runnerId,
 *   catalog: { uri: "https://iceberg.example.com/catalog", warehouse: "lake" },
 * });
 * const producer = yield* Stackit.Intake.User("Producer", {
 *   intakeId: events.intakeId,
 *   password,
 * });
 * ```
 *
 * @resource
 * @product STACKIT Intake
 * @category Intake
 */
export const User = Resource<User>("Stackit.Intake.User");

const toAttrs = (
  scope: IntakeScope,
  intakeId: string,
  live: intake.IntakeUserResponse,
  password: Redacted.Redacted<string>,
): UserAttributes => ({
  userId: live.id,
  intakeId,
  projectId: scope.projectId,
  region: scope.region,
  user: live.user,
  password,
  displayName: live.displayName,
  description: emptyToUndefined(live.description),
  type: live.type,
  labels: stripInternalLabels(live.labels),
  state: live.state,
  clientConfig: live.clientConfig,
  createTime: live.create_time,
});

/** `read` has no password to report: the API can't return it, and nothing else knows it. */
const UNKNOWN_PASSWORD = /*@__PURE__*/ toRedacted("");

const getOrUndefined = (scope: IntakeScope, intakeId: string, intakeUserId: string) =>
  intake
    .getIntakeUser({ ...onRegion(scope), intakeId, intakeUserId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const waitForActive = (
  scope: IntakeScope,
  intakeId: string,
  intakeUserId: string,
  applied: (live: intake.IntakeUserResponse) => boolean = () => true,
) =>
  waitFor({
    resource: `STACKIT Intake user ${intakeUserId}`,
    read: intake.getIntakeUser({ ...onRegion(scope), intakeId, intakeUserId }),
    ready: (live) => live.state === "active" && applied(live),
    failed: (live) => live.state === "failed" || live.state === "deleting",
    state: (live) => live.state,
    timeout: USER_TIMEOUT,
    ...POLL,
  });

const waitForGone = (scope: IntakeScope, intakeId: string, intakeUserId: string) =>
  waitUntilGone({
    resource: `STACKIT Intake user ${intakeUserId}`,
    read: getOrUndefined(scope, intakeId, intakeUserId),
    state: (live) => live.state,
    timeout: USER_TIMEOUT,
    ...POLL,
  });

export const UserProvider = () =>
  Provider.succeed(User, {
    stables: ["userId", "intakeId", "projectId", "region", "user"],
    nuke: { dependsOn: ["Stackit.Intake.Intake"] },

    list: Effect.fn(function* () {
      const scope = yield* resolveProjectScope(undefined, undefined);
      const intakes = yield* listOwnedIntakes(scope);
      const found: UserAttributes[] = [];
      for (const owner of intakes) {
        const users = yield* listIntakeUsers(scope, owner.id);
        for (const live of users) {
          if (isAlchemyOwned(live.labels)) {
            found.push(toAttrs(scope, owner.id, live, UNKNOWN_PASSWORD));
          }
        }
      }
      return found;
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (output === undefined) return undefined;
      // An unresolved id can resolve to the intake the user is already on. A generated
      // name carries the generation, an explicit one survives it.
      if (hasUnresolvedTrigger<UserProps>(news, ["intakeId", "projectId", "region"])) {
        return {
          action: "replace",
          deleteFirst: rawProp<UserProps>(news, "displayName") !== undefined,
        } as const;
      }
      const resolved = triggerProps<UserProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      if (
        resolved.intakeId !== output.intakeId ||
        scope.projectId !== output.projectId ||
        scope.region !== output.region
      ) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // Everything else updates in place (engine default: props changed, which reads
      // through `Redacted`).
      return undefined;
    }),

    read: Effect.fn(function* ({ id, instanceId, olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const intakeId = output?.intakeId ?? olds?.intakeId;
      if (intakeId === undefined) return undefined;
      const password =
        output?.password ?? (olds !== undefined ? toRedacted(olds.password) : UNKNOWN_PASSWORD);
      if (output?.userId !== undefined) {
        const byId = yield* getOrUndefined(scope, intakeId, output.userId);
        if (byId !== undefined && byId.state !== "deleting") {
          return toAttrs(scope, intakeId, byId, password);
        }
      }
      // The list operation has no typed "intake is gone".
      if ((yield* getIntakeOrUndefined(scope, intakeId)) === undefined) return undefined;
      const users = (yield* listIntakeUsers(scope, intakeId)).filter(
        (live) => live.state !== "deleting",
      );
      const generation = readGeneration({ instanceId, output, previous });
      const owned = yield* findOwnedGeneration(id, generation, users, (live) => live.labels);
      if (owned !== undefined) return toAttrs(scope, intakeId, owned, password);
      const name = output?.displayName ?? olds?.displayName ?? (yield* generatedDisplayName(id));
      const named = users.find((live) => live.displayName === name);
      if (named === undefined) return undefined;
      const attrs = toAttrs(scope, intakeId, named, password);
      return previous?.userId === named.id ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, instanceId, news, olds, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const intakeId = news.intakeId;
      const displayName =
        news.displayName ?? output?.displayName ?? (yield* generatedDisplayName(id));
      const labels = yield* desiredGenerationLabels(id, instanceId, news.labels);

      // 1. Observe — `output` is a cache for the id, and only speaks for this user while
      // it sits on the desired intake. Without it, only this generation's user can be
      // claimed, by its labels.
      let live: intake.IntakeUserResponse | undefined;
      if (
        output?.intakeId === intakeId &&
        output.projectId === scope.projectId &&
        output.region === scope.region
      ) {
        live = yield* getOrUndefined(scope, intakeId, output.userId);
      }
      if (live === undefined) {
        const users = yield* listIntakeUsers(scope, intakeId);
        live = yield* findOwnedGeneration(id, instanceId, users, (item) => item.labels);
      }
      // A delete in flight (an interrupted destroy): let it finish.
      if (live?.state === "deleting") {
        yield* waitForGone(scope, intakeId, live.id);
        live = undefined;
      }

      // 2. Ensure
      let created = false;
      if (live === undefined) {
        live = yield* intake
          .createIntakeUser({
            ...onRegion(scope),
            intakeId,
            displayName,
            password: news.password,
            labels,
            ...(news.type !== undefined ? { type: news.type } : {}),
            ...(news.description !== undefined ? { description: news.description } : {}),
          })
          .pipe(Effect.retry(conflictRetry));
        created = true;
      }
      const userId = live.id;
      live = yield* waitForActive(scope, intakeId, userId);

      // 3. Sync — every drifted aspect against the live user. The password can't be read
      // back, so it is re-sent when the deployed props held another one, or when there are
      // no deployed props to compare with (an adoption or a crashed create).
      const resendPassword =
        !created && (olds === undefined || secretsDiffer(olds.password, news.password));
      const patch = {
        ...(live.displayName !== displayName ? { displayName } : {}),
        ...(news.description !== undefined && (live.description ?? "") !== news.description
          ? { description: news.description }
          : {}),
        ...(news.type !== undefined && live.type !== news.type ? { type: news.type } : {}),
        ...(deepEqual(labelRecord(live.labels), labels) ? {} : { labels }),
        ...(resendPassword ? { password: news.password } : {}),
      };
      if (Object.keys(patch).length > 0) {
        yield* intake
          .updateIntakeUser({
            ...onRegion(scope),
            intakeId,
            intakeUserId: userId,
            ...patch,
          })
          .pipe(Effect.retry(conflictRetry));
        live = yield* waitForActive(
          scope,
          intakeId,
          userId,
          (observed) =>
            observed.displayName === displayName &&
            (news.type === undefined || observed.type === news.type),
        );
      }

      // 4. Return
      return toAttrs(scope, intakeId, live, toRedacted(news.password));
    }),

    delete: Effect.fn(function* ({ output }) {
      const scope = { projectId: output.projectId, region: output.region };
      const { intakeId, userId } = output;
      yield* intake.deleteIntakeUser({ ...onRegion(scope), intakeId, intakeUserId: userId }).pipe(
        Effect.retry(conflictRetry),
        Effect.catchTag("NotFound", () => Effect.void),
      );
      yield* waitForGone(scope, intakeId, userId);
    }),
  });
