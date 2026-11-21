import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { ActorName } from "../Actor.ts";
import { Session } from "../Session.middleware.ts";
import { NotStarted } from "../Thread/NotStarted.rejection.ts";
import { ThreadId } from "../Thread/Thread.id.ts";
import { NotATask } from "./NotATask.rejection.ts";
import { NotYourClaim } from "./NotYourClaim.rejection.ts";
import { LeaseSeconds } from "./TaskStatus.ts";

export class LeaseRenewed extends Domain.Event(
  "LeaseRenewed",
  { by: ActorName, claim: Schema.String, leaseUntil: Schema.Int },
  { description: "The claim's holder extended its lease to `leaseUntil`." },
) {}

export class RenewLease extends Domain.Command(
  "RenewLease",
  {
    middleware: [Session],
    input: { threadId: ThreadId, leaseSeconds: Schema.optional(LeaseSeconds) },
    events: [LeaseRenewed],
    rejects: [NotStarted, NotATask, NotYourClaim],
    reply: { leaseUntil: Schema.Int },
  },
  { description: "Extend your claim on a task: it then lasts leaseSeconds from now." },
) {}
