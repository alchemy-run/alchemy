import * as Domain from "@alchemy.run/domain";
import { Customer } from "./Customer.aggregate.ts";

/** Removes a customer: every event, and with them the name and the username. */
export class DeleteCustomer extends Domain.Rewrite("DeleteCustomer", {
  of: Customer,
  delete: true,
}) {}
