import * as Azure from "@alchemy.run/azure";
import { PlaceOrder, PlaceOrderLive } from "./orders.ts";

/** Durable Task Schedulers are not offered in every region (not eastus). */
export const LOCATION = "westus2";

/** The Azure Function that runs the order workflows on Durable Functions. */
export class OrderWorkflows extends Azure.Functions.WorkflowFunction<OrderWorkflows>()(
  "OrderWorkflows",
  { workflows: [PlaceOrder], schedulerLocation: LOCATION },
) {}

export default OrderWorkflows.make({ main: import.meta.url, location: LOCATION }, PlaceOrderLive);
