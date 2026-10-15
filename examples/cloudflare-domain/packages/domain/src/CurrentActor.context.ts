import * as Domain from "alchemy/Domain";
import { Actor } from "./Actor.ts";

/**
 * Who is making the current request. `Session` provides it; commands read it
 * in `decide` and views in `validate`. Senders without a session (policies)
 * provide it themselves.
 */
export class CurrentActor extends Domain.RequestContext<CurrentActor>()(
  "Bank/CurrentActor",
  Actor,
) {}
