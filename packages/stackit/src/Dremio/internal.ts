/**
 * Shared scaffolding of the STACKIT Dremio resources. Not exported from the namespace
 * barrel.
 *
 * This API has no labels. A generated name holds the generation's instance id, so it
 * proves ownership; an explicit name proves nothing without state.
 */
import * as dremio from "@distilled.cloud/stackit/dremio";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import type { ProjectScope } from "../IaaS/internal.ts";
import { collectTokenPages } from "../internal/displayNames.ts";
import { isGeneratedPhysicalName } from "../internal/names.ts";
import { waitFor, waitUntilGone } from "../internal/wait.ts";

/** Instance create, update and delete budget (the Go SDK's wait handlers). */
export const INSTANCE_TIMEOUT = "30 minutes";

/** User create and delete budget (the Go SDK's wait handlers). */
export const USER_TIMEOUT = "10 minutes";

const POLL = { interval: "5 seconds", maxInterval: "15 seconds" } as const;

/** The spec limits a display name to `^[a-zA-Z0-9 ]*$` and 32 characters. */
const MAX_DISPLAY_NAME_LENGTH = 32;

/** The spec limits a user's name to 128 characters. */
const MAX_USER_NAME_LENGTH = 128;

/**
 * The spec's 409 says "the resource has been modified by some other client, please try
 * again". Bounded to about a minute.
 */
export const conflictRetry = {
  while: (error: { readonly _tag: string }) => error._tag === "Conflict",
  schedule: Schedule.spaced("10 seconds"),
  times: 6,
} as const;

/** A secret as a prop accepts it, always `Redacted`. */
export const toRedacted = (value: string | Redacted.Redacted<string>): Redacted.Redacted<string> =>
  typeof value === "string" ? Redacted.make(value) : value;

/** The `projectId` and `regionId` every operation takes. */
export const requestScope = (scope: ProjectScope) => ({
  projectId: scope.projectId,
  regionId: scope.region,
});

/**
 * The generated display name of a generation: the shared shape, with spaces for hyphens,
 * which the API rejects in a display name.
 */
export const generatedDisplayName = (id: string) =>
  createPhysicalName({ id, maxLength: MAX_DISPLAY_NAME_LENGTH, lowercase: true }).pipe(
    Effect.map((name) => name.replaceAll("-", " ")),
  );

/**
 * Whether a display name has the shape of a generated one. A shape match, not proof of
 * ownership: see `internal/names.ts`.
 */
export const isGeneratedDisplayName = (name: string): boolean =>
  isGeneratedPhysicalName(name.replaceAll(" ", "-"), MAX_DISPLAY_NAME_LENGTH);

/** The generated login name of a generation. */
export const generatedUserName = (id: string) =>
  createPhysicalName({ id, maxLength: MAX_USER_NAME_LENGTH, lowercase: true });

/** Whether a user's name has the shape of a generated one. */
export const isGeneratedUserName = (name: string): boolean =>
  isGeneratedPhysicalName(name, MAX_USER_NAME_LENGTH);

