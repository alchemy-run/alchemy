import * as people from "@distilled.cloud/gcp/people_v1";
import * as Layer from "effect/Layer";
import { makeContactGroupHttpBinding } from "./BindingHttp.ts";
import { GetContactGroup } from "./GetContactGroup.ts";

/**
 * HTTP implementation of {@link GetContactGroup}.
 *
 * @layer
 * @provides GCP.People.GetContactGroup
 */
export const GetContactGroupHttp = Layer.effect(
  GetContactGroup,
  makeContactGroupHttpBinding({
    tag: "GCP.People.GetContactGroup",
    operation: people.getContactGroups,
  }),
);
