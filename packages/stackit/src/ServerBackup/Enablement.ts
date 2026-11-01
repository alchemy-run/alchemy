import * as serverBackup from "@distilled.cloud/stackit/server_backup";
import { Unowned } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { resolveProjectScope } from "../IaaS/internal.ts";
import { hasUnresolvedTrigger, triggerProps } from "../internal/diff.ts";
import {
  isOnTarget,
  listOwnedServers,
  recordedTarget,
  type ServerTarget,
} from "../internal/servers.ts";
import { childrenLeftAfterSettling, waitFor, waitUntilGone } from "../internal/wait.ts";
import type { Providers } from "../Providers.ts";
import {
  BACKUP_POLL,
  BACKUP_TIMEOUT,
  isBackupServiceEnabled,
  listServerBackupObjects,
  listServerBackups,
  listServerSchedules,
} from "./internal.ts";

export interface EnablementProps {
  /** Server to turn the service on for. Changing it replaces the enablement. */
  serverId: string;
  /**
   * Backup policy to enable the service with. List them with
   * `Stackit.ServerBackup.ListPolicies`. STACKIT has no way to change or read it afterwards,
   * so changing it disables the service and enables it again.
   */
  backupPolicyId?: string;
  /**
   * Also delete every schedule and backup on the server when the enablement is destroyed or
   * replaced, including those that aren't in this stack, and with the API's `force` flag.
   * Without it, anything left on the server stops the delete with
   * `Stackit.ServerBackup.EnablementNotEmpty`. Deploy it before the change that replaces the
   * enablement: an old enablement keeps the props it was deployed with.
   *
   * @default false
   */
  forceDestroy?: boolean;
  /**
   * Project of the server. Defaults to the profile's project. Changing it replaces the
   * enablement.
   */
  projectId?: string;
  /**
   * Region of the server. Defaults to the profile's region. Changing it replaces the
   * enablement.
   */
  region?: string;
}

export interface EnablementAttributes {
  /** Server the service is on for. */
  serverId: string;
  /** Whether the service is on; `true` after a deploy. */
  enabled: boolean;
  /** Project of the server. */
  projectId: string;
  /** Region of the server. */
  region: string;
}

export type Enablement = Resource<
  "Stackit.ServerBackup.Enablement",
  EnablementProps,
  EnablementAttributes,
  never,
  Providers
>;

/** A server still has schedules or backups when the service is disabled. */
export class EnablementNotEmpty extends Data.TaggedError(
  "Stackit.ServerBackup.EnablementNotEmpty",
)<{
  readonly serverId: string;
  readonly schedules: ReadonlyArray<string>;
  readonly backups: ReadonlyArray<string>;
  readonly message: string;
}> {}

/**
 * Turns STACKIT Server Backup Management on for one server, so it can have
 * `Stackit.ServerBackup.Schedule`s and `Stackit.ServerBackup.Backup`s. It's different from
 * `Stackit.IaaS.Backup`, which backs up one volume through the IaaS API. The service is
 * billed per server per started hour while it's on, plus backup storage.
 *
 * The enablement is a switch with no labels, so state is the only proof of ownership. A
 * server that already has the service on, found without state, is reported as unowned and
 * only taken over with `--adopt`. That includes a deploy that crashed between enabling the
 * service and saving state; destroying an adopted enablement disables the service for
 * whoever else relied on it. Declare one enablement per server.
 *
 * ### Enabling Backups
 * **Example:** Enable backups for a server
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const server = yield* Stackit.IaaS.Server("Db", {
 *   machineType: "g1.1",
 *   bootVolume: { size: 20, source: { type: "image", id: "<image id>" } },
 *   networking: { networkId: network.networkId },
 * });
 * const backups = yield* Stackit.ServerBackup.Enablement("DbBackups", {
 *   serverId: server.serverId,
 * });
 * ```
 *
 * **Example:** Enable backups with a policy
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const server = yield* Stackit.IaaS.Server("Db", {
 *   machineType: "g1.1",
 *   bootVolume: { size: 20, source: { type: "image", id: "<image id>" } },
 *   networking: { networkId: network.networkId },
 * });
 * const backups = yield* Stackit.ServerBackup.Enablement("DbBackups", {
 *   serverId: server.serverId,
 *   backupPolicyId: "<backup policy id>",
 * });
 * ```
 *
 * ### Scheduling Backups
 * **Example:** Pass the server through the enablement to order a schedule after it
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("App", {
 *   ipv4: { prefix: "10.0.1.0/24" },
 * });
 * const server = yield* Stackit.IaaS.Server("Db", {
 *   machineType: "g1.1",
 *   bootVolume: { size: 20, source: { type: "image", id: "<image id>" } },
 *   networking: { networkId: network.networkId },
 * });
 * const backups = yield* Stackit.ServerBackup.Enablement("DbBackups", {
 *   serverId: server.serverId,
 * });
 * yield* Stackit.ServerBackup.Schedule("Nightly", {
 *   serverId: backups.serverId,
 *   rrule: "DTSTART;TZID=Europe/Berlin:20260101T020000 RRULE:FREQ=DAILY;INTERVAL=1",
 *   backupProperties: { name: "nightly", retentionPeriod: 14 },
 * });
 * ```
 *
 * ### What Deleting Does <!-- api-prose -->
 * STACKIT doesn't document what disabling the service does to a server's backups, so
 * Alchemy never finds out with your data. A delete lists the server's schedules and backups,
 * waits up to two minutes for this stack's own to go, and fails with
 * `Stackit.ServerBackup.EnablementNotEmpty`, naming what's left, without calling the API to
 * disable anything. Only an empty server is disabled.
 *
 * With `forceDestroy`, or under `alchemy unsafe nuke`, a delete first deletes every schedule
 * and every backup on the server, including those made in the portal, by a policy, by
 * another stack or at runtime, and then disables the service. Those backups are gone.
 *
 * ### Replacement Cautions <!-- api-prose -->
 * Changing `backupPolicyId`, or replacing the server when its new id isn't known at plan,
 * deletes the old enablement first, before any schedule or backup of this stack is deleted. So
 * while the server has any, the plan fails with `Stackit.ServerBackup.EnablementNotEmpty` and
 * nothing changes. Take them out of the stack in a deploy of its own, or deploy `forceDestroy` on
 * its own to delete them with the enablement, and then make the change.
 *
 * Changing `serverId`, `projectId` or `region` to a known value enables the service at the new
 * place, then deletes the old enablement as above. Something the stack doesn't hold stops that
 * delete with both enablements running and billed, and `forceDestroy` set by then doesn't reach
 * it, because an old enablement keeps the props it was deployed with. Every later deploy stops
 * there until what's left is deleted by hand.
 *
 * @resource
 * @product STACKIT Server Backup Management
 * @category ServerBackup
 */
