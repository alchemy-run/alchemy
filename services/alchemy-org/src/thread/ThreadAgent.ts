import * as AI from "alchemy/AI";
import * as Git from "alchemy/Git";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as S from "effect/Schema";
import { parseEntityRef } from "../channel/Channel.ts";
import { Engineer } from "../coding/Engineer.ts";
import { BadRef, makeEntityLookup } from "../github/Entity.ts";
import { SessionRepo } from "../github/SessionRepo.ts";
import { pullWorktreeKey, THREAD_TERM, Threads } from "./Threads.ts";

/**
 * The THREAD AGENT — one durable session per thread (`t-<id>`), the
 * task's whole life; the thread's conversation IS this session's
 * transcript. It governs a set of GitHub entities, one machine with a
 * worktree per pull request, and the engineers it kicks off. Its
 * engineers act on GitHub DIRECTLY: they push to the pull requests the
 * thread governs and open new ones to solve issues — there is no
 * approval gate.
 */
export class ThreadAgent extends AI.Agent<ThreadAgent>(import.meta)(
  THREAD_TERM,
) {}

/* ── vocabulary ─────────────────────────────────────────────────── */

const ref = AI.Thing("ref", S.String)`
  A GitHub entity, fully qualified — "owner/repo#832".`;

const kind = AI.Thing("kind", S.Literals(["issue", "pull"]))`
  What the ref is: "issue" or "pull".`;

const entityTitle = AI.Thing("title", S.String)`
  The entity's title, as GitHub has it.`;

const brief = AI.Thing("brief", S.String)`
  The subagent's whole world: what to do, where (name the worktree
  path when one applies), what "done" looks like, what to avoid.`;

const cardTitle = AI.Thing("title", S.String)`
  The card's one-line headline — what the operator reads in the channel.`;

const text = AI.Thing("text", S.String)`
  The text, complete and self-contained. Markdown.`;

const why = AI.Thing("why", S.String)`
  One or two sentences of justification the operator can check.`;

const path = AI.Thing("path", S.String)`
  The worktree's absolute path on this thread's machine.`;

const branch = AI.Thing("branch", S.String)`
  The branch the worktree has checked out.`;

const agentKey = AI.Thing("agent", S.String)`
  The subagent's session key — its address for attach/terminal.`;

const report = AI.Thing("report", S.String)`
  The subagent's settled outcome, verbatim (clipped).`;

const state = AI.Thing(
  "state",
  S.Struct({
    id: S.String,
    name: S.String,
    title: S.String,
    status: S.Literals(["open", "closed"]),
    turn: S.Literals(["you", "agents", "others", "idle"]),
    entities: S.Array(
      S.Struct({
        ref: S.String,
        kind: S.Literals(["issue", "pull"]),
        state: S.String,
        title: S.String,
        worktree: S.optionalKey(S.String),
      }),
    ),
    agents: S.Array(
      S.Struct({
        key: S.String,
        kind: S.String,
        brief: S.String,
        state: S.Literals(["running", "done", "failed", "stopped"]),
      }),
    ),
  }),
)`
  This thread's full state: meta (name, title, status, whose turn), the
  GitHub entities it governs (with their worktrees), and its subagents.`;

/* ── declared failures ──────────────────────────────────────────── */

class NotAttached extends Data.TaggedError("NotAttached")<{
  message: string;
}> {}
class CheckoutFailed extends Data.TaggedError("CheckoutFailed")<{
  message: string;
}> {}

/** A short unique suffix for subagent session keys. */
const shortId = (): string => crypto.randomUUID().slice(0, 8);

