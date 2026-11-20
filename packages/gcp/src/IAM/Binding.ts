import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import { iamBindingMembers, setIamBinding, type GcpIamResourceKind } from "../IamPolicy.ts";
import type { Providers } from "../Providers.ts";

export type BindingProps = {
  /**
   * Kind of resource whose IAM policy holds the binding, e.g.
   * `storage.bucket`, `pubsub.topic`, or `project`. Changing it replaces
   * the binding.
   */
  kind: GcpIamResourceKind;
  /**
   * Full resource name (`projects/p/topics/t`), a bucket name for
   * `storage.bucket`, or a project id for `project`. Changing it replaces
   * the binding.
   */
  name: string;
  /** Role whose members this binding owns, e.g. `roles/storage.objectViewer`. Changing it replaces the binding. */
  role: string;
  /**
   * Every principal that holds `role`, e.g.
   * `serviceAccount:x@p.iam.gserviceaccount.com`. A bare email is treated
   * as a service account. Members outside this list are removed from the
   * role on every deploy.
   */
  members: ReadonlyArray<string>;
};

/**
 * The complete member list of one role on a single resource's IAM policy
 * — the GCP analog of a Terraform `google_*_iam_binding`. Unlike
 * {@link Member}, which adds one principal and leaves the rest alone, a
 * Binding is authoritative for its role: principals granted the role
 * outside Alchemy (in the console, by another stack, or by a
 * `GCP.IAM.Member` on the same role) are removed on the next deploy.
 * Other roles and every conditional binding are left alone. Deleting the
 * Binding removes the role's unconditional binding.
 *
 * Do not combine a Binding with `GCP.IAM.Member` grants of the same role
 * on the same resource: each deploy would undo the other.
 *
 * ### Owning a role's members
 * **Example:** Exactly two readers of a bucket
 * ```typescript
 * yield* GCP.IAM.Binding("Readers", {
 *   kind: "storage.bucket",
 *   name: bucket.bucketName,
 *   role: "roles/storage.objectViewer",
 *   members: [
 *     Output.interpolate`serviceAccount:${reader.email}`,
 *     "group:auditors@example.com",
 *   ],
 * });
 * ```
 *
 * @resource
 * @category IAM
 */
export type Binding = Resource<"GCP.IAM.Binding", BindingProps, BindingProps, never, Providers>;

export const Binding = Resource<Binding>("GCP.IAM.Binding");

export const BindingProvider = () =>
  Provider.succeed(Binding, {
    stables: ["kind", "name", "role"],

    diff: Effect.fn(function* ({ news, olds }) {
      if (!isResolved(news) || olds === undefined) return undefined;
      const moved = news.kind !== olds.kind || news.name !== olds.name || news.role !== olds.role;
      return moved ? { action: "replace" as const, deleteFirst: false } : undefined;
    }),

    read: Effect.fn(function* ({ olds, output }) {
      const props = output ?? olds;
      if (props === undefined) return undefined;
      const members = yield* iamBindingMembers(props);
      return members === undefined ? undefined : { ...props, members };
    }),

    reconcile: Effect.fn(function* ({ news }) {
      yield* setIamBinding(news);
      return { ...news, members: [...news.members] };
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* setIamBinding({ ...output, members: [] }).pipe(
        Effect.catchIf(
          (error) => error._tag === "NotFound",
          () => Effect.void,
        ),
      );
    }),
  });
