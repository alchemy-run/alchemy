import * as Domain from "@alchemy.run/domain";
import { DefinitionError } from "@alchemy.run/domain/Kernel";
import { describe, expect, it } from "@alchemy.run/test";
import * as Schema from "effect/Schema";

describe("Domain RequestContext", () => {
  it("refuses a second request context with the same key", () => {
    class CurrentUser extends Domain.RequestContext<CurrentUser>()(
      "Test/CurrentUser",
      Schema.Struct({ userId: Schema.String }),
    ) {}
    expect(CurrentUser.key).toBe("Test/CurrentUser");
    expect(() => {
      class OtherUser extends Domain.RequestContext<OtherUser>()(
        "Test/CurrentUser",
        Schema.Struct({ email: Schema.String }),
      ) {}
      return OtherUser;
    }).toThrow(
      new DefinitionError(
        "Two request contexts use the key 'Test/CurrentUser' with different schemas: give each its own key",
      ),
    );
  });

  it("accepts the same declaration again, as when its module is evaluated twice", () => {
    const declare = () =>
      class Tenant extends Domain.RequestContext<Tenant>()(
        "Test/Tenant",
        Schema.Struct({ tenantId: Schema.String.pipe(Schema.brand("TenantId")) }),
      ) {};
    declare();
    expect(() => declare()).not.toThrow();
  });
});
