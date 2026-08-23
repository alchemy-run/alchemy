import { GetRadarValueListsValueList } from "@distilled.cloud/stripe/stripe";
import * as Layer from "effect/Layer";
import { RetrieveRadarValueList } from "./RetrieveRadarValueList.ts";
import { makeHttpStripeIdBinding } from "./StripeHttp.ts";

/**
 * HTTP implementation of {@link RetrieveRadarValueList}.
 *
 * @layer
 * @provides Stripe.RetrieveRadarValueList
 */
export const RetrieveRadarValueListHttp = Layer.effect(
  RetrieveRadarValueList,
  makeHttpStripeIdBinding({
    tag: "Stripe.RetrieveRadarValueList",
    operation: GetRadarValueListsValueList,
    idField: "value_list",
  }),
);
