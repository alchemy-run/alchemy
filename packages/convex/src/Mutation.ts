import { declare } from "./internal/declare.ts";

/**
 * Declare a Convex mutation. A mutation reads and writes the database in one
 * transaction: a failure rolls every write back, and so does a conflict,
 * after which Convex runs it again. Side effects go through {@link schedule},
 * which commits with the writes.
 *
 * ### Declaring a Function
 * **Example:** A mutation with a typed failure
 * ```typescript
 * export class EmptyBody extends Schema.TaggedError<EmptyBody>()("EmptyBody", {}) {}
 *
 * export class AddMessage extends Convex.Mutation<AddMessage>()("messages:add", {
 *   args: Schema.Struct({ channel: Schema.String, body: Schema.String }),
 *   returns: Convex.Id("messages"),
 *   error: EmptyBody,
 * }) {}
 * ```
 *
 * ### Implementing It
 * **Example:** Insert, then schedule a follow-up
 * ```typescript
 * export const AddMessageLive = Layer.succeed(AddMessage,
 *   Effect.fn(function* ({ channel, body }) {
 *     if (body === "") return yield* new EmptyBody();
 *     const id = yield* Messages.insert({ channel, body });
 *     yield* Convex.schedule(Notify, { id });
 *     return id;
 *   }),
 * );
 * ```
 *
 * @primitive
 * @product Functions
 */
export const Mutation = declare("mutation");