export const Enablement = Resource<Enablement>("Stackit.ServerBackup.Enablement");

const toAttrs = (target: ServerTarget): EnablementAttributes => ({
  ...recordedTarget(target),
  enabled: true,
});

/** Disabled or missing is gone: the spec answers 404 for "Server, or service, Not Found". */
const waitForDisabled = (target: ServerTarget) =>
  waitUntilGone({
    resource: `STACKIT Server Backup service on server ${target.serverId}`,
    read: isBackupServiceEnabled(target).pipe(
      Effect.map((enabled) => (enabled ? "enabled" : undefined)),
    ),
    state: (state) => state,
    timeout: "5 minutes",
    interval: "2 seconds",
  });

/** What's on the server, whoever made it. */
const serverChildren = (target: ServerTarget) =>
  Effect.gen(function* () {
    const schedules = yield* listServerSchedules(target);
    const backups = yield* listServerBackups(target);
    return { schedules, backups };
  });

/**
 * Wait for this stack's schedules and backups to go, then refuse if any are left. They are
 * deleted and awaited before the enablement, so what remains is someone else's, or one of
 * this stack that a delete-first replacement of the enablement hasn't reached.
 */
const notEmptyError = (
  target: ServerTarget,
  schedules: ReadonlyArray<string>,
  backups: ReadonlyArray<string>,
  remedy: string,
) =>
  new EnablementNotEmpty({
    serverId: target.serverId,
    schedules,
    backups,
    message: `Server ${target.serverId} still has backup schedules (${schedules.join(", ") || "none"}) and backups (${backups.join(", ") || "none"}). ${remedy}`,
  });

/**
 * A delete-first replacement reaches the old enablement before any child in the stack is deleted:
 * those deletes only run once the deploy has otherwise succeeded. So it can't get through while
 * there are children, and a plan is where to say so, before anything is created. `olds` because
 * the old enablement's delete is what sees it.
 */
const refuseDeleteFirst = (target: ServerTarget, olds: EnablementProps | undefined) =>
  Effect.gen(function* () {
    if (olds?.forceDestroy === true) return;
    const { schedules, backups } = yield* listServerBackupObjects(target);
    if (schedules.length === 0 && backups.length === 0) return;
    return yield* notEmptyError(
      target,
      schedules.map(({ name }) => name),
      backups.map(({ name }) => name),
      "This change deletes the enablement before them, so nothing was changed. Take them out of the stack in a deploy of its own, or deploy forceDestroy: true on the enablement on its own to delete them, then make this change.",
    );
  });

