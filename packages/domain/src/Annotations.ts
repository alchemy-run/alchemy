/**
 * Data a declaration carries for what is built on top of a model: tool
 * lists, CLI help, API docs, diagrams, code generators. Every declaration
 * takes them as its last argument and keeps them as `annotations`. The
 * framework reads `description`; add your own keys by augmenting this
 * interface.
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
 * }, {
 *   description: "Take money out of an account. The amount is in cents.",
 *   examples: [{ target: "a-1", input: { amount: 2_000 } }],
 * }) {}
 *
 * WithdrawMoney.annotations.examples;
 * ```
 */
export interface Annotations {
  /**
   * What the declaration is or does, for the people and agents who use it.
   * An Api's MCP tools, CLI help and OpenAPI document show it.
   */
  readonly description?: string;
  /**
   * The `cache-control` header `toHttpApi` sends with a successful answer
   * from a query or a view's, stream's or aggregate's `get`, `peek`,
   * `snapshot` and `list`. Without it, and on every failure, live read
   * (`watch`, `events`) and command, the header is `private, no-store`.
   *
   * `private, max-age=…` lets the caller's browser keep its own answer. Use
   * `public` only for an answer that is the same for every caller: a shared
   * cache does not know the Api's middleware read a session, so it hands one
   * caller's answer to the next.
   *
   * **Example:** Exchange rates any CDN may keep for a minute
   * ```typescript
   * export class Rates extends Domain.Query("Rates", {
   *   input: { base: Schema.String },
   *   success: Rate,
   * }, { httpApiCacheControl: "public, max-age=60" }) {}
   * ```
   */
  readonly httpApiCacheControl?: string;
}
