import * as Operation from "./Operation.ts";

/**
 * Declare a Query: a public one-shot read. Its handler reads views
 * (or calls Ports). The class is the contract (browser-safe); implement it
 * with `toLayer`.
 *
 * **Example:** A query
 * ```typescript
 * export class StatementPage extends Query.make("statement", {
 *   input: { accountId: AccountId },
 *   output: Page,
 *   errors: [NotOwner],
 * }) {}
 * ```
 */
export const make = Operation.make("Query");
