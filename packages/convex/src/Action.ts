import { declare } from "./internal/declare.ts";

/**
 * Declare a Convex action. An action may call the outside world, and calls
 * queries and mutations with {@link run}. It is not a transaction: each
 * `run` commits on its own.
 *
 * ### Declaring a Function
 * **Example:** An internal action a mutation schedules
 * ```typescript
 * export class Notify extends Convex.Action<Notify>()("messages:notify", {
 *   args: Schema.Struct({ id: Convex.Id("messages") }),
 *   internal: true,
 * }) {}
 * ```
 *
 * @primitive
 * @product Functions
 */
export const Action = declare("action");
