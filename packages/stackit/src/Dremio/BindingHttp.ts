import { ConfigError } from "@distilled.cloud/core/errors";
import {
  type DremioLogin,
  makeDremioLogin,
  withDremioLogin,
} from "@distilled.cloud/stackit/Dremio";
import type * as rest from "@distilled.cloud/stackit/dremio_rest";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Redacted from "effect/Redacted";
import * as StackitBindings from "../StackitBindings.ts";
import type { Instance } from "./Instance.ts";
import type { User } from "./User.ts";

/**
 * Shared HTTP scaffolding for STACKIT Dremio bindings.
 * NOT exported from index.ts.
 *
 * Two APIs, two kinds of access:
 *
 * - The management API takes a STACKIT identity, through `StackitBindings`. Roles bind on the
 *   project holding the instance: STACKIT has no role binding on a single instance. The grants
 *   list exactly the permission an operation needs, as the spec's `x-stackit-authorization`
 *   names it.
 * - Dremio's own REST API takes a token from Dremio's login, which grants no STACKIT role and
 *   creates no service account. The user's attributes travel through the host's environment,
 *   with the password kept `Redacted`.
 */

/** Build a binding over one operation on an instance: `<Op>Http.ts` is one call to it. */
export const makeInstanceHttpBinding = <
  I extends { projectId: string; regionId: string; dremioId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.Dremio.GetInstance`. */
  tag: string;
  /** The permission the operation needs on the project holding the instance. */
  permission: string;
  /** The distilled operation; the instance's project, region and id are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (instance: Instance) => ({
      projectId: instance.projectId,
      regionId: instance.region,
      dremioId: instance.instanceId,
    }),
    grants: (instance) => [
      StackitBindings.grantOn(instance, { permissions: [options.permission] }),
    ],
  });

/** Build a binding over one operation on a user: `<Op>Http.ts` is one call to it. */
export const makeUserHttpBinding = <
  I extends { projectId: string; regionId: string; dremioId: string; dremioUserId: string },
  A,
  E,
>(options: {
  /** Fully-qualified binding tag, e.g. `Stackit.Dremio.GetUser`. */
  tag: string;
  /** The permission the operation needs on the project holding the instance. */
  permission: string;
  /** The distilled operation; the user's project, region, instance and id are injected. */
  operation: StackitBindings.StackitHttpOp<I, A, E>;
}) =>
  StackitBindings.makeHttpBinding({
    tag: options.tag,
    operation: options.operation,
    identify: (user: User) => ({
      projectId: user.projectId,
      regionId: user.region,
      dremioId: user.instanceId,
      dremioUserId: user.userId,
    }),
    grants: (user) => [StackitBindings.grantOn(user, { permissions: [options.permission] })],
  });

/**
 * Where a host reads a user's login, once its bundle runs. A value can reach the host
 * unwrapped, whatever its type says.
 */
export interface DremioAccess {
  readonly uiUrl: Effect.Effect<string>;
  readonly username: Effect.Effect<string>;
  readonly password: Effect.Effect<string | Redacted.Redacted<string> | undefined>;
}

/** Resolve a user's login once, when the binding is built. */
export const accessOf = Effect.fn(function* (user: User) {
  const uiUrl = yield* user.uiUrl;
  const username = yield* user.userName;
  const password = yield* user.password;
  return { uiUrl, username, password } satisfies DremioAccess;
});

/**
 * The login for one user. It is built on the first call, because the attributes are only
 * readable once the host runs, and it holds nothing but a token: no connection outlives a
 * request on a host like workerd, and `refresh-gate.ts` lets requests share the login.
 */
export const makeLoginOf = (access: DremioAccess): Effect.Effect<DremioLogin, ConfigError> => {
  let login: DremioLogin | undefined;
  return Effect.gen(function* () {
    if (login !== undefined) return login;
    const uiUrl = yield* access.uiUrl;
    const username = yield* access.username;
    const password = yield* access.password;
    if (password === undefined) {
      return yield* Effect.fail(
        new ConfigError({
          message: `Dremio user ${username} has no known password: redeploy it with its password prop.`,
        }),
      );
    }
    login ??= makeDremioLogin({
      uiUrl,
      username,
      password: Redacted.isRedacted(password) ? password : Redacted.make(password),
    });
    return login;
  });
};

/** Calls `dremio_rest` operations as a bound user. */
export interface DremioCaller {
  <I, A, E extends { readonly _tag: string }>(
    operation: (input: I) => Effect.Effect<A, E, rest.DremioOpContext>,
    request: I,
  ): Effect.Effect<A, E | ConfigError>;
}

/** The caller for one user. Each request acquires its own HTTP client. */
export const makeDremioCaller = (access: DremioAccess): DremioCaller => {
  const loginOf = makeLoginOf(access);
  return (operation, request) =>
    Effect.flatMap(loginOf, (login) =>
      operation(request).pipe(withDremioLogin(login), Effect.provide(FetchHttpClient.layer)),
    );
};

/** Build a binding over a client of the REST API: `<Op>Http.ts` is one call to it. */
export const makeRestBinding = <Client>(makeClient: (call: DremioCaller) => Client) =>
  Effect.fn(function* (user: User) {
    const access = yield* accessOf(user);
    return makeClient(makeDremioCaller(access));
  });
