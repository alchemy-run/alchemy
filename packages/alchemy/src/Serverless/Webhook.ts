import * as Data from "effect/Data";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

export class ConflictingWebhookEndpoint extends Data.TaggedError(
  "ConflictingWebhookEndpoint",
)<{
  path: string;
  message: string;
}> {}

const webhookPaths = new WeakMap<object, Set<string>>();

/** Reject independent receivers competing for the same endpoint on one host. */
export const reserveWebhookPath = (host: object, path: string) =>
  Effect.gen(function* () {
    const paths = webhookPaths.get(host) ?? new Set<string>();
    if (paths.has(path)) {
      return yield* Effect.die(
        new ConflictingWebhookEndpoint({
          path,
          message: "A webhook receiver is already registered for this path.",
        }),
      );
    }
    paths.add(path);
    webhookPaths.set(host, paths);
  });

export type WebhookSubscriber<Event> = (
  event: Event,
) => Effect.Effect<void, unknown>;

/** Dispatch a verified event once to each subscriber before acknowledging it. */
export const makeWebhookDispatcher = <Event>(options?: {
  successStatus?: number;
  timeout?: Duration.Input;
}) =>
  Effect.sync(() => {
    const subscribers: WebhookSubscriber<Event>[] = [];
    return {
      subscribe: (subscriber: WebhookSubscriber<Event>) =>
        Effect.sync(() => {
          subscribers.push(subscriber);
        }),
      dispatch: (event: Event): Effect.Effect<Response> =>
        Effect.forEach(
          subscribers,
          (subscriber) =>
            Effect.suspend(() => subscriber(event)).pipe(Effect.exit),
          { concurrency: "unbounded" },
        ).pipe(
          Effect.timeout(options?.timeout ?? "30 seconds"),
          Effect.map((results) =>
            results.every(Exit.isSuccess)
              ? new Response(null, { status: options?.successStatus ?? 202 })
              : new Response("webhook processing failed", { status: 503 }),
          ),
          Effect.catchCause(() =>
            Effect.succeed(
              new Response("webhook processing failed", { status: 503 }),
            ),
          ),
        ),
    };
  });

export type WebhookDispatcher<Event> = Effect.Success<
  ReturnType<typeof makeWebhookDispatcher<Event>>
>;
