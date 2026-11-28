import * as Domain from "@alchemy.run/domain";
import { ActorName } from "./Actor.ts";

/**
 * Who is making the current request. `Session` provides it; commands read it
 * in `decide` to stamp authors and check claims.
 */
export class CurrentActor extends Domain.RequestContext<CurrentActor>()(
  "Board/CurrentActor",
  ActorName,
) {}
