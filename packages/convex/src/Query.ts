import { declare } from "./internal/declare.ts";

/**
 * Declare a Convex query: its path, arguments, result and failure. A query
 * only reads, and Convex reruns it for subscribers when what it read changes.
 *
 * The declaration holds no code, so a browser, Worker or Lambda can import
 * it to call the function. Implement it with a Layer, and serve it from a
 * file in `convex/` with {@link serve}.
 *
 * ### Declaring a Function
 * **Example:** A query with typed arguments and result
 * ```typescript
 * export class ListMessages extends Convex.Query<ListMessages>()("messages:list", {
 *   args: Schema.Struct({ channel: Schema.String }),
 *   returns: Schema.Array(Messages.Document),
 * }) {}
 * ```
 *
 * ### Implementing It
 * **Example:** Read a table in the handler
 * ```typescript
 * export const ListMessagesLive = Layer.succeed(ListMessages,
 *   Effect.fn(function* ({ channel }) {
 *     return yield* Messages.query((q) =>
 *       q.withIndex("by_channel", (r) => r.eq("channel", channel)),
 *     ).collect;
 *   }),
 * );
 * ```
 *
 * ### Serving It
 * The path is the file in `convex/` and the export name.
 *
 * **Example:** `convex/messages.ts`
 * ```typescript
 * export const list = Convex.serve(ListMessages, ListMessagesLive);
 * ```
 *
 * @primitive
 * @product Functions
 */
export const Query = declare("query");
