import * as profiles from "@distilled.cloud/aws/route53profiles";
import * as Layer from "effect/Layer";
import { makeProfilesHttpBinding } from "./BindingHttp.ts";
import { ListProfileResourceAssociations } from "./ListProfileResourceAssociations.ts";

export const ListProfileResourceAssociationsHttp = Layer.effect(
  ListProfileResourceAssociations,
  makeProfilesHttpBinding({
    tag: "AWS.Route53Profiles.ListProfileResourceAssociations",
    operation: profiles.listProfileResourceAssociations,
    actions: ["route53profiles:ListProfileResourceAssociations"],
    // The profile is the addressed resource (its id is in the request URI),
    // so the grant is scoped to the bound profile's ARN.
    scope: "profile",
  }),
);
