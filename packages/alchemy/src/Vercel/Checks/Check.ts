import * as checks from "@distilled.cloud/vercel/checks_v2";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";

/** What a check's runs need before they can start. */
export type CheckRequires = "build-ready" | "deployment-url" | "none";

/** The deployment lifecycle stage a failing check blocks. */
export type CheckBlocks =
  | "build-start"
  | "deployment-start"
  | "deployment-alias"
  | "deployment-promotion"
  | "none";

export interface CheckProps {
  /**
   * The project the check is registered on: a project id (`prj_…`) or
   * project name. Changing the project replaces the check.
   */
  project: string;
  /**
   * Display name of the check. If omitted, a unique name is generated from
   * `${app}-${stage}-${id}`. Renaming an existing check updates it in
   * place.
   */
  name?: string;
  /**
   * What the check's runs need before they can start: the build artifacts
   * (`build-ready`), a live deployment URL (`deployment-url`), or nothing.
   *
   * @default "deployment-url"
   */
  requires?: CheckRequires;
  /**
   * The deployment lifecycle stage a failing run blocks. NOTE: the live
   * API currently accepts only `deployment-alias` and `none` (verified
   * 2026-08-13: other documented values are rejected with "Only
   * deployment-alias and none are currently supported for blocks").
   *
   * @default "none"
   */
  blocks?: CheckBlocks;
  /**
   * Deployment targets the check runs on (e.g. `["production"]`).
   * Left to the platform default when omitted.
   */
  targets?: string[];
  /**
   * Whether a failed run can be re-requested from the dashboard.
   * @default false
   */
  isRerequestable?: boolean;
  /**
   * Seconds until a running check run is considered timed out. Left to the
   * platform default when omitted.
   */
  timeout?: number;
}

export type Check = Resource<
  "Vercel.Check",
  CheckProps,
  {
    /** The check id (`chk_…`). */
    checkId: string;
    /** The id of the project the check is registered on. */
    projectId: string;
    /** Display name of the check. */
    name: string;
    /** What the check's runs need before they can start. */
    requires: string;
    /** The deployment lifecycle stage a failing run blocks. */
    blocks: string;
    /** Deployment targets the check runs on (sorted). */
    targets: string[];
    /** Where the check's runs originate (`webhook` for API-registered checks). */
    sourceKind: string;
    /** Whether a failed run can be re-requested. */
    isRerequestable: boolean;
    /** Run timeout in seconds. */
    timeout: number;
    /** Creation time in epoch milliseconds. */
    createdAt: number;
    /** Last update time in epoch milliseconds. */
    updatedAt: number;
  },
  never,
  Providers
>;

type CheckAttributes = Check["Attributes"];

/**
 * A Vercel Check (checks v2) — an external quality gate registered on a
 * project. Every deployment creates a run per check; an external system
 * reports the run's conclusion, and a failing run can block aliasing or
 * promotion.
 *
 * API-registered checks are webhook-sourced: pair the check with a
 * `Vercel.Webhook` subscribed to `deployment.check.rerequested` (and drive
 * run conclusions via the deployment check-run endpoints) to close the loop.
 *
 * @resource
 * @section Registering a check
 * @example A non-blocking check
 * ```typescript
 * const project = yield* Vercel.Project("Api", {});
 * const check = yield* Vercel.Check("Smoke", {
 *   project: project.projectId,
 * });
 * ```
 *
 * @example A check that gates promotion to production
 * ```typescript
 * yield* Vercel.Check("E2E", {
 *   project: project.projectId,
 *   name: "e2e-suite",
 *   requires: "deployment-url",
 *   blocks: "deployment-promotion",
 *   targets: ["production"],
 *   isRerequestable: true,
 *   timeout: 600,
 * });
 * ```
 *
 * @see https://vercel.com/docs/checks
 */
export const Check = Resource<Check>("Vercel.Check");

const createCheckName = (id: string) => createPhysicalName({ id });

const teamScope = Effect.gen(function* () {
  const { teamId } = yield* VercelEnvironment.current;
  return teamId === undefined ? {} : { teamId };
});

const toAttributes = (check: {
  id: string;
  projectId: string;
  name: string;
  requires: string;
  blocks: string;
  targets: ReadonlyArray<string>;
  sourceKind: string;
  isRerequestable: boolean;
  timeout: number;
  createdAt: number;
  updatedAt: number;
}): CheckAttributes => ({
  checkId: check.id,
  projectId: check.projectId,
  name: check.name,
  requires: check.requires,
  blocks: check.blocks,
  targets: [...check.targets].sort(),
  sourceKind: check.sourceKind,
  isRerequestable: check.isRerequestable,
  timeout: check.timeout,
  createdAt: check.createdAt,
  updatedAt: check.updatedAt,
});

