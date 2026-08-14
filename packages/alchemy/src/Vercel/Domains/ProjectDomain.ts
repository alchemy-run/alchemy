import * as projects from "@distilled.cloud/vercel/projects";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { VercelEnvironment } from "../VercelEnvironment.ts";
import type { Providers } from "../Providers.ts";

/** The Vercel project to attach the domain to — a resource carrying a
 * `projectId` (e.g. `Vercel.Project`) or a plain project id/name. */
export type ProjectDomainProjectSource = { projectId: string } | string;

export type ProjectDomainRedirectStatusCode = 301 | 302 | 307 | 308;

/** A single verification challenge for a pending project domain. */
export interface ProjectDomainVerification {
  type: string;
  domain: string;
  value: string;
  reason: string;
}

export interface ProjectDomainProps {
  /**
   * The project to attach the domain to. Accepts a `Vercel.Project`
   * resource (or anything carrying a `projectId`) or a plain project
   * id/name. Changing the project replaces the attachment.
   */
  project: ProjectDomainProjectSource;
  /**
   * The domain name to attach, e.g. `app.acme.com`. Changing the name
   * replaces the attachment.
   *
   * Attaching a domain whose apex is not yet on the team automatically adds
   * the apex domain to the team's domain list.
   */
  name: string;
  /**
   * Git branch to link the project domain to (deploys of this branch get
   * the domain). `undefined` links to the production branch.
   */
  gitBranch?: string;
  /**
   * Target destination domain when this domain should redirect.
   */
  redirect?: string;
  /**
   * Status code for the domain redirect.
   */
  redirectStatusCode?: ProjectDomainRedirectStatusCode;
}

export type ProjectDomain = Resource<
  "Vercel.ProjectDomain",
  ProjectDomainProps,
  {
    /** The id of the project the domain is attached to. */
    projectId: string;
    /** The attached domain name. */
    name: string;
    /** The apex domain of the attached name. */
    apexName: string;
    /**
     * `true` once the domain is verified for use with the project. While
     * `false` the domain serves nothing and `verification` carries the
     * outstanding challenge(s).
     */
    verified: boolean;
    /** Linked git branch, when set. */
    gitBranch: string | undefined;
    /** Redirect target, when set. */
    redirect: string | undefined;
    /** Redirect status code, when set. */
    redirectStatusCode: number | undefined;
    /** Outstanding verification challenges while `verified` is false. */
    verification: ProjectDomainVerification[] | undefined;
  },
  never,
  Providers
>;

type ProjectDomainAttributes = ProjectDomain["Attributes"];

/**
 * Attaches a domain name to a Vercel project so deployments serve on it.
 *
 * If the domain's apex is owned by (or gets auto-added to) the same team,
 * the attachment verifies immediately. A domain owned by another Vercel
 * team stays `verified: false` with a TXT `verification` challenge until
 * the challenge record is created — the resource converges to the pending
 * state and reports the challenge in its attributes rather than failing.
 *
 * @resource
 * @section Attaching a domain
 * @example Attach a subdomain to a project
 * ```typescript
 * const project = yield* Vercel.Project("Site");
 * const zone = yield* Vercel.Domain("Zone", { name: "acme.com" });
 * yield* Vercel.ProjectDomain("AppDomain", {
 *   project,
 *   name: "app.acme.com",
 * });
 * ```
 *
 * @section Redirects
 * @example Redirect the apex to www
 * ```typescript
 * yield* Vercel.ProjectDomain("ApexRedirect", {
 *   project,
 *   name: "acme.com",
 *   redirect: "www.acme.com",
 *   redirectStatusCode: 308,
 * });
 * ```
 *
 * @section Branch domains
 * @example Domain for a preview branch
 * ```typescript
 * yield* Vercel.ProjectDomain("StagingDomain", {
 *   project,
 *   name: "staging.acme.com",
 *   gitBranch: "staging",
 * });
 * ```
 *
 * @see https://vercel.com/docs/domains/add-a-domain
 */
export const ProjectDomain = Resource<ProjectDomain>("Vercel.ProjectDomain");

const resolveProjectId = (
  source: ProjectDomainProjectSource | undefined,
): string | undefined => {
  if (source === undefined) return undefined;
  if (typeof source === "string") return source;
  if ("projectId" in source && typeof source.projectId === "string") {
    return source.projectId;
  }
  return undefined;
};

interface ObservedProjectDomain {
  name: string;
  apexName: string;
  projectId: string;
  verified: boolean;
  gitBranch?: string | null;
  redirect?: string | null;
  redirectStatusCode?: number | null;
  verification?: ReadonlyArray<ProjectDomainVerification>;
}

const toAttributes = (
  observed: ObservedProjectDomain,
): ProjectDomainAttributes => ({
  projectId: observed.projectId,
  name: observed.name,
  apexName: observed.apexName,
  verified: observed.verified,
  gitBranch: observed.gitBranch ?? undefined,
  redirect: observed.redirect ?? undefined,
  redirectStatusCode: observed.redirectStatusCode ?? undefined,
  verification: observed.verification?.map((v) => ({
    type: v.type,
    domain: v.domain,
    value: v.value,
    reason: v.reason,
  })),
});

