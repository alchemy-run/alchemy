import * as Context from "effect/Context";

/** The authenticated support agent making a request. */
export class CurrentAgent extends Context.Service<CurrentAgent, { readonly agentId: string }>()(
  "Bank/CurrentAgent",
) {}
