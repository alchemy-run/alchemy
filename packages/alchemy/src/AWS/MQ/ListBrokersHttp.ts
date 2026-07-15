import * as mq from "@distilled.cloud/aws/mq";
import * as Layer from "effect/Layer";
import { makeMqAccountHttpBinding } from "./BindingHttp.ts";
import { ListBrokers } from "./ListBrokers.ts";

export const ListBrokersHttp = Layer.effect(
  ListBrokers,
  makeMqAccountHttpBinding<
    mq.ListBrokersRequest,
    mq.ListBrokersResponse,
    mq.ListBrokersError
  >({
    capability: "ListBrokers",
    operation: mq.listBrokers,
    iamActions: ["mq:ListBrokers"],
  }),
);
