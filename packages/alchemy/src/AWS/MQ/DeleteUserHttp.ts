import * as mq from "@distilled.cloud/aws/mq";
import * as Layer from "effect/Layer";
import { makeMqBrokerHttpBinding } from "./BindingHttp.ts";
import { DeleteUser } from "./DeleteUser.ts";

export const DeleteUserHttp = Layer.effect(
  DeleteUser,
  makeMqBrokerHttpBinding({
    capability: "DeleteUser",
    operation: mq.deleteUser,
    iamActions: ["mq:DeleteUser"],
  }),
);
