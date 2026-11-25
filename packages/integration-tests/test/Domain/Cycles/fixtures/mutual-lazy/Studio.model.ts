import * as Domain from "@alchemy.run/domain";
import { Ticket } from "../shared/Ticket.aggregate.ts";
import { Author } from "./Author.process.ts";
import { Reviewer } from "./Reviewer.process.ts";

/** Two processes that start each other: the model provides each one's client to the other. */
export class Studio extends Domain.Model("Studio", {
  aggregates: [Ticket],
  processes: [Author, Reviewer],
}) {}
