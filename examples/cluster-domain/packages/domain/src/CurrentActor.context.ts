import * as Domain from "@alchemy.run/domain";
import { Actor } from "./Actor.ts";

/** Who is making the current request. `Session` provides it; `decide` and `validate` read it. */
export class CurrentActor extends Domain.RequestContext<CurrentActor>()(
  "Bank/CurrentActor",
  Actor,
) {}
