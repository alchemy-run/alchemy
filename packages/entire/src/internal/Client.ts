import * as Entire from "@distilled.cloud/entire";
import { Credentials } from "@distilled.cloud/entire/Credentials";
import type { EntireOpError } from "@distilled.cloud/entire/Protocol";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Schedule from "effect/Schedule";

type Requirements = Credentials | HttpClient.HttpClient;

/**
 * The provider-scoped Entire client. Captures the deployer's credentials and
 * HTTP client once, at provider build, and runs SDK calls against either
 * API:
 *
 * - `core` -- the Core control plane, on the credentials' `coreBaseUrl`.
 * - `cell(apiUrl)` -- a project's cell. Core reports each project's cell
 *   as `apiUrl` (and each repo placement's as `apiBaseUrl`); routing there
 *   instead of the default cell keeps a project homed in another region
 *   working.
 */
export const makeClient = Effect.gen(function* () {
  const credentials = yield* Credentials;
  const http = yield* HttpClient.HttpClient;
  const run =
    (resolve: Context.Service.Shape<typeof Credentials>) =>
    <A, E>(effect: Effect.Effect<A, E, Requirements>): Effect.Effect<A, E> =>
      Effect.provideContext(
        effect,
        Context.make(Credentials, resolve).pipe(Context.add(HttpClient.HttpClient, http)),
      );
  const core = run(credentials);
  const cell = (apiUrl: string | undefined) =>
    run(
      apiUrl
        ? Effect.map(credentials, (config) => ({ ...config, apiBaseUrl: apiUrl }))
        : credentials,
    );
  /**
   * The address cell routes take for a project (`{host}/{project}`) and a
   * runner for its cell. Projects Alchemy creates are Entire-native, so
   * their host is `et`.
   */
  const project = Effect.fn(function* (projectId: string) {
    const p = yield* core(Entire.projects.getProject({ projectId }));
    return { host: "et", project: p.name, cell: cell(p.apiUrl || undefined) };
  });
  return { core, cell, project };
});

export type EntireClient = Effect.Success<typeof makeClient>;

/** A delete Entire acknowledged is still visible after the consistency budget. */
export class EntireDeletePending extends Data.TaggedError("EntireDeletePending")<{
  readonly message: string;
}> {}

/**
 * Bounded poll for eventual consistency: Core acknowledges deletes before
 * reads stop returning the resource, and a new repo reaches its cell a few
 * seconds after Core creates it. About 40s in total.
 */
export const consistencySchedule = Schedule.spaced("2 seconds");
const CONSISTENCY_ATTEMPTS = 20;

/**
 * Poll `get` until it fails with `NotFound` (the resource is gone). A
 * delete still visible after the budget fails with
 * {@link EntireDeletePending} instead of hanging.
 */
export const waitUntilGone = (get: Effect.Effect<unknown, EntireOpError>, describe: string) =>
  get.pipe(
    Effect.flatMap(() =>
      Effect.fail(
        new EntireDeletePending({ message: `${describe} is still present after delete` }),
      ),
    ),
    Effect.catchTag("NotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "EntireDeletePending",
      schedule: consistencySchedule,
      times: CONSISTENCY_ATTEMPTS,
    }),
  );

/**
 * A new repo reaches its cell a few seconds after Core creates it; until
 * then the cell answers `RepoNotInRegion`. Retry it within the consistency
 * budget on cell calls that address a repo Core has already confirmed.
 */
export const retryCellNotFound = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "RepoNotInRegion",
      schedule: consistencySchedule,
      times: CONSISTENCY_ATTEMPTS,
    }),
  );

/**
 * A generated name in the charset Entire accepts for project, repository
 * and service-account names: lowercase letters, digits and `-` (the
 * default stage, `test_$USER`, would otherwise bring an `_`).
 */
export const slugName = (id: string, maxLength = 63) =>
  createPhysicalName({ id, maxLength, lowercase: true }).pipe(
    Effect.map((name) => name.replace(/[^a-z0-9-]/g, "-")),
  );

/** A resource Entire reported as existing is not yet visible to reads. */
export class EntireNotYetVisible extends Data.TaggedError("EntireNotYetVisible")<{
  readonly message: string;
}> {}

/**
 * Poll `find` until it sees a resource a create reported as already
 * existing. Used to recover a create that answered a typed name conflict
 * because an earlier attempt of the same create already succeeded (the SDK
 * retries a request whose response was lost): generated names carry the
 * resource's instance ID, so the same-named resource is this one.
 */
export const awaitVisible = <A>(
  find: Effect.Effect<A | undefined, EntireOpError>,
  describe: string,
) =>
  find.pipe(
    Effect.flatMap((found) =>
      found === undefined
        ? Effect.fail(
            new EntireNotYetVisible({ message: `${describe} exists but is not yet listed` }),
          )
        : Effect.succeed(found),
    ),
    Effect.retry({
      while: (e) => e._tag === "EntireNotYetVisible",
      schedule: consistencySchedule,
      times: CONSISTENCY_ATTEMPTS,
    }),
  );

/**
 * Access to a new org or project reaches the services that create its
 * children a few seconds after the parent is created; until then a child
 * create answers `Forbidden`. Retry it within the consistency budget.
 */
export const retryPropagation = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "Forbidden",
      schedule: consistencySchedule,
      times: 10,
    }),
  );
