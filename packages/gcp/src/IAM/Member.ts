import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  hasIamMembership,
  revokeIamMembership,
  updateIamMembership,
  type GcpIamResourceKind,
  type IamCondition,
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
   * An IAM Condition the grant holds under: a CEL `expression` over the
   * request, such as the name or tags of the resource it reaches, and a
   * `title`. The member gets the role only where the expression is true.
   * Changing the title or the expression replaces the grant.
   * @default the grant is unconditional
   */
  condition?: MemberCondition;
};

/** The IAM Condition of a {@link MemberProps.condition conditional grant}. */
export type MemberCondition = {
  /** A short name for the condition, shown beside the grant in the console. */
  title: string;
  /** A CEL expression, e.g. `resource.name.startsWith("projects/_/buckets/b/objects/public/")`. */
  expression: string;
  /** A longer explanation of the condition, set when the grant is first made. */
  description?: string;
};

const conditionOf = (props: MemberProps): { condition?: IamCondition } =>
  props.condition === undefined ? {} : { condition: props.condition };

export type Member = Resource<"GCP.IAM.Member", MemberProps, MemberProps, never, Providers>;

/**
 * One `role` → `member` edge on a single resource's IAM policy — the GCP
 * analog of a Terraform `google_*_iam_member`. Only this edge is managed:
 * other members of the role, other roles, and bindings of the same role
 * under another condition are left alone. Updates are etag-guarded and
 * retried on concurrent writes.
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
 * ### Granting a role on part of a resource
 * A `condition` narrows a grant to the requests its expression is true
 * for, on the services that support IAM Conditions. A grant under one
 * condition is separate from the same role under another, or under none.
 *
 * **Example:** Read only the objects under one prefix of a bucket
 * ```typescript
 * yield* GCP.IAM.Member("PublicReader", {
 *   kind: "storage.bucket",
 *   name: bucket.bucketName,
 *   role: "roles/storage.objectViewer",
 *   member: Output.interpolate`serviceAccount:${reader.email}`,
 *   condition: {
 *     title: "public objects only",
 *     expression: Output.interpolate`resource.name.startsWith("projects/_/buckets/${bucket.bucketName}/objects/public/")`,
 *   },
 * });
 * ```
 *
 * @resource
 * @category IAM
 */
export const Member = Resource<Member>("GCP.IAM.Member");

export const MemberProvider = () =>
  Provider.succeed(Member, {
    stables: ["kind", "name", "role", "member", "condition"],

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
        ...conditionOf(news),
      });
      return { ...news };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* revokeIamMembership({
        kind: output.kind,
        name: output.name,
        member: output.member,
        roles: [output.role],
        ...conditionOf(output),
      });
    }),
  });
