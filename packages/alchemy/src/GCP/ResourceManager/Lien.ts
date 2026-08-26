import * as resourcemanager from "@distilled.cloud/gcp/cloudresourcemanager_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_LIEN_ORIGIN,
  DEFAULT_LIEN_RESTRICTIONS,
  LIEN_ORIGIN_MAX,
  LIEN_REASON_MAX,
  collectPages,
  createOwnership,
  encodeDescription,
  hasOwnershipMarker,
  ownedByAlchemy,
  parseDescription,
  projectNumberOf,
  projectParent,
  sameStringList,
} from "./internal.ts";

export type LienProps = {
  /**
   * Resource this lien attaches to, e.g. `projects/{project}`. Defaults
   * to the current project (numeric form). Immutable — changing it
   * replaces the lien.
   */
  parent?: string;
  /**
   * Origin of the lien (max 200 characters). Programmatic identifier
   * for the system that created it.
   * @default "alchemy.effect"
   */
  origin?: string;
  /**
   * User-visible reason the restriction exists (max 200 characters).
   * Liens have no labels, so Alchemy stamps ownership into a
   * `[alchemy …]` prefix for `list` / nuke and strips it from
   * attributes.
   */
  reason?: string;
  /**
   * IAM permissions this lien blocks. An empty list is rejected.
   * @default ["resourcemanager.projects.delete"]
   */
  restrictions?: string[];
};

export type Lien = Resource<
  "GCP.ResourceManager.Lien",
  LienProps,
  {
    /** Resource name `liens/{lien_id}`. */
    name: string;
    /** Parent resource this lien is attached to. */
    parent: string;
    /** Origin identifier. */
    origin: string;
    /** User reason with the Alchemy ownership prefix stripped. */
    reason: string | undefined;
    /** Blocked IAM permissions. */
    restrictions: string[];
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** Project id used to default `parent`. */
    project: string;
  },
  never,
  Providers
>;

/**
 * A Cloud Resource Manager lien — an encumbrance that blocks selected
 * operations on a project (most commonly project deletion).
 *
 * Liens have no update API and no labels. Alchemy stamps ownership into
 * `reason` so `list` / `pnpm nuke:gcp` can find them. Changing `parent`,
 * `origin`, `reason`, or `restrictions` replaces the lien (delete-first).
 *
 * ### Creating a Lien
 * **Example:** Block deletion of the current project
 * ```typescript
 * const lien = yield* GCP.ResourceManager.Lien("Hold", {
 *   reason: "production API key",
 * });
 * ```
 *
 * **Example:** Explicit parent and restrictions
 * ```typescript
 * const lien = yield* GCP.ResourceManager.Lien("Hold", {
 *   parent: "projects/123456789",
 *   origin: "alchemy.effect",
 *   reason: "holds billing export",
 *   restrictions: ["resourcemanager.projects.delete"],
 * });
 * ```
 *
 * @resource
 * @product GCP
 * @category ResourceManager
 */
export const Lien = Resource<Lien>("GCP.ResourceManager.Lien");

export class LienNotResolved extends Data.TaggedError(
  "GCP.ResourceManager.LienNotResolved",
)<{
  name: string;
}> {}

export class LienStillExists extends Data.TaggedError(
  "GCP.ResourceManager.LienStillExists",
)<{
  name: string;
}> {}

const unique = (values: string[]) => [
  ...new Set(values.filter((value) => value.length > 0)),
];

const parentAliases = (
  parent: string,
  project: string,
  projectNumber: string,
) => {
  const normalized = projectParent(parent);
  if (!normalized.startsWith("projects/")) return [normalized];
  return unique([
    normalized,
    `projects/${project}`,
    `projects/${projectNumber}`,
  ]);
};

const sameParent = (
  left: string,
  right: string,
  project: string,
  projectNumber: string,
) => {
  const aliases = new Set(parentAliases(left, project, projectNumber));
  return parentAliases(right, project, projectNumber).some((alias) =>
    aliases.has(alias),
  );
};

const restrictionsOf = (values: readonly string[] | undefined) => {
  const next = [...(values ?? DEFAULT_LIEN_RESTRICTIONS)].filter(
    (value) => value.length > 0,
  );
  return next.length > 0 ? next : [...DEFAULT_LIEN_RESTRICTIONS];
};

const originOf = (origin: string | undefined) => {
  const next = (origin ?? DEFAULT_LIEN_ORIGIN).trim();
  return next.length > 0 ? next.slice(0, LIEN_ORIGIN_MAX) : DEFAULT_LIEN_ORIGIN;
};

const toAttrs = (lien: resourcemanager.Lien, project: string) => ({
  name: lien.name ?? "",
  parent: lien.parent ?? "",
  origin: lien.origin ?? DEFAULT_LIEN_ORIGIN,
  reason: parseDescription(lien.reason).description,
  restrictions: lien.restrictions ?? [],
  createTime: lien.createTime,
  project,
});

const getByName = (name: string) =>
  resourcemanager
    .getLiens({ name })
    .pipe(
      Effect.catchTag(["NotFound", "Forbidden"], () =>
        Effect.succeed(undefined),
      ),
    );

const listOnParent = (parent: string) =>
  collectPages(
    resourcemanager.listLiens.pages({
      parent,
      pageSize: 300,
    }),
    (page) => page.liens,
  ).pipe(
    Effect.catchTag(["NotFound", "Forbidden"], () =>
      Effect.succeed([] as resourcemanager.Lien[]),
    ),
  );

