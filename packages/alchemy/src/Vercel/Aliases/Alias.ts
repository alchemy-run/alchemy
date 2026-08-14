import * as aliases from "@distilled.cloud/vercel/aliases";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";
import type { Providers } from "../Providers.ts";

/**
 * The deployment an alias points at — a resource carrying a `deploymentId`
 * (e.g. a `Vercel.Function`'s attributes) or a plain deployment id/URL.
 */
export type AliasDeploymentSource = { deploymentId: string } | string;

export interface AliasProps {
  /**
   * The alias hostname to assign, e.g. `my-app-staging.vercel.app` or a
   * custom domain already attached to the deployment's project. A bare
   * name without a dot is normalized to `{name}.vercel.app`. Changing the
   * alias name replaces the resource.
   */
  alias: string;
  /**
   * The deployment the alias points at. Accepts a `Vercel.Function` (or
   * anything carrying a `deploymentId`) or a plain deployment id. Changing
   * the deployment re-points the alias in place (Vercel's assign endpoint
   * is an upsert: an alias already assigned elsewhere is atomically moved
   * to the new deployment).
   */
  deployment: AliasDeploymentSource;
}

export type Alias = Resource<
  "Vercel.Alias",
  AliasProps,
  {
    /** The unique identifier of the alias record. */
    uid: string;
    /** The normalized alias hostname, e.g. `my-app-staging.vercel.app`. */
    alias: string;
    /** `https://{alias}` — the URL the alias serves on. */
    url: string;
    /** The deployment the alias currently points at. */
    deploymentId: string | undefined;
    /** The project owning the aliased deployment. */
    projectId: string | undefined;
  },
  never,
  Providers
>;

type AliasAttributes = Alias["Attributes"];

/**
 * A stable hostname pointed at a specific Vercel deployment.
 *
 * Deployments are immutable and retained (alchemy never prunes them by
 * default), so an `Alias` is the primitive for pinned version URLs and
 * instant traffic re-points: re-pointing the alias at another retained
 * deployment is a pure traffic operation — no rebuild. For re-pointing the
 * *production* alias itself, use the {@link promoteToProduction} /
 * {@link rollbackProduction} runtime actions instead of managing the
 * production alias as a resource.
 *
 * Note (live-verified): on team accounts with default deployment
 * protection, a `.vercel.app` alias is SSO-gated like any deployment URL —
 * only the auto-assigned production domain and custom domains are public.
 * Drive gated aliases with an automation bypass secret
 * (`x-vercel-protection-bypass`), minted *before* the aliased deployment
 * was created.
 *
 * Note (live-verified): {@link rollbackProduction} /
 * {@link promoteToProduction} SWEEP custom aliases — every alias riding the
 * outgoing production deployment is re-pointed to the rollback/promote
 * target along with the production domains. An `Alias` pinned to the
 * *active production* deployment therefore tracks production through those
 * actions; pin a non-production (e.g. superseded) deployment when you need
 * a version URL that stays put.
 *
 * @resource
 * @section Aliasing a deployment
 * @example Pin a stable URL to the current deployment
 * ```typescript
 * const api = yield* Vercel.Function("Api", { main: "./src/api.ts" });
 * const stable = yield* Vercel.Alias("Stable", {
 *   alias: "my-app-staging.vercel.app",
 *   deployment: api,
 * });
 * // stable.url -> https://my-app-staging.vercel.app
 * ```
 *
 * @example Alias a custom domain to a specific deployment
 * ```typescript
 * yield* Vercel.Alias("Canary", {
 *   alias: "canary.acme.com", // domain already on the project
 *   deployment: "dpl_123abc",
 * });
 * ```
 *
 * @see https://vercel.com/docs/deployments/promoting-a-deployment
 */
export const Alias = Resource<Alias>("Vercel.Alias");

/**
 * Normalize an alias name: strip a protocol prefix and trailing slash,
 * lowercase, and append `.vercel.app` when the name carries no dot.
 */
export const normalizeAlias = (name: string): string => {
  const bare = name
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  return bare.includes(".") ? bare : `${bare}.vercel.app`;
};

const resolveDeploymentId = (
  source: AliasDeploymentSource | undefined,
): string | undefined => {
  if (source === undefined) return undefined;
  if (typeof source === "string") return source;
  if ("deploymentId" in source && typeof source.deploymentId === "string") {
    return source.deploymentId;
  }
  return undefined;
};

const toAttributes = (observed: aliases.GetAliasResponse): AliasAttributes => ({
  uid: observed.uid,
  alias: observed.alias,
  url: `https://${observed.alias}`,
  deploymentId: observed.deploymentId ?? undefined,
  projectId: observed.projectId ?? undefined,
});

const observeAlias = (aliasName: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    return yield* aliases
      .getAlias({ idOrAlias: aliasName, teamId })
      .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
  });

export const AliasProvider = () =>
  Provider.succeed(Alias, {
    stables: ["alias", "url"],
    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      if (normalizeAlias(news.alias) !== output.alias) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const aliasName =
        output?.alias ??
        (olds?.alias !== undefined ? normalizeAlias(olds.alias) : undefined);
      if (aliasName === undefined) return undefined;
      const observed = yield* observeAlias(aliasName);
      if (observed === undefined) return undefined;
      return toAttributes(observed);
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { teamId } = yield* VercelEnvironment.current;
      const aliasName = output?.alias ?? normalizeAlias(news.alias);
      const deploymentId = resolveDeploymentId(news.deployment);
      if (deploymentId === undefined) {
        return yield* Effect.die(
          `Vercel.Alias(${id}): invalid deployment source — must be a Function, { deploymentId } or a plain deployment id`,
        );
      }
      if (deploymentId === "") {
        // The upstream is a precreate STUB (a Function's `deploymentId` is
        // `""` until its first deploy resolves — engine phase 1 may hand
        // consumers of cycle members the stub output). Return an inert row
        // instead of calling the API with an empty id; phase-3 convergence
        // re-runs reconcile with the final deployment id (the props delta
        // `"" -> dpl_…` marks this node changed).
        return {
          uid: "",
          alias: aliasName,
          url: `https://${aliasName}`,
          deploymentId: undefined,
          projectId: undefined,
        } satisfies AliasAttributes;
      }

      // Observe — the alias may already exist (crash recovery, re-point).
      let observed = yield* observeAlias(aliasName);

      if (observed === undefined || observed.deploymentId !== deploymentId) {
        // Ensure/sync — assignAlias is an upsert (live-verified): it
        // creates the alias or atomically re-points an existing one at the
        // new deployment.
        yield* aliases.assignAlias({
          id: deploymentId,
          alias: aliasName,
          teamId,
        });
        // Bounded wait for read-your-write consistency on the alias record.
        observed = yield* observeAlias(aliasName).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("1 second"),
            until: (a) => a !== undefined && a.deploymentId === deploymentId,
            times: 5,
          }),
        );
        if (observed === undefined) {
          return yield* Effect.die(
            `Vercel.Alias(${id}): alias ${aliasName} not observable after assign to deployment ${deploymentId}`,
          );
        }
      }

      return toAttributes(observed);
    }),
    delete: Effect.fn(function* ({ output }) {
      const { teamId } = yield* VercelEnvironment.current;
      // deleteAlias accepts the alias id or hostname; the uid is stable
      // across re-points, the hostname is the fallback for legacy rows and
      // for inert stub rows (uid `""`, never assigned — NotFound is caught).
      yield* aliases
        .deleteAlias({ aliasId: output.uid || output.alias, teamId })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
