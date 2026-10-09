import { Api } from "alchemy/Fold";
import * as Layer from "effect/Layer";
import { ActivityLog, ActivityLogLive } from "./ActivityLog.ts";
import { FreezeAccount, FreezeAccountLive } from "./FreezeAccount.ts";
import { ReassignAccount, ReassignAccountLive } from "./ReassignAccount.ts";

/** What support agents can do and see, over the same Bank. Each operation carries `SupportAgentSession`. */
export class SupportApi extends Api.make(FreezeAccount, ReassignAccount, ActivityLog) {}

/** Server-side implementations of every SupportApi operation (middleware Layers are provided separately). */
export const SupportApiLive = Layer.mergeAll(
  FreezeAccountLive,
  ReassignAccountLive,
  ActivityLogLive,
);
