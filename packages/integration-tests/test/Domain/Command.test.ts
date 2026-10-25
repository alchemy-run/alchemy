import * as Domain from "@alchemy.run/domain";
import { DefinitionError } from "@alchemy.run/domain/Kernel";
import { describe, expect, it } from "@alchemy.run/test";
import * as Schema from "effect/Schema";

describe("Domain Command", () => {
  it("refuses an input field named target", () => {
    expect(() =>
      Domain.Command("Move", {
        target: Schema.String,
        // @ts-expect-error the RPC payload uses `target` for the aggregate id
        input: { target: Schema.String, amount: Schema.Number },
      }),
    ).toThrow(
      new DefinitionError(
        "Move declares the input field 'target', which the command's payload uses for its target id",
      ),
    );
  });

  it("refuses an input field named commandId", () => {
    expect(() =>
      Domain.Command("Pay", {
        target: Schema.String,
        // @ts-expect-error the RPC payload uses `commandId` for idempotency
        input: { commandId: Schema.String },
      }),
    ).toThrow(
      new DefinitionError(
        "Pay declares the input field 'commandId', which the command's payload uses for its idempotency key",
      ),
    );
  });
});
