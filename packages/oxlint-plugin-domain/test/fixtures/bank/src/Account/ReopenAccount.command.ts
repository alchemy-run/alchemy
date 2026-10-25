import * as Domain from "@alchemy.run/domain";
import { AccountId } from "./Account.id.ts";
import { Frozen } from "./Frozen.rejection.ts";
import { NotOpen } from "./NotOpen.rejection.ts";
import { Reopened } from "./Reopened.rejection.ts";

const reopenRejects = [Frozen, NotOpen, Reopened];

/** Its `rejects` is a shared constant: rules that read it from another file skip it. */
export class ReopenAccount extends Domain.Command("ReopenAccount", {
  target: AccountId,
  events: [],
  rejects: reopenRejects,
}) {}
