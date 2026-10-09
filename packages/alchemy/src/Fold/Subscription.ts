import * as Operation from "./Operation.ts";

/**
 * Declare a Subscription: a public live read. Its handler is an Effect that
 * returns a Stream, usually built from views with `watch`, `watchEach` and
 * `tail`. The class is the contract (browser-safe); implement it with
 * `toLayer`.
 *
 * **Example:** A subscription
 * ```typescript
 * export class AccountWatch extends Subscription.make("account", {
 *   input: { accountId: AccountId },
 *   output: AccountRow,
 *   errors: [NotOwner],
 * }) {}
 *
 * export const AccountWatchLive = AccountWatch.toLayer(
 *   Effect.gen(function* () {
 *     const summaries = yield* AccountSummary;
 *     return Effect.fn(function* ({ accountId }) {
 *       const { customerId } = yield* CurrentCustomer;
 *       return summaries.watch(Account.ref(accountId), { where: { customerId } }).pipe(...);
 *     });
 *   }),
 * );
 * ```
 */
export const make = Operation.make("Subscription");
