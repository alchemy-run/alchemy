import * as sdb from "@distilled.cloud/aws/simpledb";
import * as Binding from "alchemy/Binding";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWSBindings from "../AWSBindings.ts";
import { RegisterSimpleDbBinding } from "./Binding.ts";
import type { Domain } from "./Domain.ts";

export interface SelectRequest extends Omit<sdb.SelectRequest, "SelectExpression"> {
  /**
   * The select expression (`select output_list from domain [where ...]`).
   *
   * Pass a function to receive the domain's resolved physical name — useful
   * because generated domain names are not known until deploy time:
   * `(domain) => \`select * from \\\`${domain}\\\`\``.
   */
  SelectExpression: string | ((domainName: string) => string);
}

/**
 * Runtime binding for `sdb:Select`.
 *
 * Bind this operation to a {@link Domain} inside a function runtime.
 * `Select` addresses the domain inside the expression itself rather than via
 * a request field, so the client accepts either a literal expression or a
 * function of the domain's resolved physical name.
 * ### Querying Items
 * **Example:** Select All Items
 * ```typescript
 * const select = yield* AWS.SimpleDB.Select(domain);
 *
 * const result = yield* select({
 *   SelectExpression: (domain) => `select * from \`${domain}\``,
 *   ConsistentRead: true,
 * });
 * // result.Items: [{ Name: "user#123", Attributes: [...] }, ...]
 * ```
 *
 * **Example:** Select with a Where Clause
 * ```typescript
 * const result = yield* select({
 *   SelectExpression: (domain) =>
 *     `select * from \`${domain}\` where plan = 'pro'`,
 * });
 * ```
 *
 * @binding
 */
export interface Select extends Binding.Service<
  Select,
  "AWS.SimpleDB.Select",
  (
    domain: Domain,
  ) => Effect.Effect<
    (request: SelectRequest) => Effect.Effect<sdb.SelectResponse, sdb.SelectError, RuntimeContext>
  >
> {}
export const Select = Binding.Service<Select>("AWS.SimpleDB.Select");

export const SelectHttp = Layer.effect(
  Select,
  Effect.gen(function* () {
    const registerSimpleDbBinding = yield* RegisterSimpleDbBinding;
    const select = yield* AWSBindings.withCredentials(sdb.select);

    return Effect.fn(function* (domain: Domain) {
      const domainName = yield* domain.domainName;
      yield* registerSimpleDbBinding("Select", domain);
      return Effect.fn(`AWS.SimpleDB.Select(${domain.LogicalId})`)(function* (
        request: SelectRequest,
      ) {
        const { SelectExpression, ...rest } = request;
        const name = yield* domainName;
        return yield* select({
          ...rest,
          SelectExpression:
            typeof SelectExpression === "function" ? SelectExpression(name) : SelectExpression,
        });
      });
    });
  }),
);
