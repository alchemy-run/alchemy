import type * as people from "@distilled.cloud/gcp/people_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { ContactPeople } from "./ContactPeople.ts";

export interface GetContactPeopleRequest extends Omit<
  people.GetPeopleRequest,
  "resourceName"
> {}

/**
 * Runtime binding for People `people.get` on a contact.
 *
 * Bind this operation to a {@link ContactPeople} in a Function/Action
 * init phase. Provide {@link GetContactPeopleHttp}.
 *
 * ### Reading Contacts
 * **Example:** Read contact metadata
 * ```typescript
 * const getPerson = yield* GCP.People.GetContactPeople(person);
 * const metadata = yield* getPerson({});
 * ```
 *
 * @binding
 * @product GCP
 * @category People
 */
export interface GetContactPeople extends Binding.Service<
  GetContactPeople,
  "GCP.People.GetContactPeople",
  (
    person: ContactPeople,
  ) => Effect.Effect<
    (
      request: GetContactPeopleRequest,
    ) => Effect.Effect<people.Person, people.GetPeopleError, RuntimeContext>
  >
> {}

export const GetContactPeople = Binding.Service<GetContactPeople>(
  "GCP.People.GetContactPeople",
);
