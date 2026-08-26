import type * as people from "@distilled.cloud/gcp/people_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ContactGroup } from "./ContactGroup.ts";

export interface GetContactGroupRequest extends Omit<
  people.GetContactGroupsRequest,
  "resourceName"
> {}

/**
 * Runtime binding for People `contactGroups.get`.
 *
 * Bind this operation to a {@link ContactGroup} in a Function/Action
 * init phase. Provide {@link GetContactGroupHttp}.
 *
 * ### Reading Contact Groups
 * **Example:** Read contact group metadata
 * ```typescript
 * const getGroup = yield* GCP.People.GetContactGroup(group);
 * const metadata = yield* getGroup({});
 * ```
 *
 * @binding
 * @product GCP
 * @category People
 */
export interface GetContactGroup extends Binding.Service<
  GetContactGroup,
  "GCP.People.GetContactGroup",
  (
    group: ContactGroup,
  ) => Effect.Effect<
    (
      request: GetContactGroupRequest,
    ) => Effect.Effect<
      people.ContactGroup,
      people.GetContactGroupsError,
      RuntimeContext
    >
  >
> {}

export const GetContactGroup = Binding.Service<GetContactGroup>(
  "GCP.People.GetContactGroup",
);
