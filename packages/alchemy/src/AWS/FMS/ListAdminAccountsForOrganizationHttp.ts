import * as fms from "@distilled.cloud/aws/fms";
import * as Layer from "effect/Layer";
import { makeFmsHttpBinding } from "./BindingHttp.ts";
import { ListAdminAccountsForOrganization } from "./ListAdminAccountsForOrganization.ts";

export const ListAdminAccountsForOrganizationHttp = Layer.effect(
  ListAdminAccountsForOrganization,
  makeFmsHttpBinding<
    fms.ListAdminAccountsForOrganizationRequest,
    fms.ListAdminAccountsForOrganizationResponse,
    fms.ListAdminAccountsForOrganizationError
  >({
    capability: "ListAdminAccountsForOrganization",
    iamActions: ["fms:ListAdminAccountsForOrganization"],
    operation: fms.listAdminAccountsForOrganization,
    pinToAdminRegion: true,
  }),
);
