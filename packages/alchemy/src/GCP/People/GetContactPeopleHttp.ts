import * as people from "@distilled.cloud/gcp/people_v1";
import * as Layer from "effect/Layer";
import { makeContactPeopleHttpBinding } from "./BindingHttp.ts";
import { GetContactPeople } from "./GetContactPeople.ts";

/**
 * HTTP implementation of {@link GetContactPeople}.
 *
 * @layer
 * @provides GCP.People.GetContactPeople
 */
export const GetContactPeopleHttp = Layer.effect(
  GetContactPeople,
  makeContactPeopleHttpBinding({
    tag: "GCP.People.GetContactPeople",
    operation: people.getPeople,
  }),
);
