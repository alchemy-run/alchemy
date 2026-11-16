import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  hasIamMembership,
  revokeIamMembership,
  updateIamMembership,
  type GcpIamResourceKind,
} from "../IamPolicy.ts";
import type { Providers } from "../Providers.ts";

export type MemberProps = {
  /**
   * Kind of resource whose IAM policy receives the member, e.g.
   * `run.service`, `pubsub.topic`, `storage.bucket`, or `project`.
   * Changing it replaces the grant.
   */
  kind: GcpIamResourceKind;
  /**
   * Full resource name (`projects/p/locations/l/services/s`), a bucket name
   * for `storage.bucket`, or a project id for `project`. Changing it
   * replaces the grant.
   */
  name: string;
  /** Role to grant, e.g. `roles/run.invoker`. Changing it replaces the grant. */
  role: string;
  /**
   * Principal, e.g. `serviceAccount:x@p.iam.gserviceaccount.com`. A bare
   * email is treated as a service account. Changing it replaces the grant.
   */
  member: string;
  /**
   * IAM Condition (CEL) that narrows the grant, e.g. to one resource or a
   * time window. The grant is written as its own conditional binding at
   * policy version 3; unconditional bindings of the same role are left
   * alone. Changing `title` or `expression` replaces the grant.
   * @default no condition — an unconditional grant
   */
  condition?: MemberCondition;
};

export interface MemberCondition {
  /** Short title. Together with `expression` it identifies the binding. */
  title: string;
  /** CEL expression, e.g. `resource.name.startsWith("projects/_/buckets/b/objects/logs/")`. */
  expression: string;
  /** Longer description. Written on create; not compared on later deploys. */
  description?: string;
}

/**
 * One `role` → `member` edge on a single resource's IAM policy — the GCP
 * analog of a Terraform `google_*_iam_member`. Only this edge is managed:
 * other members of the role, other roles, and other conditional bindings
 * are left alone: an unconditional grant ignores conditional bindings, and
 * a conditional grant touches only the binding with its own condition.
 * Updates are etag-guarded and retried on concurrent writes.
 *
 * Event sources use it to let a push identity invoke its Cloud Run host.
 *
 * ### Granting a role
 * **Example:** Let a service account invoke a Cloud Run service
 * ```typescript
 * yield* GCP.IAM.Member("Invoker", {
 *   kind: "run.service",
 *   name: service.name,
 *   role: "roles/run.invoker",
 *   member: Output.interpolate`serviceAccount:${caller.email}`,
 * });
 * ```
 *
 * ### Granting a role under a condition
 * **Example:** Grant a project role only on one Cloud SQL instance
 * ```typescript
 * yield* GCP.IAM.Member("SqlClient", {
 *   kind: "project",
 *   name: instance.project,
 *   role: "roles/cloudsql.client",
 *   member: Output.interpolate`serviceAccount:${caller.email}`,
 *   condition: {
 *     title: "only-app-db",
 *     expression: Output.interpolate`resource.name == "projects/${instance.project}/instances/${instance.instanceName}"`,
 *   },
 * });
 * ```
 *
 * @resource
 * @category IAM
 */
export type Member = Resource<"GCP.IAM.Member", MemberProps, MemberProps, never, Providers>;

export const Member = Resource<Member>("GCP.IAM.Member");

export const MemberProvider = () =>
  Provider.succeed(Member, {
    stables: ["kind", "name", "role", "member"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news) || olds === undefined) return undefined;
      const changed =
        news.kind !== olds.kind ||
        news.name !== olds.name ||
        news.role !== olds.role ||
        news.member !== olds.member ||
        news.condition?.title !== olds.condition?.title ||
        news.condition?.expression !== olds.condition?.expression;
      return changed ? { action: "replace" as const, deleteFirst: false } : undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const props = output ?? olds;
      if (props === undefined) return undefined;
      const present = yield* hasIamMembership(props);
      return present ? { ...props } : undefined;
    }),

    reconcile: Effect.fn(function* ({ news }) {
      yield* updateIamMembership({
        kind: news.kind,
        name: news.name,
        member: news.member,
        add: [news.role],
        condition: news.condition,
      });
      return { ...news };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* revokeIamMembership({
        kind: output.kind,
        name: output.name,
        member: output.member,
        roles: [output.role],
        condition: output.condition,
      });
    }),
  });
