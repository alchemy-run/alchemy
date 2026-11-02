import type * as sfs from "@distilled.cloud/stackit/sfs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { BindingScope } from "./BindingScope.ts";

export interface ListShareExportPoliciesRequest extends Omit<
  sfs.ListShareExportPoliciesRequest,
  "projectId" | "region"
> {}

/**
 * Runtime binding for File Storage `listShareExportPolicies`: list the share export policies of a project and region.
 *
 * Bind this operation to any resource in the project and region (see {@link BindingScope}) in a Function/Worker init phase and provide
 * {@link ListShareExportPoliciesHttp}. The bound resource's project and region are injected into each request. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role with the single permission `file-storage.share-export-policy.list`, bound on the project
 * holding the policy. STACKIT binds roles on projects at the narrowest, so the permission reaches every File Storage policy in that project.
 *
 * ### Calling `listShareExportPolicies`
 * **Example:** From a Cloudflare Worker
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Effect from "effect/Effect";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export const Clients = Stackit.FileStorage.ShareExportPolicy("Clients", {
 *   rules: [{ order: 1, ipAcl: ["10.0.0.0/24"] }],
 * });
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.url, compatibility: { flags: ["nodejs_compat"] } },
 *   Effect.gen(function* () {
 *     const bound = yield* Clients;
 *     const listShareExportPolicies = yield* Stackit.FileStorage.ListShareExportPolicies(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* listShareExportPolicies({});
 *         return yield* HttpServerResponse.json({ policies: result.shareExportPolicies?.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.FileStorage.ListShareExportPoliciesHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category FileStorage
 */
export interface ListShareExportPolicies extends Binding.Service<
  ListShareExportPolicies,
  "Stackit.FileStorage.ListShareExportPolicies",
  (
    scope: BindingScope,
  ) => Effect.Effect<
    (
      request?: ListShareExportPoliciesRequest,
    ) => Effect.Effect<
      sfs.ListShareExportPoliciesResponse,
      sfs.ListShareExportPoliciesError,
      RuntimeContext
    >
  >
> {}

export const ListShareExportPolicies = Binding.Service<ListShareExportPolicies>(
  "Stackit.FileStorage.ListShareExportPolicies",
);
