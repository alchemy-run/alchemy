/**
 * Event-channel physics: how the org's `EventSource` subscriptions get
 * satisfied by real infrastructure — in the binding idiom (see
 * designs/ai/reports/bindings-architecture.md).
 *
 * The chain, end to end:
 *
 * 1. Pure representation — `AI.on(Github.IssueOpened(repo))` in a charter
 *    puts the `GitHubEvents` channel tag in the loop's `Req`. The source
 *    itself is pure definition data (`{ name, schema, props }`).
 * 2. Type-only layer requirement — nothing runs until a Layer provides
 *    `GitHubEvents`; and this Layer's own requirement on
 *    `GitHub.RepositoryEventSource` is the second, transitive compile
 *    fence (forgetting `GitHubRepositoryEventSourceLive` on the Worker
 *    also fails to type-check).
 * 3. Infrastructure — `subscribe` is the two-phase bind: at plan time the
 *    substrate binding provisions the repository `Webhook` resource
 *    (FQN-deduped) and binds the secret; at runtime it registers the
 *    signature-verifying delivery listener. Provisioning is driven by the
 *    union of *subscribed* sources' props — never a side list, so a
 *    charter subscribing to a new repo provisions its webhook by
 *    construction.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as GitHub from "@/GitHub/index.ts";
import { DiscordEvents } from "../discord-events.ts";
import { GitHubEvents, type GitHubSourceProps } from "../github-events.ts";

export const GitHubEventsLive = Layer.effect(
  GitHubEvents,
  Effect.gen(function* () {
    // The substrate event-source binding: its Cloudflare implementation
    // (GitHubRepositoryEventSourceLive) provisions the Webhook resource
    // and claims the delivery path. This layer adds AI routing on top.
    const consume = yield* GitHub.RepositoryEventSource;

    // Layer-local dedupe: one wire per (repo, bare event) — each delivery
    // path is claimed exactly once even when many sources/rings subscribe
    // to the same repo. The Webhook resource's FQN dedupe is the
    // engine-level backstop.
    const wired = new Set<string>();

    return GitHubEvents.of({
      subscribe: (source) =>
        Effect.gen(function* () {
          const props = source.props as GitHubSourceProps;
          const wireKey = `${props.repo.owner}/${props.repo.repository}#${props.event}`;

          if (!wired.has(wireKey)) {
            wired.add(wireKey);
            // One call, two halves (the binding idiom): at plan time this
            // provisions the Webhook (FQN-deduped) + secret binding; at
            // runtime it registers the verified-delivery listener.
            yield* consume(
              { ...props.repo, events: [props.event] },
              (_delivery) =>
                // TODO(Phase 2): publish into the per-source hub keyed by
                // source name; subscriber streams decode through the
                // source's schema; the loop runtime admits items into its
                // ring's ledger keyed by GitHub's delivery id.
                Effect.void,
            );
          }

          // TODO(Phase 2): Stream from the per-source hub, filtered by
          // props.filter and decoded via source.schema.
          return Stream.never;
        }),
    });
  }),
);

/**
 * MOCK: a real Discord channel would hold a gateway connection (or an
 * interactions webhook) in its own DO and fan threads/mentions out the
 * same way — provisioning driven by subscribed sources' props.
 */
export const DiscordEventsLive = Layer.succeed(DiscordEvents, {
  subscribe: () => Effect.succeed(Stream.never),
});
