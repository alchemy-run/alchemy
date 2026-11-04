/**
 * Data a declaration carries for what is built on top of a model: tool
 * lists, CLI help, API docs, diagrams, code generators. The framework reads
 * `description`; add your own keys by augmenting this interface.
 *
 * **Example:** Your own key
 * ```typescript
 * declare module "@alchemy.run/domain" {
 *   interface Annotations {
 *     readonly examples?: ReadonlyArray<unknown>;
 *   }
 * }
 *
 * export class WithdrawMoney extends Domain.Command("WithdrawMoney", {
 *   target: AccountId,
 *   input: { amount: Schema.Int },
 *   events: [MoneyWithdrawn],
 *   annotations: {
 *     description: "Take money out of an account. The amount is in cents.",
 *     examples: [{ target: "a-1", input: { amount: 2_000 } }],
 *   },
 * }) {}
 *
 * WithdrawMoney.annotations.examples;
 * ```
 */
export interface Annotations {
  /**
   * What the declaration is or does, for the people and agents who use it.
   * An Api's MCP tools and CLI help show it.
   */
  readonly description?: string;
}
