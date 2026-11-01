import type * as sfs from "@distilled.cloud/stackit/sfs";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ShareExportPolicy } from "./ShareExportPolicy.ts";

export interface GetShareExportPolicyRequest extends Omit<
  sfs.GetShareExportPolicyRequest,
  "projectId" | "region" | "policyId"
> {}

/**
 * Runtime binding for File Storage `getShareExportPolicy`: read a share export policy: its rules and how many shares use it.
 *
 * Bind this operation to a {@link ShareExportPolicy} in a Function/Worker init phase and provide
 * {@link GetShareExportPolicyHttp}. The policy's project, region and id are injected into each request. A foreign host signs with a
 * service account key Alchemy creates for it.
 *
 * Access: a custom role with the single permission `file-storage.share-export-policy.list`, bound on the project
 * holding the policy. STACKIT binds roles on projects at the narrowest, so the permission reaches every File Storage policy in that project.
 *
 * ### Calling `getShareExportPolicy`
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
 *     const getShareExportPolicy = yield* Stackit.FileStorage.GetShareExportPolicy(bound);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const result = yield* getShareExportPolicy({});
 *         return yield* HttpServerResponse.json({ rules: result.shareExportPolicy?.rules?.length });
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(Stackit.FileStorage.GetShareExportPolicyHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @category FileStorage
 */
export interface GetShareExportPolicy extends Binding.Service<
  GetShareExportPolicy,
  "Stackit.FileStorage.GetShareExportPolicy",
  (
    policy: ShareExportPolicy,
  ) => Effect.Effect<
    (
      request: GetShareExportPolicyRequest,
    ) => Effect.Effect<
      sfs.GetShareExportPolicyResponse,
      sfs.GetShareExportPolicyError,
      RuntimeContext
    >
  >
> {}

export const GetShareExportPolicy = Binding.Service<GetShareExportPolicy>(
  "Stackit.FileStorage.GetShareExportPolicy",
);
