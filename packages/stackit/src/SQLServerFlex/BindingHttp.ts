import * as sqlserver from "@distilled.cloud/stackit/sqlserverflex";
import * as Effect from "effect/Effect";
import * as StackitBindings from "../StackitBindings.ts";
import type { Instance } from "./Instance.ts";
import type { ReadInstanceClient } from "./ReadInstance.ts";
import type { ReadWriteInstanceClient } from "./ReadWriteInstance.ts";
import type { WriteInstanceClient } from "./WriteInstance.ts";

/**
 * Shared HTTP scaffolding for SQL Server Flex bindings.
 * NOT exported from index.ts.
 *
 * Roles bind on the project holding the instance: STACKIT has no role binding on a
 * single instance (see `StackitBindings`). The grants list exactly the permissions
 * an operation needs. The names are the `x-stackit-authorization` actions in the
 * service's API spec. No STACKIT source lists a predefined `sqlserver-flex` role's
 * permissions, so a custom role is the narrowest choice that can be checked.
 */
const READ_PERMISSIONS = [
  "sqlserver-flex.instance.get",
  "sqlserver-flex.database.list",
  "sqlserver-flex.database.get",
  "sqlserver-flex.user.list",
  "sqlserver-flex.user.get",
  "sqlserver-flex.backup.list",
  "sqlserver-flex.backup.get",
  "sqlserver-flex.restore.list",
];
const WRITE_PERMISSIONS = [
  "sqlserver-flex.user.reset",
  "sqlserver-flex.backup.trigger",
  "sqlserver-flex.restore.trigger",
];

export const SQLSERVER_READ_ACCESS: StackitBindings.Access = { permissions: READ_PERMISSIONS };
export const SQLSERVER_WRITE_ACCESS: StackitBindings.Access = { permissions: WRITE_PERMISSIONS };
export const SQLSERVER_READ_WRITE_ACCESS: StackitBindings.Access = {
  permissions: [...READ_PERMISSIONS, ...WRITE_PERMISSIONS],
};

/** Build a binding over one operation on an instance: `<Op>Http.ts` is one call to it. */
export const makeInstanceHttpBinding = <
  I extends { projectId: string; region: string; instanceId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.SQLServerFlex.GetInstance`. */
  tag: string;
  /** What the operation needs on the project holding the instance. */
  access: StackitBindings.Access;
  /** The distilled operation; the instance's project, region and id are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (instance: Instance) => ({
      projectId: instance.projectId,
      region: instance.region,
      instanceId: instance.instanceId,
    }),
    grants: (instance) => [StackitBindings.grantOn(instance, options.access)],
  });

/** A bound instance's identifiers, read when a call runs. */
export interface InstanceIdentifiers {
  readonly projectId: Effect.Effect<string>;
  readonly region: Effect.Effect<string>;
  readonly instanceId: Effect.Effect<string>;
}

type InstanceRequest<I> = Omit<I, "projectId" | "region" | "instanceId">;

/** Inject the instance's identifiers into every request of an operation. */
const onInstance =
  (instance: InstanceIdentifiers) =>
  <I extends { projectId: string; region: string; instanceId: string }, A, E>(
    run: (input: I) => Effect.Effect<A, E>,
  ) =>
    Effect.fnUntraced(function* (request?: InstanceRequest<I>) {
      const projectId = yield* instance.projectId;
      const region = yield* instance.region;
      const instanceId = yield* instance.instanceId;
      // The compiler can't prove `Omit<I, K>` plus the `K` fields is `I`.
      return yield* run({ ...request, projectId, region, instanceId } as unknown as I);
    });

/**
 * Build the read client for an instance. Its operations are resolved with the
 * host's credentials once, when the layer is built.
 */
export const makeReadInstanceClient = Effect.gen(function* () {
  const getInstance = yield* StackitBindings.withCredentials(sqlserver.getInstance);
  const listDatabases = yield* StackitBindings.withCredentials(sqlserver.listDatabases);
  const getDatabase = yield* StackitBindings.withCredentials(sqlserver.getDatabase);
  const listUsers = yield* StackitBindings.withCredentials(sqlserver.listUsers);
  const getUser = yield* StackitBindings.withCredentials(sqlserver.getUser);
  const listBackups = yield* StackitBindings.withCredentials(sqlserver.listBackups);
  const getBackup = yield* StackitBindings.withCredentials(sqlserver.getBackup);
  const listRestoreJobs = yield* StackitBindings.withCredentials(
    sqlserver.listCurrentRunningRestoreJobs,
  );
  return (instance: InstanceIdentifiers): ReadInstanceClient => {
    const on = onInstance(instance);
    return {
      getInstance: on(getInstance),
      listDatabases: on(listDatabases),
      getDatabase: on(getDatabase),
      listUsers: on(listUsers),
      getUser: on(getUser),
      listBackups: on(listBackups),
      getBackup: on(getBackup),
      listRestoreJobs: on(listRestoreJobs),
    };
  };
});

/**
 * Build the write client for an instance. Its operations are resolved with the
 * host's credentials once, when the layer is built.
 */
export const makeWriteInstanceClient = Effect.gen(function* () {
  const resetUser = yield* StackitBindings.withCredentials(sqlserver.resetUser);
  const triggerBackup = yield* StackitBindings.withCredentials(sqlserver.triggerBackup);
  const triggerRestore = yield* StackitBindings.withCredentials(sqlserver.triggerRestore);
  const restoreDatabaseFromBackup = yield* StackitBindings.withCredentials(
    sqlserver.restoreDatabaseFromBackup,
  );
  return (instance: InstanceIdentifiers): WriteInstanceClient => {
    const on = onInstance(instance);
    return {
      resetUser: on(resetUser),
      triggerBackup: on(triggerBackup),
      triggerRestore: on(triggerRestore),
      restoreDatabaseFromBackup: on(restoreDatabaseFromBackup),
    };
  };
});

/** Build the client with every read and write operation on an instance. */
export const makeReadWriteInstanceClient = Effect.gen(function* () {
  const makeRead = yield* makeReadInstanceClient;
  const makeWrite = yield* makeWriteInstanceClient;
  return (instance: InstanceIdentifiers): ReadWriteInstanceClient => ({
    ...makeRead(instance),
    ...makeWrite(instance),
  });
});

/**
 * Build a binding whose client groups several operations on an instance: one grant
 * for the access level, then the client for the bound instance.
 */
export const makeInstanceClientHttpBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.SQLServerFlex.ReadInstance`. */
  tag: string;
  /** What the client needs on the project holding the instance. */
  access: StackitBindings.Access;
  /** Build the client; resolved when the layer is built. */
  makeClient: Effect.Effect<(instance: InstanceIdentifiers) => Client>;
}) =>
  Effect.gen(function* () {
    const bind = yield* StackitBindings.Bind;
    const makeClient = yield* options.makeClient;
    return Effect.fn(function* (instance: Instance) {
      const projectId = yield* instance.projectId;
      const region = yield* instance.region;
      const instanceId = yield* instance.instanceId;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        yield* bind`${options.tag}(${instance})`({
          grants: [StackitBindings.grantOn(instance, options.access)],
        });
      }
      return makeClient({ projectId, region, instanceId });
    });
  });
