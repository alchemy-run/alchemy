import * as Operation from "./Operation.ts";

/**
 * Declare a Mutation: a public write. Its handler orchestrates commands and
 * may read views. The class is the contract (browser-safe); implement it with
 * `toLayer`.
 *
 * **Example:** A mutation and its implementation
 * ```typescript
 * export class WithdrawFunds extends Mutation.make("withdraw", {
 *   input: { accountId: AccountId, amount: Cents },
 *   output: { balance: Cents },
 *   errors: [NotOpen, NotOwner, InsufficientFunds],
 * }).middleware(MfaChallenge) {}
 *
 * export const WithdrawFundsLive = WithdrawFunds.toLayer(
 *   Effect.succeed(
 *     Effect.fn(function* ({ accountId, amount }) {
 *       const { customerId } = yield* CurrentCustomer;
 *       const { reply } = yield* send(Account.ref(accountId), new Withdraw({ amount, by: customer(customerId) }));
 *       return reply;
 *     }),
 *   ),
 * );
 * ```
 */
export const make = Operation.make("Mutation");
