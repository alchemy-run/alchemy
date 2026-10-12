import { Api } from "alchemy/Fold";
import { ChangeOwner } from "../Account/ChangeOwner.ts";
import { FreezeAccount } from "../Account/FreezeAccount.ts";
import { ApproveTransfer } from "../Transfer/ApproveTransfer.ts";
import { ActivityLog, ActivityLogLive } from "./ActivityLog.ts";

/**
 * What support agents can do and see, over the same Bank. Its commands carry
 * `SupportAgentSession`, so `decide` sees the agent as the current actor.
 */
export class SupportApi extends Api.make(
  FreezeAccount,
  ChangeOwner,
  ApproveTransfer,
  ActivityLog,
) {}

/** Handlers for the SupportApi's reads (commands are implemented by their aggregates). */
export const SupportApiLive = ActivityLogLive;