export const getInstanceOrUndefined = (scope: ProjectScope, instanceId: string) =>
  dremio
    .getDremioInstance({ ...requestScope(scope), dremioId: instanceId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const listInstances = (scope: ProjectScope) =>
  collectTokenPages(
    "STACKIT Dremio instances",
    (pageToken) =>
      dremio.listDremioInstances({
        ...requestScope(scope),
        ...(pageToken === undefined ? {} : { pageToken }),
      }),
    (page) => page.dremios,
  );

export const findInstanceByName = (scope: ProjectScope, displayName: string) =>
  listInstances(scope).pipe(
    Effect.map((instances) => instances.find((instance) => instance.displayName === displayName)),
  );

/** The instances `alchemy unsafe nuke` may delete: those with a generated name. */
export const listOwnedInstances = (scope: ProjectScope) =>
  listInstances(scope).pipe(
    Effect.map((instances) =>
      instances.filter((instance) => isGeneratedDisplayName(instance.displayName)),
    ),
  );

const instanceResource = (instanceId: string) => `STACKIT Dremio instance ${instanceId}`;

const instanceFailure = (instance: dremio.DremioResponseOutput) =>
  instance.errorMessage === undefined || instance.errorMessage === ""
    ? "state error"
    : instance.errorMessage;

/**
 * Wait for an instance to be `active`. `error` fails it with the API's `errorMessage`,
 * except for `error` left over from before a repairing update, which `staleError` holds
 * until the instance reports any other state.
 */
export const waitForInstance = (
  scope: ProjectScope,
  instanceId: string,
  options: { readonly staleError?: boolean } = {},
) => {
  let stale = options.staleError ?? false;
  return waitFor({
    resource: instanceResource(instanceId),
    read: dremio.getDremioInstance({ ...requestScope(scope), dremioId: instanceId }),
    ready: (instance) => instance.state === "active",
    failed: (instance) => {
      if (instance.state !== "error") stale = false;
      return instance.state === "error" && !stale ? instanceFailure(instance) : undefined;
    },
    state: (instance) => instance.state,
    timeout: INSTANCE_TIMEOUT,
    ...POLL,
  });
};

/** Wait for an instance's change in flight to finish, however it ends. */
export const settleInstance = (scope: ProjectScope, instanceId: string) =>
  waitFor({
    resource: instanceResource(instanceId),
    read: dremio.getDremioInstance({ ...requestScope(scope), dremioId: instanceId }),
    ready: (instance) => instance.state !== "reconciling",
    state: (instance) => instance.state,
    timeout: INSTANCE_TIMEOUT,
    ...POLL,
  });

/**
 * Wait for an instance to be gone. The Go SDK's handler fails on `error`, but an instance
 * that was in it before the delete can sit there until it's gone, so `staleError` leaves
 * that case to the budget.
 */
export const waitForInstanceGone = (
  scope: ProjectScope,
  instanceId: string,
  options: { readonly staleError?: boolean } = {},
) => {
  let stale = options.staleError ?? false;
  return waitUntilGone({
    resource: instanceResource(instanceId),
    read: getInstanceOrUndefined(scope, instanceId),
    state: (instance) => instance.state,
    failed: (instance) => {
      if (instance.state !== "error") stale = false;
      return instance.state === "error" && !stale ? instanceFailure(instance) : undefined;
    },
    timeout: INSTANCE_TIMEOUT,
    ...POLL,
  });
};

export const getUserOrUndefined = (scope: ProjectScope, instanceId: string, userId: string) =>
  dremio
    .getDremioUser({ ...requestScope(scope), dremioId: instanceId, dremioUserId: userId })
    .pipe(Effect.catchTag("NotFound", () => Effect.undefined));

export const listUsers = (scope: ProjectScope, instanceId: string) =>
  collectTokenPages(
    `the users of STACKIT Dremio instance ${instanceId}`,
    (pageToken) =>
      dremio.listDremioUsers({
        ...requestScope(scope),
        dremioId: instanceId,
        ...(pageToken === undefined ? {} : { pageToken }),
      }),
    (page) => page.dremioUsers,
  );

export const findUserByName = (scope: ProjectScope, instanceId: string, name: string) =>
  listUsers(scope, instanceId).pipe(
    Effect.map((users) => users.find((user) => user.name === name)),
  );

const userResource = (name: string) => `STACKIT Dremio user ${name}`;

const userFailure = (user: dremio.DremioUserResponse) =>
  user.errorMessage === undefined || user.errorMessage === "" ? "state error" : user.errorMessage;

/** Wait for a user to be `active`. `error` fails it with the API's `errorMessage`. */
export const waitForUser = (
  scope: ProjectScope,
  instanceId: string,
  userId: string,
  name: string,
) =>
  waitFor({
    resource: userResource(name),
    read: dremio.getDremioUser({
      ...requestScope(scope),
      dremioId: instanceId,
      dremioUserId: userId,
    }),
    ready: (user) => user.state === "active",
    failed: (user) => (user.state === "error" ? userFailure(user) : undefined),
    state: (user) => user.state,
    timeout: USER_TIMEOUT,
    ...POLL,
  });

/**
 * Wait for a user to be gone. A user that was in `error` before the delete can sit there
 * until it's gone, so `staleError` leaves that case to the budget.
 */
export const waitForUserGone = (
  scope: ProjectScope,
  instanceId: string,
  userId: string,
  name: string,
  options: { readonly staleError?: boolean } = {},
) => {
  let stale = options.staleError ?? false;
  return waitUntilGone({
    resource: userResource(name),
    read: getUserOrUndefined(scope, instanceId, userId),
    state: (user) => user.state,
    failed: (user) => {
      if (user.state !== "error") stale = false;
      return user.state === "error" && !stale ? userFailure(user) : undefined;
    },
    timeout: USER_TIMEOUT,
    ...POLL,
  });
};