export const ThreadAgentLive = ThreadAgent.make(
  Effect.gen(function* () {
    // ── INIT: once per thread ────────────────────────────────────────
    const threads = yield* Threads;
    const sessionRepo = yield* SessionRepo;
    const checkouts = yield* Git.Checkouts;
    const engineer = yield* Engineer;
    const thread = yield* AI.Thread;
    const id = thread.key;
    const session = { term: THREAD_TERM, key: id };

    const current = Effect.gen(function* () {
      const state = yield* threads.get(id);
      return (
        state ??
        (yield* Effect.die(`thread ${id}: the ThreadDO was never initialized`))
      );
    });

    // an attach is VERIFIED against GitHub, never taken on the model's word
    const lookup = yield* makeEntityLookup;

    const attach = yield* AI.Tool("attach")`
      Attach ${ref} to this thread — you govern it from now on: its
      events arrive here, closing the thread settles it. The ref is
      looked up on GitHub; answers ${AI.out(kind, entityTitle)} as
      GitHub has them. Fails with ${BadRef} when the ref is not
      "owner/repo#N", names a repository that is not connected, or
      does not exist — copy refs from the channel's links, never
      derive them from an author's login.`(
      Effect.fn(function* (p: { ref: string }) {
        const entity = yield* lookup(p.ref);
        yield* threads.attach(id, [entity]);
        return { kind: entity.kind, title: entity.title };
      }),
    );

    const detach = yield* AI.Tool("detach")`
      Detach ${ref} from this thread — its events stop arriving; the
      entity itself is untouched.`(
      Effect.fn(function* (p: { ref: string }) {
        yield* threads.detach(id, p.ref);
      }),
    );

    const worktree = yield* AI.Tool("worktree")`
      Ensure a WORKTREE for pull request ${ref} on this thread's
      machine — its head branch, fetched fresh, checked out as its own
      tree. Answers ${AI.out(path, branch)}; subagents you spawn
      should be told to work there. Fails with ${BadRef} for a ref
      that is not a pull request of a connected repository,
      ${NotAttached} when it is not attached here, ${CheckoutFailed}
      when git refuses.`(
      Effect.fn(function* (p: { ref: string }) {
        const parsed = parseEntityRef(p.ref);
        if (parsed === undefined) {
          return yield* Effect.fail(
            new BadRef({ message: `${p.ref} is not owner/repo#N` }),
          );
        }
        const state = yield* current;
        if (!state.entities.some((e) => e.ref === p.ref)) {
          return yield* Effect.fail(
            new NotAttached({
              message: `${p.ref} is not attached — attach first`,
            }),
          );
        }
        const tree = yield* sessionRepo
          .resolve(p.ref)
          .pipe(Effect.mapError((message) => new BadRef({ message })));
        if (tree === undefined || tree.pull === undefined) {
          return yield* Effect.fail(
            new BadRef({
              message: `${p.ref} is not a pull request of a connected repository`,
            }),
          );
        }
        const key = pullWorktreeKey(id, parsed.number);
        const checkout = yield* checkouts
          .checkout({
            key,
            remote: tree.remote,
            ref: tree.pull.ref,
            fresh: true,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new CheckoutFailed({
                  message:
                    error._tag === "Git.GitError"
                      ? error.stderr
                      : String(error),
                }),
            ),
          );
        yield* threads.setWorktree(id, p.ref, checkout.path);
        return { path: checkout.path, branch: checkout.branch };
      }),
    );

    const spawn = yield* AI.Tool("spawn")`
      Kick off an ENGINEER subagent with ${brief} — its own session on
      this thread's machine, full editor, push and pull-request tools
      that act on GitHub directly. The call returns when it settles —
      answers ${AI.out(agentKey, report)}; you stay the point of
      contact. Name the worktree path in the brief when the work
      belongs to one pull request.`(
      Effect.fn(function* (p: { brief: string }) {
        const key = `${id}::e-${shortId()}`;
        const startedAt = Date.now();
        yield* threads.agentUpsert(id, {
          key,
          kind: "engineer",
          brief: p.brief,
          state: "running",
          startedAt,
        });
        // an UPDATE, not an upsert: an agent the operator deleted while
        // this dispatch was in flight must not come back as a row
        const settle = (state: "done" | "failed" | "stopped") =>
          threads.agentSettle(id, key, state, Date.now());
        const outcome = yield* engineer
          .dispatch(p.brief, { key, parent: session })
          .pipe(Effect.onError(() => settle("failed")));
        // the operator's off switch answers the dispatch with the
        // Stopped outcome — the books say stopped, not done
        yield* settle(
          Predicate.hasProperty(outcome, "_tag") && outcome._tag === "Stopped"
            ? "stopped"
            : "done",
        );
        return {
          agent: key,
          report: (JSON.stringify(outcome) ?? "").slice(0, 2000),
        };
      }),
    );

    const postCard = yield* AI.Tool("post_card")`
      Post a CARD to the main channel — the one sanctioned way to
      reach the operator there: ${cardTitle} and ${text}. Use it when
      the thread needs them (a question only they can answer, work
      that landed and is worth a look), not as a log.`(
      Effect.fn(function* (p: { title: string; text: string }) {
        yield* threads.postCard(id, { title: p.title, text: p.text });
      }),
    );

    const closeThread = yield* AI.Tool("close_thread")`
      Close this thread with ${why} — the task is done or will not be
      done. Make sure the work itself already landed (pushed, pull
      requests opened); closing the thread is bookkeeping, not a
      write.`(
      Effect.fn(function* (p: { why: string }) {
        yield* threads.postCard(id, {
          title: `thread closed — ${p.why}`,
          text: p.why,
        });
        yield* threads.close(id);
      }),
    );

    const readState = yield* AI.Tool("read_state")`
      Read this thread's fresh ${AI.out(state)} from the org's books.
      The conversation already carries all of it as it happened; call
      this for a snapshot instead of scrolling back.`(
      Effect.fn(function* () {
        const found = yield* current;
        return {
          state: {
            id: found.id,
            name: found.name,
            title: found.title,
            status: found.status,
            turn: found.turn,
            entities: found.entities,
            agents: found.agents.map((a) => ({
              key: a.key,
              kind: a.kind,
              brief: a.brief,
              state: a.state,
            })),
          },
        };
      }),
    );

    // ── the STANCE: STATIC — one prompt for the session's whole life.
    // Never splice mutable state here: a stance that changes between
    // samplings busts the provider's prompt cache on every call. The
    // conversation history carries what happened; ${readState} answers
    // what is.
    return AI.fragment`
      You govern ONE thread — a task over a set of GitHub entities
      (issues, pull requests, possibly across repositories). This
      session is the thread's whole conversation: the operator
      speaks to you here, GitHub events for your entities arrive
      here (prefixed by their payload), and your subagents report
      back here. You OWN the work end to end: your engineers push
      commits to the pull requests you govern and open new pull
      requests to solve issues — directly, no approval step. You
      never post review comments or feedback for humans to act on;
      you do the work instead.

      This thread is ${id}. The conversation is its record — what you
      attached, spawned, and were told all happened here. ${readState}
      answers the current books (entities, worktrees, subagents) when
      you need a snapshot.

      Your machine is one sandbox for the whole thread. Each pull
      request you govern gets its OWN worktree (${worktree}); tell
      every subagent which tree to work in. ${spawn} runs an
      engineer to completion and hands you its report. ${attach}
      and ${detach} change what you govern — the moment an engineer
      reports a pull request it opened, ${attach} it: an unattached
      pull has no review tab and its GitHub events route nowhere.
      ${postCard} is the one way to reach the operator in the channel
      — use it when work landed or you are blocked on them, never as
      a log. ${closeThread} when the task is done.

      Keep replies short and factual; the operator reads this
      conversation as the thread's record. Name every issue and pull
      request — in replies and in cards — as a full markdown link to
      its GitHub URL ("[owner/repo#832](https://github.com/owner/repo/pull/832)",
      /issues/ for issues), never a bare "#832": the channel renders
      those links with a hover card.`;
  }),
);
