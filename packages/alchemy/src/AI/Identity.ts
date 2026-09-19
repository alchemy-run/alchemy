import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as LanguageModel from "effect/unstable/ai/LanguageModel";
import { RuntimeContext } from "../RuntimeContext.ts";
import { Compaction, type CompactionPolicy } from "./Compaction.ts";
import {
  observationalPolicy,
  type ObservationalOptions,
} from "./CompactionObservational.ts";
import { mintMessageId } from "./Message.ts";
import { Sessions } from "./Sessions.ts";
import { Thread } from "./Thread.ts";
import { parseContextRef, ThreadStorage } from "./ThreadStorage.ts";

/**
 * The IDENTITY seam — the userland layer that gives an agent a SELF:
 * one reserved session per term (the inner dialog) that every other
 * session of the identity journals durable learnings UP into, and
 * whose distilled observation log — the SELF DIGEST — flows back
 * DOWN to the sessions doing the work.
 *
 * No new runtime concept: the self is an ordinary durable session of
 * the SAME term under a reserved key (`"self"` by default), running
 * the agent's normal charter. What makes it self is its diet — its
 * inputs are journals (framed `[journal from <term>/<key>]`, author
 * `journal`), and its compaction is reflection-heavy: the doc of its
 * newest observational generation IS the digest.
 */
export interface IdentityService {
  /** The reserved key of `term`'s self session. */
  readonly selfKey: (term: string) => string;
  /**
   * Record one or more durable learnings to the CALLING session's
   * self — something true beyond this task (a codebase pattern, a
   * failure mode, a convention), never task state. Resolves the
   * identity from the ambient {@link Thread} (its tip ref names the
   * term and key); the entries land on the self session as one waking
   * input so it can reflect. A call from the self session itself is a
   * no-op (self never journals to self).
   */
  readonly journal: (
    learning: string | ReadonlyArray<string>,
  ) => Effect.Effect<void, never, Thread | RuntimeContext>;
  /**
   * The identity's SELF DIGEST: the doc of the self session's newest
   * observational generation (`observe`/`reflect`), with the tip ref
   * that names it — or `undefined` while the self has never compacted.
   * Read from the generations ledger ({@link ThreadStorage}) when the
   * placement shares one; otherwise from the self session's durable
   * `compaction` observations (`Sessions.history`) — the same records,
   * readable from any Worker on the Durable Object placement.
   */
  readonly digest: (
    term: string,
  ) => Effect.Effect<
    { readonly tip: string; readonly doc: string } | undefined,
    never,
    RuntimeContext
  >;
  /**
   * Deliver the current digest DOWN to one session of the identity as
   * a quiet input (`[self <tipRef>]\n<doc>`, author `self`, never a
   * wake) — the desk reads it at its next round. Deduped by tip per
   * (term, target): the same digest is never re-delivered. See
   * {@link Identity.deliverDigest} for the dedupe tradeoff.
   */
  readonly deliver: (
    term: string,
    targetKey: string,
  ) => Effect.Effect<void, never, RuntimeContext>;
}

export class Identity extends Context.Service<Identity, IdentityService>()(
  "alchemy/AI/Identity",
) {
  /**
   * The observational identity — ONE Layer providing BOTH halves:
   *
   * - the {@link Identity} service (`journal`, `digest`, `deliver`);
   * - the {@link Compaction} policy, the observational two-tier
   *   memory with its journal hook PRE-WIRED to forward the
   *   observer's `## Journal` learnings to the self session.
   *
   * Attach it on the charter Layer like any policy — and because it
   * carries the Compaction policy, do NOT also provide
   * `AI.Compaction.observational` beside it:
   *
   * ```ts
   * export const EngineerLive = Engineer.make`
   *   ...charter prose...
   * `.pipe(
   *   Layer.provide(AI.Identity.observational({ selfKey: "root::engineer::self" })),
   * );
   * ```
   *
   * The self session is a session of the same term, so this policy
   * runs there too — with `reflect` as its observer when given, and
   * with journaling disabled (learnings distilled IN the self thread
   * stay in its log's care; self never journals to self).
   */
  static readonly observational = (
    options?: IdentityOptions,
  ): Layer.Layer<Identity | Compaction, never, Sessions> =>
    observational(options);
  /** {@link IdentityService.journal} through the ambient service —
   *  what a charter's `Journal` tool calls. */
  static readonly journal = (
    learning: string | ReadonlyArray<string>,
  ): Effect.Effect<void, never, Identity | Thread | RuntimeContext> =>
    Effect.flatMap(Identity, (identity) => identity.journal(learning));
  /**
   * Deliver `term`'s digest to `targetKey` once per tip — the desk
   * loop's admission hook. The last-delivered tip per (term, target)
   * lives in the LAYER (a plain Map), not in durable storage: a
   * restarted isolate re-delivers the current tip once, which costs a
   * few duplicate quiet tokens — chosen over a PersistentRef, which
   * would couple the identity seam to a session frame and a state
   * store it otherwise never needs.
   */
  static readonly deliverDigest = (
    term: string,
    targetKey: string,
  ): Effect.Effect<void, never, Identity | RuntimeContext> =>
    Effect.flatMap(Identity, (identity) => identity.deliver(term, targetKey));
}

export interface IdentityOptions extends Omit<ObservationalOptions, "journal"> {
  /**
   * The model that authors the SELF session's observations and
   * reflections — the identity's reflector. Defaults to `observer`,
   * then to the model the self session samples with.
   */
  readonly reflect?: LanguageModel.LanguageModel;
  /**
   * Estimated-token budget (chars/4 heuristic) a delivered digest may
   * occupy at a target session — longer docs are clipped.
   * @default 4_000
   */
  readonly digestBudget?: number;
  /**
   * The reserved key of the self session, under the SAME term as the
   * sessions journaling into it. Hosts whose keys carry lineage
   * conventions pass their own shape (`"root::engineer::self"`).
   * @default "self"
   */
  readonly selfKey?: string;
}

/** Build the observational identity Layer — see
 *  {@link Identity.observational}. Not exported: `observational` is
 *  the name of the bare Compaction layer next door
 *  (CompactionObservational.ts); this one is reached as the static. */
const observational = (
  options?: IdentityOptions,
): Layer.Layer<Identity | Compaction, never, Sessions> =>
  Layer.unwrap(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      // the generations ledger when the placement shares one (the
      // local driver); absent — the Worker level of the DO placement —
      // `digest` reads the same records from durable observations
      const storage = yield* Effect.serviceOption(ThreadStorage);
      const selfKey = options?.selfKey ?? "self";
      const digestBudget = options?.digestBudget ?? 4_000;

      // journal delivery: one waking input on the self session, the
      // learnings framed with their origin so the agent's own charter
      // can process them — there is no separate self charter.
      // `RuntimeContext` is sealed the way the drivers seal their own
      // internals: delivery runs at boundaries that carry no runtime
      // color of their own.
      const sendJournal = (
        term: string,
        origin: string,
        entries: ReadonlyArray<string>,
      ): Effect.Effect<void> =>
        Effect.provide(
          sessions.send(
            term,
            selfKey,
            {
              id: mintMessageId(),
              author: "journal",
              content: `[journal from ${origin}]\n${entries
                .map((entry) => `- ${entry}`)
                .join("\n")}`,
            },
            { wake: true },
          ),
          RuntimeContext.phantom,
        );

      const journal: IdentityService["journal"] = (learning) =>
        Effect.gen(function* () {
          const entries = typeof learning === "string" ? [learning] : learning;
          if (entries.length === 0) return;
          const thread = yield* Thread;
          const origin = parseContextRef(yield* thread.tip);
          // self never journals to self — the self thread's log IS
          // its durable memory
          if (origin === undefined || origin.key === selfKey) return;
          yield* sendJournal(
            origin.term,
            `${origin.term}/${origin.key}`,
            entries,
          );
        });

      const digest: IdentityService["digest"] = (term) =>
        Effect.gen(function* () {
          if (Option.isSome(storage)) {
            const handle = yield* storage.value.open(term, selfKey);
            const lineage = yield* handle.lineage;
            const record = lineage.find(
              (candidate) =>
                candidate.kind === "observe" || candidate.kind === "reflect",
            );
            return record?.doc === undefined
              ? undefined
              : { tip: record.ref, doc: record.doc };
          }
          const observations = yield* sessions.history(term, selfKey);
          for (let index = observations.length - 1; index >= 0; index--) {
            const row = observations[index]!;
            if (
              row.type === "compaction" &&
              (row.record.kind === "observe" ||
                row.record.kind === "reflect") &&
              row.record.doc !== undefined
            ) {
              return { tip: row.record.ref, doc: row.record.doc };
            }
          }
          return undefined;
        });

      // last delivered tip per (term, target) — RAM by design, see
      // `Identity.deliverDigest`
      const delivered = new Map<string, string>();

      const deliver: IdentityService["deliver"] = (term, targetKey) =>
        Effect.gen(function* () {
          const current = yield* digest(term);
          if (current === undefined) return;
          const at = `${term}\n${targetKey}`;
          if (delivered.get(at) === current.tip) return;
          yield* sessions.send(
            term,
            targetKey,
            {
              id: mintMessageId(),
              author: "self",
              content: `[self ${current.tip}]\n${clip(current.doc, digestBudget)}`,
            },
            { wake: false },
          );
          delivered.set(at, current.tip);
        });

      // the compaction policy, routed per session: desks run the
      // observational policy with the journal hook forwarding UP; the
      // self session runs it with the reflector model and no hook
      const deskPolicy = observationalPolicy({
        ...options,
        journal: (entries, origin) =>
          origin.key === selfKey
            ? Effect.void
            : sendJournal(origin.term, `${origin.term}/${origin.key}`, entries),
      });
      const selfPolicy = observationalPolicy({
        ...options,
        ...(options?.reflect !== undefined || options?.observer !== undefined
          ? { observer: options.reflect ?? options.observer }
          : {}),
      });
      const policy: CompactionPolicy = {
        name: "observational",
        consider: (thread, model) =>
          Effect.gen(function* () {
            const origin = parseContextRef(yield* thread.tip);
            const inSelf = origin?.key === selfKey;
            return yield* (inSelf ? selfPolicy : deskPolicy).consider(
              thread,
              model,
            );
          }),
      };

      return Layer.mergeAll(
        Layer.succeed(
          Identity,
          Identity.of({ selfKey: () => selfKey, journal, digest, deliver }),
        ),
        Layer.succeed(Compaction, Compaction.of(policy)),
      );
    }),
  );

/** Clip a digest doc to its token budget (chars/4 heuristic). */
const clip = (doc: string, budget: number): string =>
  doc.length <= budget * 4
    ? doc
    : `${doc.slice(0, budget * 4)}\n[digest clipped to ${budget} tokens]`;
