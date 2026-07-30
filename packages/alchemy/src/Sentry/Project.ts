import * as Effect from "effect/Effect";
import { Unowned } from "../AdoptPolicy.ts";
import { isResolved } from "../Diff.ts";
import * as Provider from "../Provider.ts";
import { Resource } from "../Resource.ts";
import { request, SentryApiError } from "./Api.ts";
import type { Providers } from "./Providers.ts";

export type ProjectProps = {
  /** Organization slug that owns the project, e.g. `my-org`. */
  organization: string;
  /**
   * Team slug the project is created under. Changing it triggers a
   * replacement — Sentry has no in-place team transfer on this endpoint.
   */
  team: string;
  /** Display name shown in the Sentry UI. */
  name: string;
  /**
   * URL slug. Sentry derives one from `name` when omitted, and the derived
   * value is read back into the `slug` attribute.
   */
  slug?: string;
  /** Platform identifier, e.g. `javascript`, `node`, `python`. */
  platform?: string;
};

export type Project = Resource<
  "Sentry.Project",
  ProjectProps,
  {
    /** Numeric project id assigned by Sentry. */
    id: string;
    /** URL slug, either supplied or derived from `name`. */
    slug: string;
    /** Display name. */
    name: string;
    /** Organization slug that owns the project. */
    organization: string;
    /** Platform identifier, when set. */
    platform: string | undefined;
    /** ISO timestamp of creation. */
    dateCreated: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Sentry project — the container that receives events from one application
 * and owns its client keys (DSNs).
 *
 * Works against Sentry SaaS and self-hosted instances; point
 * `SENTRY_API_BASE_URL` at your own host to manage the latter.
 * @resource
 * @see https://docs.sentry.io/api/projects/
 *
 * @section Creating a Project
 * @example Basic project
 * ```typescript
 * const project = yield* Sentry.Project("api", {
 *   organization: "my-org",
 *   team: "backend",
 *   name: "API",
 *   platform: "node",
 * });
 * ```
 *
 * @example Explicit slug
 * ```typescript
 * const project = yield* Sentry.Project("api", {
 *   organization: "my-org",
 *   team: "backend",
 *   name: "API",
 *   slug: "api-prod",
 * });
 * ```
 */
export const Project = Resource<Project>("Sentry.Project");

type ProjectAttrs = Project["Attributes"];

const str = (value: unknown): string | undefined =>
  typeof value === "string"
    ? value
    : typeof value === "number"
      ? String(value)
      : undefined;

const parseProject = (
  payload: unknown,
  organization: string,
): ProjectAttrs | undefined => {
  if (payload === null || typeof payload !== "object") return undefined;
  const record: Record<string, unknown> = { ...payload };
  const id = str(record.id);
  const slug = str(record.slug);
  const name = str(record.name);
  if (id === undefined || slug === undefined || name === undefined) {
    return undefined;
  }
  return {
    id,
    slug,
    name,
    organization,
    platform: str(record.platform),
    dateCreated: str(record.dateCreated),
  };
};

const decode = (payload: unknown, organization: string, path: string) =>
  Effect.suspend(() => {
    const project = parseProject(payload, organization);
    return project === undefined
      ? Effect.fail(
          new SentryApiError({
            path,
            status: 200,
            message: "unexpected project payload",
          }),
        )
      : Effect.succeed(project);
  });

export const ProjectProvider = () =>
  Provider.effect(
    Project,
    Effect.gen(function* () {
      const get = (organization: string, slug: string) => {
        const path = `/projects/${organization}/${slug}/`;
        return request("GET", path).pipe(
          Effect.flatMap((payload) => decode(payload, organization, path)),
          Effect.catchTag("SentryNotFound", () => Effect.succeed(undefined)),
        );
      };

      return {
        stables: ["id", "organization"],
        diff: Effect.fn(function* ({ olds, news, output }) {
          if (!isResolved(news)) return undefined;
          if (output && news.organization !== output.organization) {
            return { action: "replace" } as const;
          }
          if (olds && news.team !== olds.team) {
            return { action: "replace" } as const;
          }
          if (
            news.name !== olds?.name ||
            news.slug !== olds?.slug ||
            news.platform !== olds?.platform
          ) {
            return { action: "update" } as const;
          }
          return undefined;
        }),
        reconcile: Effect.fn(function* ({ news, output }) {
          // Observe — the slug is Sentry's path identifier. Prefer the cached
          // one, then the requested one; a create derives it from `name`.
          const observedSlug = output?.slug ?? news.slug;
          const observed = observedSlug
            ? yield* get(news.organization, observedSlug)
            : undefined;

          // Ensure — create when missing. A Conflict means a peer reconciler
          // (or a slug collision) won the race, so fall through to the sync.
          if (observed === undefined) {
            const path = `/teams/${news.organization}/${news.team}/projects/`;
            const created = yield* request("POST", path, {
              name: news.name,
              slug: news.slug,
              platform: news.platform,
            }).pipe(
              Effect.flatMap((payload) =>
                decode(payload, news.organization, path),
              ),
              Effect.catchTag("SentryConflict", () =>
                news.slug
                  ? get(news.organization, news.slug)
                  : Effect.succeed(undefined),
              ),
            );
            if (created !== undefined) {
              return created;
            }
          }

          // Sync — apply the mutable aspects against observed state.
          const current =
            observed ?? (yield* get(news.organization, news.slug ?? news.name));
          if (current === undefined) {
            return yield* new SentryApiError({
              path: `/projects/${news.organization}/${news.slug ?? news.name}/`,
              status: 404,
              message: "project vanished during reconcile",
            });
          }
          const desiredSlug = news.slug ?? current.slug;
          if (
            current.name === news.name &&
            current.slug === desiredSlug &&
            current.platform === news.platform
          ) {
            return current;
          }
          const path = `/projects/${news.organization}/${current.slug}/`;
          const updated = yield* request("PUT", path, {
            name: news.name,
            slug: desiredSlug,
            platform: news.platform,
          }).pipe(
            Effect.flatMap((payload) =>
              decode(payload, news.organization, path),
            ),
          );
          return updated;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* request(
            "DELETE",
            `/projects/${output.organization}/${output.slug}/`,
          ).pipe(Effect.catchTag("SentryNotFound", () => Effect.void));
        }),
        read: Effect.fn(function* ({ olds, output }) {
          const slug = output?.slug ?? olds?.slug;
          const organization = output?.organization ?? olds?.organization;
          if (!slug || !organization) return undefined;
          const existing = yield* get(organization, slug);
          if (existing === undefined) return undefined;
          // Sentry has no tag or free-text field we can brand, so a project we
          // have never provisioned is surfaced as foreign and the engine gates
          // the takeover behind `--adopt`.
          return output === undefined ? Unowned(existing) : existing;
        }),
      };
    }),
  );
