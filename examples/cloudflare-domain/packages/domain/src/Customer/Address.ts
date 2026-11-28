import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";

/**
 * A customer's postal address, sealed under the customer's own key. The
 * model stores and carries it, and can't read it.
 */
export const Address = Domain.Sealed(Schema.String);
