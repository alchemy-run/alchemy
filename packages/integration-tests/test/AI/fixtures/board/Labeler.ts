import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/** Who a command is sent as. */
export class Labeler extends Domain.RequestContext<Labeler>()(
  "Board/Labeler",
  Schema.Struct({ name: Schema.String }),
) {}
