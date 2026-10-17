import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import { OwnedBySomeoneElse, Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { authPlanScope, authRequest } from "./Auth.ts";
import { resolveBranchScope, type BranchScope, type ResolvedBranchScope } from "./BranchScope.ts";
import type { Providers } from "./Providers.ts";
import * as RealtimeApi from "./RealtimeApi.ts";

export type RealtimeProps = BranchScope & {
  /**
   * Browser origins allowed to open Realtime connections: each an `http` or
   * `https` scheme plus host and optional port, with no path (at most 16).
   * `["*"]` or `[]` allows any origin. Omit to leave the origins Neon
   * currently has (or inherited) unmanaged.
   */
  allowedOrigins?: string[];
};

export interface RealtimeAttributes extends ResolvedBranchScope {
  /** Invocation URL Realtime clients connect to — the value of `NEON_REALTIME_URL`. */
  url: string;
  /**
   * Shared secret the application backend seals queries and issues Realtime
   * tokens with — the value of `NEON_REALTIME_SECRET`. Neon discards it when
   * Realtime is disabled, so a re-enabled branch gets a new secret.
   */
  secret: Redacted.Redacted<string>;
  /** Observed allowed origins; empty (or `["*"]`) means any origin may connect. */
  allowedOrigins: string[];
  /** Neon's Realtime configuration revision, when reported. */
  revision: number | undefined;
}

export interface Realtime extends Resource<
  "Neon.Realtime",
  RealtimeProps,
  RealtimeAttributes,
  never,
  Providers
> {}

/**
 * Neon Realtime on a branch: live query subscriptions over WebSockets backed
 * by Postgres logical replication. Enabling it provisions an invocation URL
 * for clients and a shared secret the backend uses to seal queries — the
 * `NEON_REALTIME_URL` and `NEON_REALTIME_SECRET` values the Neon CLI writes
 * with `neon env pull --service realtime`. Realtime is a per-branch singleton;
 * destroying the resource disables it and discards the secret.
 *
 * Realtime is in beta and available in `aws-us-east-1`, `aws-us-east-2`,
 * `aws-eu-central-1` and `aws-ap-southeast-1`.
 *
 * ### Enabling Realtime
 * **Example:** On the project's default branch
 * ```typescript
 * const project = yield* Neon.Project("app-db", { region: "aws-eu-central-1" });
 * const realtime = yield* Neon.Realtime("Realtime", {
 *   project,
 *   allowedOrigins: ["https://app.example.com", "http://localhost:3000"],
 * });
 * ```
 *
 * **Example:** On a specific branch
 * ```typescript
 * const preview = yield* Neon.Branch("preview", { project });
 * const realtime = yield* Neon.Realtime("PreviewRealtime", { branch: preview });
 * ```
 *
 * ### Binding the outputs
 * `url` is public configuration; `secret` is `Redacted` and binds as a
 * secret.
 *
 * **Example:** Pass the outputs to a Cloudflare Worker
 * ```typescript
 * const api = yield* Cloudflare.Worker("api", {
 *   main: "src/api.ts",
 *   env: {
 *     NEON_REALTIME_URL: realtime.url,
 *     NEON_REALTIME_SECRET: realtime.secret,
 *   },
 * });
 * ```
 *
 * ### Adopting a branch enabled by the CLI
 * A branch that already has Realtime (from `neon realtime enable` or the
 * console) is foreign until adopted; adoption then manages its origins.
 *
 * **Example:** Adopt and manage existing Realtime
 * ```typescript
 * const realtime = yield* Neon.Realtime("Realtime", {
 *   project,
 *   allowedOrigins: ["https://app.example.com"],
 * }).pipe(adopt(true));
 * ```
 *
 * @see https://neon.com/docs/realtime/overview
 *
 * @resource
 * @product Realtime
 */
export const Realtime = Resource<Realtime>("Neon.Realtime");

export class RealtimeStateError extends Data.TaggedError("NeonRealtimeStateError")<{
  reason: string;
}> {}

/** A Realtime change (provisioning, settings, rotation or deprovisioning) is still being applied. */
export class RealtimePending extends Data.TaggedError("NeonRealtimePending")<{
  projectId: string;
  branchId: string;
}> {}

/** Current Realtime state of a branch; `undefined` when the branch (or project) is gone. */
const observe = (scope: ResolvedBranchScope) =>
  RealtimeApi.getProjectBranchRealtime(authRequest(scope)).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

/**
 * Observe the branch once Neon has finished applying any pending change.
 * Provisioning usually completes within seconds; the wait is bounded.
 */
const awaitSettled = (scope: ResolvedBranchScope) =>
  observe(scope).pipe(
    Effect.flatMap((state) =>
      state?.pending
        ? Effect.fail(new RealtimePending({ projectId: scope.projectId, branchId: scope.branchId }))
        : Effect.succeed(state),
    ),
    Effect.retry({
      while: (error) => error._tag === "NeonRealtimePending",
      schedule: Schedule.spaced("2 seconds"),
      times: 25,
    }),
  );

const redact = (secret: string | Redacted.Redacted<string>) =>
  Redacted.isRedacted(secret) ? secret : Redacted.make(secret);

/**
 * The shared secret. Neon answers 404 until the secret is provisioned and
 * keeps serving the previous one while a rotation is pending, so both are
 * retried briefly before giving up.
 */
const fetchSecret = (scope: ResolvedBranchScope) =>
  RealtimeApi.getProjectBranchRealtimeSecret(authRequest(scope)).pipe(
    Effect.flatMap(({ secret, pending }) =>
      pending
        ? Effect.fail(new RealtimePending({ projectId: scope.projectId, branchId: scope.branchId }))
        : Effect.succeed(redact(secret)),
    ),
    Effect.retry({
      while: (error) => error._tag === "NeonRealtimePending" || error._tag === "NotFound",
      schedule: Schedule.spaced("2 seconds"),
      times: 10,
    }),
    Effect.catchTag("NotFound", () =>
      Effect.fail(
        new RealtimeStateError({
          reason: `Neon has not provisioned the Realtime secret for branch ${scope.branchId}`,
        }),
      ),
    ),
  );

/** `[]` and `["*"]` both mean "any origin"; otherwise compare as a set, case- and slash-insensitively. */
const normalizeOrigins = (origins: ReadonlyArray<string> | undefined): string[] => {
  if (origins === undefined) return [];
  const set = new Set(origins.map((origin) => origin.trim().replace(/\/+$/, "").toLowerCase()));
  set.delete("*");
  return [...set].sort((a, b) => a.localeCompare(b));
};

const originsMatch = (
  observed: ReadonlyArray<string> | undefined,
  desired: ReadonlyArray<string> | undefined,
) => {
  if (desired === undefined) return true;
  const a = normalizeOrigins(observed);
  const b = normalizeOrigins(desired);
  return a.length === b.length && a.every((origin, index) => origin === b[index]);
};

const attributes = Effect.fn(function* (
  scope: ResolvedBranchScope,
  state: RealtimeApi.Realtime,
  secret: Redacted.Redacted<string>,
) {
  if (!state.enabled || !state.invocation_url) {
    return yield* new RealtimeStateError({
      reason: `Realtime is not provisioned on branch ${scope.branchId} of project ${scope.projectId}`,
    });
  }
  const attrs: RealtimeAttributes = {
    projectId: scope.projectId,
    branchId: scope.branchId,
    url: state.invocation_url,
    secret,
    allowedOrigins: [...(state.allowed_origins ?? [])],
    revision: state.revision,
  };
  return attrs;
});

export const RealtimeProvider = () =>
  Provider.succeed(Realtime, {
    stables: ["projectId", "branchId"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      const scope = yield* authPlanScope(news);
      // Another branch's Realtime is independent of this one, so the new
      // branch is enabled before the old branch is disabled.
      if (
        output &&
        (!scope || scope.projectId !== output.projectId || scope.branchId !== output.branchId)
      ) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return;
      const resolved = scope ?? (yield* resolveBranchScope(news));
      const previous = output ?? (yield* resolveBranchScope(olds));
      if (resolved.projectId !== previous.projectId || resolved.branchId !== previous.branchId) {
        return { action: "replace" } as const;
      }
      if (output) {
        const current = yield* observe(resolved);
        if (
          !current?.enabled ||
          current.pending ||
          !originsMatch(current.allowed_origins, news.allowedOrigins)
        ) {
          return { action: "update" } as const;
        }
      }
    }),
    read: Effect.fn(function* ({ olds, output }) {
      if (
        !output &&
        !(olds?.branch?.projectId && olds.branch.branchId) &&
        !olds?.project?.projectId
      )
        return undefined;
      // The project may be gone out-of-band; its branches' Realtime is gone with it.
      const scope =
        output ??
        (yield* resolveBranchScope(olds).pipe(
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        ));
      if (!scope) return undefined;
      const current = yield* awaitSettled(scope);
      if (!current?.enabled) return undefined;
      const attrs = yield* attributes(scope, current, yield* fetchSecret(scope));
      return output ? attrs : Unowned(attrs);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* resolveBranchScope(news);
      if (output && (scope.projectId !== output.projectId || scope.branchId !== output.branchId)) {
        return yield* new RealtimeStateError({
          reason: "Realtime branch changed without replacement; refusing to mutate either branch",
        });
      }
      let current = yield* awaitSettled(scope);
      if (current === undefined) {
        return yield* new RealtimeStateError({
          reason: `Branch ${scope.branchId} of project ${scope.projectId} does not exist`,
        });
      }
      // Realtime enabled by the CLI or console is not ours until adopted.
      if (current.enabled && !output) {
        return yield* new OwnedBySomeoneElse({
          message: `Realtime is already enabled on branch ${scope.branchId}; explicit adoption is required`,
          resourceType: "Neon.Realtime",
          logicalId: id,
          physicalName: `${scope.projectId}/${scope.branchId}`,
        });
      }
      if (!current.enabled || !originsMatch(current.allowed_origins, news.allowedOrigins)) {
        // The same call enables Realtime and applies new options to an
        // enabled branch; an omitted list keeps Neon's current origins.
        yield* RealtimeApi.enableProjectBranchRealtime({
          ...authRequest(scope),
          allowed_origins: news.allowedOrigins,
        });
        current = yield* awaitSettled(scope);
        if (!current?.enabled) {
          return yield* new RealtimeStateError({
            reason: `Neon did not report Realtime as enabled on branch ${scope.branchId} after provisioning`,
          });
        }
      }
      return yield* attributes(scope, current, yield* fetchSecret(scope));
    }),
    delete: Effect.fn(function* ({ output }) {
      const current = yield* awaitSettled(output);
      if (!current?.enabled) return;
      yield* RealtimeApi.disableProjectBranchRealtime(authRequest(output)).pipe(
        Effect.catchTag("NotFound", () => Effect.void),
      );
      // Deprovisioning is asynchronous and idempotent; a slow deprovision is
      // not a failed delete.
      yield* awaitSettled(output).pipe(
        Effect.catchTag("NeonRealtimePending", () => Effect.succeed(undefined)),
      );
    }),
  });
