import * as iam from "@distilled.cloud/gcp/unstable/iam_v1";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { GcpEnvironment } from "../Environment.ts";
import { inLookupProject } from "../internal/Lookup.ts";
import { createInternalLabels, hasAlchemyLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { encodeOwnedDescription, hasOwnedDescription, parseOwnedDescription } from "./internal.ts";

export type RoleStage = "ALPHA" | "BETA" | "GA" | "DEPRECATED" | "DISABLED" | "EAP";

export type RoleProps = {
  /** Project that owns the role. Defaults to the current GCP project. */
  project?: string;
  /**
   * Role id: 3-64 letters, digits, underscores, or periods. A deleted
   * custom role keeps its id for 37 days, so the id is required rather
   * than generated. Changing it replaces the role.
   */
  roleId: string;
  /** Human-readable title (maximum 100 UTF-8 bytes). */
  title: string;
  /**
   * Human-readable description. Custom roles have no labels, so Alchemy
   * stamps ownership into a `[alchemy …]` prefix and strips it from the
   * `description` attribute. The marker and this text share the API's
   * 256-byte limit; overflow is truncated.
   */
  description?: string;
  /** Permissions the role grants, e.g. `storage.objects.get`. Order is ignored. */
  permissions: string[];
  /**
   * Launch stage.
   * @default "GA"
   */
  stage?: RoleStage;
};

export type Role = Resource<
  "GCP.IAM.Role",
  RoleProps,
  {
    /** Full role name `projects/{project}/roles/{roleId}`, used as an IAM binding's `role`. */
    name: string;
    /** Project that owns the role. */
    project: string;
    /** Role id. */
    roleId: string;
    /** Human-readable title. */
    title: string | undefined;
    /** User description (Alchemy ownership marker stripped). */
    description: string | undefined;
    /** Permissions the role grants, sorted. */
    permissions: string[];
    /** Launch stage. */
    stage: string;
  },
  never,
  Providers,
  RoleLookup
>;

/**
 * Props for {@link Role.lookup}: find a custom role this stack doesn't
 * manage, in the ambient project unless `project` names another.
 */
export interface RoleLookup {
  /** Role id. */
  roleId: string;
  /**
   * Project the role lives in.
   * @default the ambient GCP project
   */
  project?: string;
}

/**
 * A project-level IAM custom role: a named set of permissions to grant
 * where no predefined role is narrow enough.
 *
 * Deleting a custom role soft-deletes it for 7 days (its id stays reserved
 * for 37). Deploying a role whose id is soft-deleted undeletes it and
 * brings it back to the declared title, permissions, and stage. Updates
 * are etag-guarded and retried on concurrent writes.
 *
 * ### Creating a Role
 * **Example:** Read-only access to objects
 * ```typescript
 * const role = yield* GCP.IAM.Role("ObjectReader", {
 *   roleId: "objectReader",
 *   title: "Object reader",
 *   permissions: ["storage.objects.get", "storage.objects.list"],
 * });
 * ```
 *
 * ### Granting a Role
 * **Example:** Grant the custom role to a service account on a bucket
 * ```typescript
 * const role = yield* GCP.IAM.Role("ObjectReader", {
 *   roleId: "objectReader",
 *   title: "Object reader",
 *   permissions: ["storage.objects.get", "storage.objects.list"],
 * });
 * yield* GCP.IAM.Member("ReaderGrant", {
 *   kind: "storage.bucket",
 *   name: bucket.bucketName,
 *   role: role.name,
 *   member: Output.interpolate`serviceAccount:${account.email}`,
 * });
 * ```
 *
 * ### Updating a Role
 * **Example:** Add a permission and promote the stage
 * ```typescript
 * const role = yield* GCP.IAM.Role("ObjectReader", {
 *   roleId: "objectReader",
 *   title: "Object reader",
 *   permissions: ["storage.objects.get", "storage.objects.list", "storage.buckets.get"],
 *   stage: "GA",
 * });
 * ```
 *
 * ### Looking up an existing role
 * **Example:** Reference a custom role another stack manages
 * ```typescript
 * const role = GCP.IAM.Role.lookup({ roleId: "objectReader" });
 * ```
 *
 * @resource
 * @category IAM
 */
export const Role = Resource<Role>("GCP.IAM.Role");

export class RoleNotResolved extends Data.TaggedError("GCP.IAM.RoleNotResolved")<{
  resourceName: string;
}> {}

const nameOf = (project: string, roleId: string) => `projects/${project}/roles/${roleId}`;

const sorted = (permissions: ReadonlyArray<string> | undefined) => [...(permissions ?? [])].sort();

// The API omits `stage` for ALPHA roles.
const stageOf = (role: iam.Role) => role.stage ?? "ALPHA";

const toAttrs = (role: iam.Role, project: string, roleId: string): Role["Attributes"] => ({
  name: role.name ?? nameOf(project, roleId),
  project,
  roleId,
  title: role.title,
  description: parseOwnedDescription(role.description).description,
  permissions: sorted(role.includedPermissions),
  stage: stageOf(role),
});

/** A soft-deleted role reads back with `deleted: true`. */
const getByName = (name: string) =>
  iam.getProjectsRoles({ name }).pipe(Effect.catchTag("NotFound", () => Effect.undefined));

const getLive = (name: string) =>
  getByName(name).pipe(Effect.map((role) => (role?.deleted === true ? undefined : role)));

export const RoleProvider = () =>
  Provider.succeed(Role, {
    stables: ["name", "project", "roleId"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousProject = olds?.project ?? output?.project ?? env.project;
      const previousRoleId = olds?.roleId ?? output?.roleId;
      if (
        (news.project ?? env.project) !== previousProject ||
        (previousRoleId !== undefined && news.roleId !== previousRoleId)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    lookup: Effect.fn(function* ({ roleId }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* getLive(nameOf(env.project, roleId));
      if (existing === undefined) return undefined;
      return toAttrs(existing, env.project, roleId);
    }, inLookupProject),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const project = olds?.project ?? output?.project ?? env.project;
      const roleId = olds?.roleId ?? output?.roleId;
      if (roleId === undefined) return undefined;
      const existing = yield* getLive(output?.name ?? nameOf(project, roleId));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, project, roleId);
      const { labels } = parseOwnedDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* iam.listProjectsRoles
          .pages({ parent: `projects/${env.project}`, view: "FULL", pageSize: 100 })
          .pipe(
            Stream.flatMap((page) => Stream.fromIterable(page.roles ?? [])),
            Stream.filter((role) => hasOwnedDescription(role.description)),
            Stream.map((role) =>
              toAttrs(role, env.project, (role.name ?? "").split("/").pop() ?? ""),
            ),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.catchTag("NotFound", () => Effect.succeed([] as Role["Attributes"][])),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news }) {
      const env = yield* GcpEnvironment.current;
      const project = news.project ?? env.project;
      const name = nameOf(project, news.roleId);
      const description = encodeOwnedDescription(yield* createInternalLabels(id), news.description);
      const permissions = sorted(news.permissions);
      const stage = news.stage ?? "GA";

      const sync = Effect.gen(function* () {
        // Observe, including a soft-deleted role that still holds the id.
        let current = yield* getByName(name);

        // Ensure — `Conflict` is a create race (or a soft-deleted id the
        // read missed); re-read and continue from what is there.
        if (current === undefined) {
          current = yield* iam
            .createProjectsRoles({
              parent: `projects/${project}`,
              body: {
                roleId: news.roleId,
                role: { title: news.title, description, includedPermissions: permissions, stage },
              },
            })
            .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        }
        if (current === undefined) {
          return yield* new RoleNotResolved({ resourceName: name });
        }
        if (current.deleted === true) {
          current = yield* iam.undeleteProjectsRoles({
            name,
            body: { etag: current.etag },
          });
        }

        // Sync title, description, permissions, and stage against observed state.
        const updateMask = [
          (current.title ?? "") !== news.title ? "title" : undefined,
          (current.description ?? "") !== description ? "description" : undefined,
          sorted(current.includedPermissions).join(",") !== permissions.join(",")
            ? "includedPermissions"
            : undefined,
          stageOf(current) !== stage ? "stage" : undefined,
        ].filter((field): field is string => field !== undefined);
        if (updateMask.length > 0) {
          current = yield* iam.patchProjectsRoles({
            name,
            updateMask: updateMask.join(","),
            body: {
              title: news.title,
              description,
              includedPermissions: permissions,
              stage,
              etag: current.etag,
            },
          });
        }
        return current;
      }).pipe(
        // A concurrent writer changed the etag: observe again.
        Effect.retry({
          while: (error) => error._tag === "Conflict",
          times: 5,
          schedule: Schedule.exponential("1 second"),
        }),
      );

      return toAttrs(yield* sync, project, news.roleId);
    }),

    delete: Effect.fn(function* ({ output }) {
      const current = yield* getLive(output.name);
      if (current === undefined) return;
      yield* iam
        .deleteProjectsRoles({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });
