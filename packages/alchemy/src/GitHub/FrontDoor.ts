/**
 * The DERIVED front door (canon §5, designs/ai/business-processes.md):
 * a **signature-driven front-door Layer** that reads a process term's
 * declared expressions and wires delivery automatically.
 *
 * Hand-rolling the webhook routing per app is boilerplate; this Layer
 * walks the term's declarations (`AI.when` sources, the
 * machine-observed exit source), provisions/consumes the wire
 * underneath ({@link consumeRepositoryEvents}), adapts payloads to the
 * catalog schemas ({@link adaptWebhookEvent}), and routes by the
 * virtual-actor rule (identity-scoped events key the run —
 * `owner/repo#number`; the first message for a key creates via `send`,
 * later ones `steer(key, …)`; keyless events always `send`).
 *
 * This does NOT reintroduce kernel auto-delivery: the Layer is
 * explicit, opt-in, world-side code you compose and can read — the
 * declarations are its *input*, the kernel remains delivery-free, and a
 * hand-written `consumeRepositoryEvents` handler remains the escape
 * hatch for custom validation/denial.
 */
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { EventSource } from "../AI/EventSource.ts";
import { isEventSource } from "../AI/EventSource.ts";
import type { Process, ProcessService } from "../AI/Process.ts";
import type { Halt } from "../AI/Signature.ts";
import { isHalt, isWhen } from "../AI/Signature.ts";
import {
  adaptWebhookEvent,
  GitHubEvents,
  type GitHubSourceProps,
  resolveRepositoryRef,
} from "./Events.ts";
import {
  consumeRepositoryEvents,
  type GitHubEventName,
  type RepositoryEventSource,
  type RepositoryRef,
} from "./RepositoryEventSource.ts";

/** A term's GitHub-backed source: channel identity first (reference
 * equality with the {@link GitHubEvents} class), falling back to the
 * props shape (a repo — plain ref or deferred Effect — plus a bare
 * event name) so a source constructed against a re-exported channel
 * class is still recognized. */
const isGitHubSource = (
  source: EventSource<any, any, any>,
): source is EventSource<any, GitHubEvents, GitHubSourceProps> => {
  if ((source.channel as unknown) === (GitHubEvents as unknown)) return true;
  const props = source.props as Partial<GitHubSourceProps> | undefined;
  return (
    props !== undefined &&
    props.repo !== undefined &&
    typeof props.event === "string"
  );
};

/**
 * The derived front door for one process term (canon §5: "the front
 * door may be DERIVED") — explicit, opt-in, world-side.
 *
 * The construction Effect runs in the host's init phase:
 *
 * 1. resolve the term's live {@link ProcessService} from context;
 * 2. walk `term.refs` for every `AI.when` source on the GitHub channel
 *    and the machine-observed halt's source (if GitHub-backed);
 * 3. group the sources by repository, union their bare event names, and
 *    call {@link consumeRepositoryEvents} ONCE per repository;
 * 4. on each delivery, adapt (transport → domain message — the
 *    anti-corruption discipline) and pick the door: issue-scoped events
 *    key the run (`owner/repo#number` — first message `send`s, later
 *    ones `steer`); keyless events `send`. The exit event is never
 *    delivered here — the kernel holds the machine-observed halt
 *    subscription through the source's channel tag. Unmatched
 *    deliveries are denial-by-skip.
 *
 * The Layer requires exactly the term's tag (the routing needs its
 * live service) and {@link RepositoryEventSource} (the wire) — both
 * compile fences ride this consuming call site, never the term.
 *
 * @example
 * ```typescript
 * const ResolveGitHubIssueLive = AI.layer(ResolveGitHubIssue).pipe(
 *   Layer.provide([TriageLive, EngineerLive, ReviewerLive, ScribeLive]),
 * );
 *
 * const OrgLive = GitHub.frontDoor(ResolveGitHubIssue).pipe(
 *   Layer.provideMerge(ResolveGitHubIssueLive),
 *   Layer.provide(GitHub.GitHubEventsLive),
 *   Layer.provide(CloudflareKernelLive),
 * );
 *
 * export default class OrgWorker extends Cloudflare.Worker<OrgWorker>()(
 *   "Org",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const issues = yield* ResolveGitHubIssue;
 *     return { fetch: HttpServerResponse.text("ok") };
 *   }).pipe(
 *     Effect.provide(OrgLive),
 *     Effect.provide(Cloudflare.Workers.GitHubRepositoryEventSourceLive),
 *   ),
 * ) {}
 * ```
 */
export const frontDoor = <
  P extends Process<any, any, any, any, any, any[], any> &
    Context.Service<any, ProcessService<any, any, any>>,
>(
  term: P,
): Layer.Layer<never, never, P["Identifier"] | RepositoryEventSource> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      // 1. the term's live ProcessService — the doors the routing opens
      const service: ProcessService<any, any, any> =
        yield* term as Effect.Effect<
          ProcessService<any, any, any>,
          never,
          P["Identifier"]
        >;

      // 2. walk the declarations: every AI.when source on the GitHub
      // channel is an accepted message this door must deliver; the
      // machine-observed halt's source names the exit event the SAME
      // wire must carry (the kernel observes it, not this door).
      const whenSources: Array<EventSource<any, any, GitHubSourceProps>> = [];
      const exitSources: Array<EventSource<any, any, GitHubSourceProps>> = [];
      for (const ref of (term as { refs: ReadonlyArray<unknown> })
        .refs as ReadonlyArray<any>) {
        if (isWhen(ref)) {
          for (const source of ref.sources) {
            if (isGitHubSource(source)) whenSources.push(source);
          }
        } else if (isHalt(ref)) {
          // a machine-observed exit (AI.exit(AI.when(...))) may carry
          // several sources — every GitHub-backed one joins the wire
          const halt = ref as Halt;
          for (const source of halt.sources ?? []) {
            if (isEventSource(source) && isGitHubSource(source)) {
              exitSources.push(source);
            }
          }
        }
      }

      // 3. one wire per repository: resolve every source's repo FIRST
      // (plain ref / yielded resource / deferred constructor Effect —
      // this init Effect runs at plan time under the Stack, where the
      // deferred form is legal), then group by the RESOLVED
      // owner/repository and union the bare event names — the same
      // dedupe rule as GitHubEventsLive (one delivery path per
      // (repo, event); the Webhook resource's FQN dedupe is the
      // engine-level backstop).
      interface RoutedSource {
        readonly ref: RepositoryRef;
        readonly source: EventSource<any, any, GitHubSourceProps>;
      }
      interface RepoGroup {
        readonly repo: RepositoryRef;
        readonly events: Set<GitHubEventName>;
        readonly whens: Array<RoutedSource>;
      }
      const groups = new Map<string, RepoGroup>();
      const groupOf = (ref: RepositoryRef): RepoGroup => {
        const key = `${ref.owner}/${ref.repository}`;
        const existing = groups.get(key);
        if (existing !== undefined) return existing;
        const created: RepoGroup = {
          repo: ref,
          events: new Set(),
          whens: [],
        };
        groups.set(key, created);
        return created;
      };
      for (const source of whenSources) {
        const ref = yield* resolveRepositoryRef(source.props.repo);
        const group = groupOf(ref);
        group.events.add(source.props.event);
        group.whens.push({ ref, source });
      }
      for (const source of exitSources) {
        // the exit's bare event joins the union so ONE webhook carries
        // both the case's inputs and its exit; it is never routed below
        const ref = yield* resolveRepositoryRef(source.props.repo);
        groupOf(ref).events.add(source.props.event);
      }

      // The virtual-actor registry (canon §5 doctrine): a key-bearing
      // source derives the case key via its own `key` — the run's world
      // identity, and provably the SAME function the kernel uses to
      // correlate the machine-observed exit to its run. First message
      // for a key creates the run (send) and records the key; later
      // ones steer the running actor. Layer-local state: one registry
      // per front door instance. (Mapping this semantic key onto the
      // kernel-minted run key — the run.admitted row's session — is the
      // durable harness's job; here the shape is the doctrine.)
      const seen = new Set<string>();

      // 4. the deterministic adapt-and-route pipeline. No model calls.
      const route = (
        source: EventSource<any, any, GitHubSourceProps>,
        item: unknown,
      ) =>
        Effect.suspend(() => {
          const key = source.key?.(item);
          // keyless sources (push, or a malformed payload) always
          // create a run
          if (key === undefined) return service.send(item);
          if (seen.has(key)) return service.steer(key, item);
          seen.add(key);
          return service.send(item);
        });

      for (const group of groups.values()) {
        yield* consumeRepositoryEvents(
          { ...group.repo, events: [...group.events] },
          (event) =>
            Effect.gen(function* () {
              // the first declared source whose event + filter matches
              // claims the delivery (declaration order — filters keep
              // catalog sources disjoint in practice)
              for (const { ref, source } of group.whens) {
                const adapted = adaptWebhookEvent(ref, source.props, event);
                if (Option.isNone(adapted)) continue;
                yield* route(source, adapted.value);
                return;
              }
              // Nothing matched. Either this is the machine exit
              // (e.g. issues.closed): the front door must NOT send or
              // steer it — the kernel holds the one machine-observed
              // halt subscription, resolved through the source's
              // channel tag (GitHubEventsLive), and delivery to parked
              // runs rides that channel's per-source hub.
              // TODO(Phase 2): that hub is not yet wired (see the TODO
              // in EventsLive.ts — subscribe currently returns
              // Stream.never), so today exits do not settle runs
              // through the derived front door.
              // Or no declaration names this delivery at all —
              // denial-by-skip, decided here in code, before anything
              // reaches a process.
            }),
        );
      }
    }),
  );