const listOnParents = (parents: string[]) =>
  Effect.gen(function* () {
    const pages = yield* Effect.forEach(parents, listOnParent, {
      concurrency: 2,
    });
    const byName = new Map<string, resourcemanager.Lien>();
    for (const lien of pages.flat()) {
      if (lien.name) byName.set(lien.name, lien);
    }
    return [...byName.values()];
  });

const matchesDesired = (
  lien: resourcemanager.Lien,
  parent: string,
  origin: string,
  reason: string,
  restrictions: readonly string[],
  project: string,
  projectNumber: string,
) =>
  sameParent(lien.parent ?? "", parent, project, projectNumber) &&
  (lien.origin ?? "") === origin &&
  (lien.reason ?? "") === reason &&
  sameStringList(lien.restrictions, restrictions);

const findOwned = (
  id: string,
  parent: string,
  project: string,
  projectNumber: string,
  resourceName?: string,
) =>
  Effect.gen(function* () {
    if (resourceName !== undefined && resourceName.length > 0) {
      const byName = yield* getByName(resourceName);
      if (byName !== undefined) return byName;
    }
    const liens = yield* listOnParents(
      parentAliases(parent, project, projectNumber),
    );
    for (const lien of liens) {
      if (yield* ownedByAlchemy(id, lien.reason)) return lien;
    }
    return undefined;
  });

const waitUntilExists = (
  id: string,
  parent: string,
  project: string,
  projectNumber: string,
  resourceName?: string,
) =>
  findOwned(id, parent, project, projectNumber, resourceName).pipe(
    Effect.filterOrFail(
      (lien): lien is resourcemanager.Lien => lien !== undefined,
      () =>
        new LienNotResolved({
          name: resourceName ?? parent,
        }),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.ResourceManager.LienNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((lien) =>
      lien === undefined
        ? Effect.void
        : Effect.fail(new LienStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.ResourceManager.LienStillExists",
      times: 10,
      schedule: Schedule.spaced("1 second"),
    }),
  );

export const LienProvider = () =>
  Provider.succeed(Lien, {
    stables: ["name", "parent", "origin", "createTime", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const projectNumber = yield* projectNumberOf(env.project);
      const previousParent = olds?.parent ?? output?.parent;
      const nextParent = projectParent(
        news.parent ?? previousParent ?? env.project,
      );
      const parentChanged =
        previousParent !== undefined &&
        !sameParent(previousParent, nextParent, env.project, projectNumber);

      const previousOrigin = originOf(olds?.origin ?? output?.origin);
      const originChanged =
        news.origin !== undefined && originOf(news.origin) !== previousOrigin;

      const previousRestrictions = restrictionsOf(
        olds?.restrictions ?? output?.restrictions,
      );
      const restrictionsChanged =
        news.restrictions !== undefined &&
        !sameStringList(news.restrictions, previousRestrictions);

      const previousReason = olds?.reason ?? output?.reason;
      const reasonChanged =
        news.reason !== undefined && news.reason !== previousReason;

      if (
        !parentChanged &&
        !originChanged &&
        !restrictionsChanged &&
        !reasonChanged
      ) {
        return undefined;
      }
      return { action: "replace" as const, deleteFirst: true };
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const projectNumber = yield* projectNumberOf(env.project);
      const parent = projectParent(
        output?.parent ?? olds?.parent ?? `projects/${projectNumber}`,
      );
      const existing = yield* findOwned(
        id,
        parent,
        env.project,
        projectNumber,
        output?.name,
      );
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.reason))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const projectNumber = yield* projectNumberOf(env.project);
        const liens = yield* listOnParents(
          parentAliases(
            `projects/${projectNumber}`,
            env.project,
            projectNumber,
          ),
        );
        return liens
          .filter((lien) => hasOwnershipMarker(lien.reason))
          .map((lien) => toAttrs(lien, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const projectNumber = yield* projectNumberOf(env.project);
      const parent = projectParent(
        news.parent ?? output?.parent ?? `projects/${projectNumber}`,
      );
      const origin = originOf(news.origin);
      const restrictions = restrictionsOf(news.restrictions);
      const ownership = yield* createOwnership(id);
      const reason = encodeDescription(ownership, news.reason, LIEN_REASON_MAX);

      let current = yield* findOwned(
        id,
        parent,
        env.project,
        projectNumber,
        output?.name,
      );

      if (
        current !== undefined &&
        !matchesDesired(
          current,
          parent,
          origin,
          reason,
          restrictions,
          env.project,
          projectNumber,
        )
      ) {
        if (current.name !== undefined) {
          yield* resourcemanager
            .deleteLiens({ name: current.name })
            .pipe(
              Effect.catchTag(["NotFound", "Forbidden"], () => Effect.void),
            );
          yield* waitUntilGone(current.name);
        }
        current = undefined;
      }

      if (current === undefined) {
        const created = yield* resourcemanager
          .createLiens({
            body: {
              parent,
              origin,
              reason,
              restrictions,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined && created.name !== undefined) {
          current = created;
        } else {
          current = yield* waitUntilExists(
            id,
            parent,
            env.project,
            projectNumber,
          );
        }
      }

      if (current === undefined || current.name === undefined) {
        return yield* new LienNotResolved({ name: parent });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* resourcemanager
        .deleteLiens({ name: output.name })
        .pipe(Effect.catchTag(["NotFound", "Forbidden"], () => Effect.void));
      yield* waitUntilGone(output.name);
    }),
  });