/**
 * Find the project domain by name via the list endpoint. `getProjectDomain`
 * 404s for a missing domain but distilled's typed union for it carries no
 * `NotFound` (the OpenAPI omits the 404 response), and the `projects`
 * service is owned by the core factory agent — the list endpoint reaches
 * the same row without an out-of-union error path.
 */
const observeProjectDomain = (idOrName: string, name: string) =>
  Effect.gen(function* () {
    const { teamId } = yield* VercelEnvironment.current;
    let until: number | undefined;
    do {
      const body = yield* projects.getProjectDomains({
        idOrName,
        teamId,
        limit: 100,
        until,
      });
      const match = body.domains.find((d) => d.name === name);
      if (match !== undefined) return match as ObservedProjectDomain;
      until = body.pagination.next ?? undefined;
    } while (until !== undefined);
    return undefined;
  });

export const ProjectDomainProvider = () =>
  Provider.succeed(ProjectDomain, {
    stables: ["projectId", "name", "apexName"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      const oldProjectId =
        output?.projectId ??
        resolveProjectId(olds.project as ProjectDomainProjectSource);
      const newProjectId =
        "project" in news
          ? resolveProjectId(news.project as ProjectDomainProjectSource)
          : undefined;
      if (oldProjectId !== undefined && oldProjectId !== newProjectId) {
        return { action: "replace" } as const;
      }
      if (!isResolved(news)) return undefined;
      if (!output) return undefined;
      if (news.name !== output.name) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ olds, output }) {
      const projectId =
        output?.projectId ??
        resolveProjectId(olds?.project as ProjectDomainProjectSource);
      const name = output?.name ?? olds?.name;
      if (projectId === undefined || name === undefined) return undefined;
      const observed = yield* observeProjectDomain(projectId, name).pipe(
        // The whole project may already be gone.
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
      );
      if (observed === undefined) return undefined;
      return toAttributes(observed);
    }),
    reconcile: Effect.fn(function* ({ news, output }) {
      const { teamId } = yield* VercelEnvironment.current;
      const projectId = output?.projectId ?? resolveProjectId(news.project);
      if (projectId === undefined) {
        return yield* Effect.die(
          "Invalid Vercel project source: must be a Project, { projectId } or a plain project id/name",
        );
      }

      // Observe — the attachment may already exist (crash recovery, race).
      let observed = yield* observeProjectDomain(projectId, news.name);

      if (observed === undefined) {
        // Ensure — attach. A concurrent attach races as Conflict
        // (`domain_already_in_use` on this project); re-observe.
        yield* projects
          .addProjectDomain({
            idOrName: projectId,
            teamId,
            name: news.name,
            ...(news.gitBranch !== undefined
              ? { gitBranch: news.gitBranch }
              : {}),
            ...(news.redirect !== undefined ? { redirect: news.redirect } : {}),
            ...(news.redirectStatusCode !== undefined
              ? { redirectStatusCode: news.redirectStatusCode }
              : {}),
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.void));
        observed = yield* observeProjectDomain(projectId, news.name);
        if (observed === undefined) {
          return yield* Effect.die(
            `Vercel project domain ${news.name} not observable after add on project ${projectId}`,
          );
        }
      }

      // Sync — diff observed configuration against desired; PATCH only on
      // delta.
      const delta =
        (observed.gitBranch ?? undefined) !== news.gitBranch ||
        (observed.redirect ?? undefined) !== news.redirect ||
        (observed.redirectStatusCode ?? undefined) !== news.redirectStatusCode;
      if (delta) {
        yield* projects.updateProjectDomain({
          idOrName: projectId,
          domain: news.name,
          teamId,
          gitBranch: news.gitBranch ?? null,
          redirect: news.redirect ?? null,
          redirectStatusCode: news.redirectStatusCode ?? null,
        });
      }

      // Verify — attempt the verification challenge when pending. A domain
      // whose challenge is not yet satisfied answers 400; converge to the
      // pending state instead of failing (the challenge is surfaced in the
      // attributes).
      if (!observed.verified) {
        yield* projects
          .verifyProjectDomain({
            idOrName: projectId,
            domain: news.name,
            teamId,
          })
          .pipe(Effect.catchTag("BadRequest", () => Effect.void));
      }

      // Return — re-read the final state.
      const fresh = yield* observeProjectDomain(projectId, news.name);
      return toAttributes(fresh ?? observed);
    }),
    delete: Effect.fn(function* ({ output }) {
      const { teamId } = yield* VercelEnvironment.current;
      // NOTE: detaching does NOT remove an auto-added apex domain from the
      // team's domain list — that is a separate `Vercel.Domain`.
      yield* projects
        .removeProjectDomain({
          idOrName: output.projectId,
          domain: output.name,
          teamId,
        })
        .pipe(
          // A domain that other project domains redirect to cannot be
          // removed until those redirects are gone (typed Conflict). When
          // the redirecting attachments are being deleted in the same
          // destroy the race resolves itself — retry boundedly.
          Effect.retry({
            while: (e) => e._tag === "Conflict",
            schedule: Schedule.exponential("1 second"),
            times: 6,
          }),
          Effect.catchTag("NotFound", () => Effect.void),
        );
    }),
  });
