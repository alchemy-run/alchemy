import * as qapps from "@distilled.cloud/aws/qapps";
import * as Layer from "effect/Layer";
import { makeQAppHttpBinding } from "./BindingHttp.ts";
import { AssociateQAppWithUser } from "./AssociateQAppWithUser.ts";

export const AssociateQAppWithUserHttp = Layer.effect(
  AssociateQAppWithUser,
  makeQAppHttpBinding<
    qapps.AssociateQAppWithUserInput,
    qapps.AssociateQAppWithUserResponse,
    qapps.AssociateQAppWithUserError
  >({
    capability: "AssociateQAppWithUser",
    iamActions: ["qapps:AssociateQAppWithUser"],
    operation: qapps.associateQAppWithUser,
    injectAppId: true,
  }),
);
