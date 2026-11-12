import type * as organization from "@distilled.cloud/clickhouse-cloud/organization";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";
import type { ResultMissing } from "../Errors.ts";
import type { Organization } from "./Organization.ts";

/**
 * Read one entry of the organization's audit log at runtime, by ID.
 *
 * The host gets its own API key, with a role that allows only
 * `control-plane:organization:view` and
 * `control-plane:organization:view-activities` on the organization. ClickHouse Cloud
 * federates no workload identity, so a key is the only way in.
 *
 * ### Reading an Activity
 * **Example:** Look up one audit event
 * ```typescript
 * export const Org = ClickHouseCloud.Organization.Organization("Org", {});
 *
 * export default class Audit extends Cloudflare.Worker<Audit>()(
 *   "Audit",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     // init: grants control-plane:organization:view and :view-activities
 *     const getActivity = yield* ClickHouseCloud.Organization.GetActivity(Org);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const request = yield* HttpServerRequest;
 *         const id = new URL(request.url, "http://worker").searchParams.get("id")!;
 *         // runtime
 *         const activity = yield* getActivity(id);
 *         return yield* HttpServerResponse.json(activity);
 *       }).pipe(Effect.orDie),
 *     };
 *   }).pipe(Effect.provide(ClickHouseCloud.Organization.GetActivityHttp)),
 * ) {}
 * ```
 *
 * @binding
 * @product Organization
 */
export interface GetActivity extends Binding.Service<
  GetActivity,
  "ClickHouseCloud.Organization.GetActivity",
  (
    target: Organization,
  ) => Effect.Effect<
    (
      activityId: string,
    ) => Effect.Effect<
      organization.Activity,
      organization.GetActivityError | ResultMissing,
      RuntimeContext
    >
  >
> {}

export const GetActivity = Binding.Service<GetActivity>("ClickHouseCloud.Organization.GetActivity");
