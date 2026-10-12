import * as Operation from "./Operation.ts";

/**
 * Declare a Subscription: a public live read. Its handler is an Effect that
 * returns a Stream, usually built from views with `watch`, `watchEach` and
 * `events`. The class is the contract (browser-safe); implement it with
 * `toLayer`. The handler may use what the subscription's middleware provides.
 *
 * **Example:** A subscription
 * ```typescript
 * import { Subscription } from "alchemy/Fold";
 * import * as Effect from "effect/Effect";
 * import * as Option from "effect/Option";
 * import * as Stream from "effect/Stream";
 * import { Account } from "../Account/Account.ts";
 * import { AccountId } from "../Account/AccountId.ts";
 * import { AccountSummary } from "../Account/AccountSummary.ts";
 * import { NotOwner } from "../Account/NotOwner.ts";
 * import { currentCustomerId } from "../CurrentActor.ts";
 * import { AccountRow } from "./AccountRow.ts";
 * import { CustomerSession } from "./CustomerSession.ts";
 *
 * export class AccountWatch extends Subscription.make("account", {
 *   input: { accountId: AccountId },
 *   output: AccountRow,
 *   errors: [NotOwner],
 * }).middleware(CustomerSession) {}
 *
 * export const AccountWatchLive = AccountWatch.toLayer(
 *   Effect.gen(function* () {
 *     const summaries = yield* AccountSummary;
 *     return Effect.fn(function* ({ accountId }) {
 *       const customerId = yield* currentCustomerId;
 *       return summaries.watch(Account.ref(accountId), { where: { customerId } }).pipe(
 *         Stream.mapEffect(
 *           Option.match({
 *             onNone: () => Effect.fail(new NotOwner()),
 *             onSome: (a) =>
 *               Effect.succeed({ accountId, owner: a.owner ?? "", balance: a.balance, frozen: a.frozen }),
 *           }),
 *         ),
 *       );
 *     });
 *   }),
 * );
 * ```
 */
export const make = Operation.make("Subscription");
