import * as mongodb from "@distilled.cloud/stackit/mongodb_flex";
import * as Effect from "effect/Effect";
import * as StackitBindings from "../StackitBindings.ts";
import type { Instance } from "./Instance.ts";
import type { ReadInstanceClient } from "./ReadInstance.ts";
import type { ReadWriteInstanceClient } from "./ReadWriteInstance.ts";
import type { WriteInstanceClient } from "./WriteInstance.ts";

/**
 * Shared HTTP scaffolding for MongoDB Flex bindings.
 * NOT exported from index.ts.
 *
 * Roles bind on the project holding the instance: STACKIT has no role binding on a
 * single instance (see `StackitBindings`). The grants list exactly the permissions an
 * operation needs. The names are the `x-stackit-authorization` actions in the service's
 * API spec. No STACKIT source lists a predefined `mongodb-flex` role's permissions, so a
 * custom role is the narrowest choice that can be checked.
 */
const READ_PERMISSIONS = [
  "mongodb-flex.instance.get",
  "mongodb-flex.user.list",
  "mongodb-flex.user.get",
  "mongodb-flex.backup.list",
  "mongodb-flex.backup.get",
  "mongodb-flex.backup.restore-list",
  "mongodb-flex.metric.get",
  "mongodb-flex.advisor.list",
];
const WRITE_PERMISSIONS = [
  "mongodb-flex.user.reset",
  "mongodb-flex.backup.clone",
  "mongodb-flex.backup.restore-snapshot",
];

export const MONGODB_READ_ACCESS: StackitBindings.Access = { permissions: READ_PERMISSIONS };
export const MONGODB_WRITE_ACCESS: StackitBindings.Access = { permissions: WRITE_PERMISSIONS };
export const MONGODB_READ_WRITE_ACCESS: StackitBindings.Access = {
  permissions: [...READ_PERMISSIONS, ...WRITE_PERMISSIONS],
};

/** Build a binding over one operation on an instance: `<Op>Http.ts` is one call to it. */
export const makeInstanceHttpBinding = <
  I extends { projectId: string; region: string; instanceId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.MongoDBFlex.GetInstance`. */
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
 * Build the read client for an instance. Its operations are resolved with the host's
 * credentials once, when the layer is built.
 */
export const makeReadInstanceClient = Effect.gen(function* () {
  const getInstance = yield* StackitBindings.withCredentials(mongodb.getInstance);
  const listUsers = yield* StackitBindings.withCredentials(mongodb.listUsers);
  const getUser = yield* StackitBindings.withCredentials(mongodb.getUser);
  const listBackups = yield* StackitBindings.withCredentials(mongodb.listBackups);
  const getBackup = yield* StackitBindings.withCredentials(mongodb.getBackup);
  const listRestoreJobs = yield* StackitBindings.withCredentials(mongodb.listRestoreJobs);
  const listMetrics = yield* StackitBindings.withCredentials(mongodb.listMetrics);
  const listAdvisorSlowQueries = yield* StackitBindings.withCredentials(
    mongodb.listAdvisorSlowQueries,
  );
  const listSuggestedIndexes = yield* StackitBindings.withCredentials(mongodb.listSuggestedIndexes);
  return (instance: InstanceIdentifiers): ReadInstanceClient => {
    const on = onInstance(instance);
    return {
      getInstance: on(getInstance),
      listUsers: on(listUsers),
      getUser: on(getUser),
      listBackups: on(listBackups),
      getBackup: on(getBackup),
      listRestoreJobs: on(listRestoreJobs),
      listMetrics: on(listMetrics),
      listAdvisorSlowQueries: on(listAdvisorSlowQueries),
      listSuggestedIndexes: on(listSuggestedIndexes),
    };
  };
});

/**
 * Build the write client for an instance. Its operations are resolved with the host's
 * credentials once, when the layer is built.
 */
export const makeWriteInstanceClient = Effect.gen(function* () {
  const resetUser = yield* StackitBindings.withCredentials(mongodb.resetUser);
  const cloneInstance = yield* StackitBindings.withCredentials(mongodb.cloneInstance);
  const restoreInstance = yield* StackitBindings.withCredentials(mongodb.restoreInstance);
  return (instance: InstanceIdentifiers): WriteInstanceClient => {
    const on = onInstance(instance);
    return {
      resetUser: on(resetUser),
      cloneInstance: on(cloneInstance),
      restoreInstance: on(restoreInstance),
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
 * Build a binding whose client groups several operations on an instance: one grant for
 * the access level, then the client for the bound instance.
 */
export const makeInstanceClientHttpBinding = <Client>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.MongoDBFlex.ReadInstance`. */
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