const assertEmpty = (target: ServerTarget) =>
  Effect.gen(function* () {
    const left = yield* childrenLeftAfterSettling(
      serverChildren(target).pipe(
        Effect.map(({ schedules, backups }) => [
          ...schedules.map((schedule) => ({ kind: "schedule" as const, name: schedule.name })),
          ...backups.map((backup) => ({ kind: "backup" as const, name: backup.name })),
        ]),
      ),
    );
    if (left.length === 0) return;
    const schedules = left.filter((child) => child.kind === "schedule").map(({ name }) => name);
    const backups = left.filter((child) => child.kind === "backup").map(({ name }) => name);
    return yield* notEmptyError(
      target,
      schedules,
      backups,
      "Backups were not disabled. Delete them first, or deploy forceDestroy: true on the enablement to delete them with it. An enablement already being replaced keeps the props it was deployed with, so only deleting them by hand finishes that replacement.",
    );
  });

/** Delete everything on the server. Only behind `forceDestroy` or nuke. */
const deleteChildren = (target: ServerTarget) =>
  Effect.gen(function* () {
    const { schedules, backups } = yield* serverChildren(target);
    for (const schedule of schedules) {
      yield* serverBackup
        .deleteBackupSchedule({ ...target, backupScheduleId: String(schedule.id) })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
    for (const backup of backups) {
      yield* serverBackup
        .deleteBackup({ ...target, backupId: backup.id, force: true })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }
    yield* waitFor({
      resource: `the backups on STACKIT server ${target.serverId} to be deleted`,
      read: listServerBackups(target),
      ready: (left) => left.length === 0,
      failed: (left) => left.find((backup) => backup.status === "error-deleting")?.status,
      state: (left) => `${left.length} left`,
      timeout: BACKUP_TIMEOUT,
      ...BACKUP_POLL,
    });
  });

export const EnablementProvider = () =>
  Provider.succeed(Enablement, {
    stables: ["serverId", "projectId", "region"],
    nuke: { dependsOn: ["Stackit.IaaS.Server"] },

    list: Effect.fn(function* () {
      const servers = yield* listOwnedServers;
      const enabled: EnablementAttributes[] = [];
      for (const target of servers) {
        if (yield* isBackupServiceEnabled(target)) enabled.push(toAttrs(target));
      }
      return enabled;
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (output === undefined) return undefined;
      // The server is the whole identity, with no generation in it: an unresolved id can
      // resolve to the server it's already on, so the old enablement goes first. Otherwise
      // garbage collection would disable the service under its replacement.
      if (
        hasUnresolvedTrigger<EnablementProps>(news, [
          "serverId",
          "backupPolicyId",
          "projectId",
          "region",
        ])
      ) {
        yield* refuseDeleteFirst(recordedTarget(output), olds);
        return { action: "replace", deleteFirst: true } as const;
      }
      const resolved = triggerProps<EnablementProps>(news);
      const scope = yield* resolveProjectScope(resolved, undefined);
      if (!isOnTarget(output, { ...scope, serverId: resolved.serverId })) {
        return { action: "replace", deleteFirst: false } as const;
      }
      // The policy can't be read back, so only `olds` knows it, and only enabling sets it.
      if (olds !== undefined && resolved.backupPolicyId !== olds.backupPolicyId) {
        yield* refuseDeleteFirst(recordedTarget(output), olds);
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ olds, output, previous }) {
      const scope = yield* resolveProjectScope(olds, output);
      const serverId = output?.serverId ?? olds?.serverId;
      if (serverId === undefined) return undefined;
      const target = { ...scope, serverId };
      if (!(yield* isBackupServiceEnabled(target))) return undefined;
      const attrs = toAttrs(target);
      if (output !== undefined) return attrs;
      // Nothing on the switch says who turned it on.
      return isOnTarget(previous, target) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const scope = yield* resolveProjectScope(news, output);
      const target = { ...scope, serverId: news.serverId };

      // Observe, then ensure. There's nothing to sync: the policy has no update call. A 409
      // says it's already on, which is a race (per the Terraform provider).
      if (!(yield* isBackupServiceEnabled(target))) {
        yield* serverBackup
          .enableServiceResource({
            ...target,
            ...(news.backupPolicyId !== undefined ? { backupPolicyId: news.backupPolicyId } : {}),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.void));
        yield* waitFor({
          resource: `STACKIT Server Backup service on server ${target.serverId}`,
          read: isBackupServiceEnabled(target),
          ready: (enabled) => enabled,
          state: (enabled) => (enabled ? "enabled" : "disabled"),
          timeout: "5 minutes",
          interval: "2 seconds",
        });
      }
      return toAttrs(target);
    }),

    delete: Effect.fn(function* ({ olds, output, force }) {
      const target = recordedTarget(output);
      if (!(yield* isBackupServiceEnabled(target))) return;
      // Disabling with anything left on the server is undocumented, so that takes an opt-in:
      // the prop, or `alchemy unsafe nuke`.
      if (olds?.forceDestroy === true || force === true) {
        yield* deleteChildren(target);
      } else {
        yield* assertEmpty(target);
      }
      yield* serverBackup
        .disableServiceResource(target)
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitForDisabled(target);
    }),
  });