/**
 * Observe the check. The persisted id is a cache; with no id (state-loss
 * recovery) an unambiguous name match among the project's webhook-sourced
 * checks recovers it (platform-native checks — Lint etc. — are excluded by
 * sourceKind).
 */
const findCheck = (
  project: string,
  scope: { teamId?: string },
  checkId: string | undefined,
  name: string,
) =>
  Effect.gen(function* () {
    if (checkId !== undefined) {
      // A definite id that 404s (typed NotFound — patched) means the check
      // is gone; do NOT fall through to name recovery, which would risk
      // adopting an unrelated same-named check.
      return yield* checks
        .getProjectCheck({ projectIdOrName: project, checkId, ...scope })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
    }
    const { checks: all } = yield* checks.listProjectChecks({
      projectIdOrName: project,
      ...scope,
    });
    const matches = all.filter(
      (c) => c.name === name && c.sourceKind === "webhook",
    );
    return matches.length === 1 ? matches[0] : undefined;
  });

export const CheckProvider = () =>
  Provider.succeed(Check, {
    stables: ["checkId", "projectId", "sourceKind", "createdAt"],
    diff: Effect.fn(function* ({ olds, news }) {
      if (!isResolved(news)) return undefined;
      if (olds?.project !== undefined && news.project !== olds.project) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const scope = yield* teamScope;
      const project = output?.projectId ?? olds?.project;
      if (project === undefined) return undefined;
      const name = output?.name ?? olds?.name ?? (yield* createCheckName(id));
      const observed = yield* findCheck(project, scope, output?.checkId, name);
      return observed === undefined ? undefined : toAttributes(observed);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const scope = yield* teamScope;
      const name = news.name ?? output?.name ?? (yield* createCheckName(id));

      // Observe — cloud state is authoritative; `output` only caches the
      // stable id.
      const observed = yield* findCheck(
        news.project,
        scope,
        output?.checkId,
        name,
      );

      // Ensure — missing → create (API-registered checks are
      // webhook-sourced by default).
      if (observed === undefined) {
        const created = yield* checks.createProjectCheck({
          projectIdOrName: news.project,
          name,
          requires: news.requires ?? "deployment-url",
          blocks: news.blocks ?? "none",
          ...(news.targets !== undefined ? { targets: news.targets } : {}),
          ...(news.isRerequestable !== undefined
            ? { isRerequestable: news.isRerequestable }
            : {}),
          ...(news.timeout !== undefined ? { timeout: news.timeout } : {}),
          ...scope,
        });
        return toAttributes(created);
      }

      // Sync — diff OBSERVED fields against the desired ones and PATCH
      // only the delta.
      const patch: {
        name?: string;
        requires?: CheckRequires;
        blocks?: CheckBlocks;
        targets?: string[];
        isRerequestable?: boolean;
        timeout?: number;
      } = {};
      if (observed.name !== name) patch.name = name;
      const desiredRequires = news.requires ?? "deployment-url";
      if (observed.requires !== desiredRequires) {
        patch.requires = desiredRequires;
      }
      const desiredBlocks = news.blocks ?? "none";
      if (observed.blocks !== desiredBlocks) patch.blocks = desiredBlocks;
      if (
        news.targets !== undefined &&
        [...observed.targets].sort().join(",") !==
          [...news.targets].sort().join(",")
      ) {
        patch.targets = news.targets;
      }
      if (
        news.isRerequestable !== undefined &&
        observed.isRerequestable !== news.isRerequestable
      ) {
        patch.isRerequestable = news.isRerequestable;
      }
      if (news.timeout !== undefined && observed.timeout !== news.timeout) {
        patch.timeout = news.timeout;
      }

      if (Object.keys(patch).length === 0) {
        return toAttributes(observed);
      }
      const updated = yield* checks.updateProjectCheck({
        projectIdOrName: news.project,
        checkId: observed.id,
        ...patch,
        ...scope,
      });
      return toAttributes(updated);
    }),
    delete: Effect.fn(function* ({ output }) {
      const scope = yield* teamScope;
      // Already gone (out-of-band delete, or a deleted host project) is
      // success, not an error.
      yield* checks
        .deleteProjectCheck({
          projectIdOrName: output.projectId,
          checkId: output.checkId,
          ...scope,
        })
        .pipe(
          Effect.asVoid,
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }),
  });
