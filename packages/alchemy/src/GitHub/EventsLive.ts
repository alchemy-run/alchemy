/**
 * Event-channel physics for the {@link GitHubEvents} family — how a
 * process's `EventSource` obligations get satisfied by real
 * infrastructure, in the binding idiom.
 *
 * The chain, end to end:
 *
 * 1. Pure representation — an EventSource is pure definition data
 *    (`{ name, schema, props }`). A process-side obligation on it (a
 *    machine-observed halt — GitHub sources are world-owned, so a bare
 *    mention affords nothing) puts the `GitHubEvents` channel tag in the
 *    term's `Req`; the front door's consuming call site
 *    (`consumeRepositoryEvents`) carries the subscription obligation.
 * 2. Type-only layer requirement — nothing runs until a Layer provides
 *    `GitHubEvents`; and this Layer's own requirement on
 *    `GitHub.RepositoryEventSource` is the second, transitive compile
 *    fence (forgetting `GitHubRepositoryEventSourceLive` on the Worker
 *    also fails to type-check).
 * 3. Infrastructure — `subscribe` is the two-phase bind: at plan time
 *    the substrate binding provisions the repository `Webhook` resource
 *    (FQN-deduped) and binds the secret; at runtime it registers the
 *    signature-verifying delivery listener. Provisioning is driven by
 *    the union of *subscribed* sources' props — never a side list, so a
 *    charter subscribing to a new repo provisions its webhook by
 *    construction.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  GitHubEvents,
  type GitHubSourceProps,
  resolveSourceRepo,
} from "./Events.ts";
import { RepositoryEventSource } from "./RepositoryEventSource.ts";

export const GitHubEventsLive: Layer.Layer<
  GitHubEvents,
  never,
  RepositoryEventSource
> = Layer.effect(
  GitHubEvents,
  Effect.gen(function* () {
    // The substrate event-source binding: its Cloudflare implementation
    // (GitHubRepositoryEventSourceLive) provisions the Webhook resource
    // and claims the delivery path. This layer adds AI routing on top.
    const consume = yield* RepositoryEventSource;

    // Layer-local dedupe: one wire per (repo, bare event) — each delivery
    // path is claimed exactly once even when many sources/rings subscribe
    // to the same repo. The Webhook resource's FQN dedupe is the
    // engine-level backstop.
    const wired = new Set<string>();

    return GitHubEvents.of({
      subscribe: (source) =>
        Effect.gen(function* () {
          const props = source.props as GitHubSourceProps;
          // Resolve the source's repo FIRST (plain identity, or a
          // deferred constructor Effect): subscribe runs in the host's
          // init phase, where the deferred form's Stack context is
          // ambient.
          const repo = yield* resolveSourceRepo(props.repo);
          const wireKey = `${repo.owner}/${repo.repository}#${props.event}`;

          if (!wired.has(wireKey)) {
            wired.add(wireKey);
            // One call, two halves (the binding idiom): at plan time this
            // provisions the Webhook (FQN-deduped) + secret binding; at
            // runtime it registers the verified-delivery listener.
            yield* consume(
              { ...repo, events: [props.event] },
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
