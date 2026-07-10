/**
 * The org (designs/ai/org-chat.md + reassess-proposal.md): channels,
 * agents, and their hierarchy — process terms whose sidebar is derived
 * by `AI.topology`. This example is the TUTORIAL for the reassessment:
 * it shows the same "channel" three ways —
 *
 * - `#engineering` — a **deterministic** coordinator (`AI.process`): a
 *   routing classifier LEAF picks members, `Effect.all` fans out, and
 *   `ctx.post` relays. No LLM in the coordination path (reassess §C).
 * - `#support` — a **prose** coordinator (a `Process` charter): the
 *   rarer, open-ended form where a charter drives the room (§the
 *   Process term is opt-in).
 * - `#issues` — a **goal** process with a **machine-observed exit**
 *   (`AI.until(IssueClosed)`): the run settles when the world closes
 *   the issue, not on a model claim (reassess §B).
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as AI from "alchemy/AI";

// ─── shared tools ────────────────────────────────────────────────

const author = AI.Parameter("author", S.String)`who is speaking (your own name)`;
const text = AI.Parameter("text", S.String)`the message text`;
class PostReply extends AI.Tool<PostReply>()("post_reply")`
Post a reply into the Post's thread as ${author} saying ${text}.` {}

const path = AI.Parameter("path", S.String)`repo-relative file path`;
class ReadFile extends AI.Tool<ReadFile>()("read_file")`
Read the file at ${path} from the project.` {}

// ─── the agents (DM-able members) ────────────────────────────────

export class Sage extends AI.Agent<Sage>()("Sage")`
You are Sage, the team's senior engineer. Thorough and terse; you read
code before you opine (${ReadFile}). End with a concrete recommendation.` {}

export class Scout extends AI.Agent<Scout>()("Scout")`
You are Scout, fast and breadth-first. Answer immediately with your best
take, clearly flagging what you're unsure about.` {}

export class Helper extends AI.Agent<Helper>()("Helper")`
You are Helper, the support specialist. Friendly, practical; you turn
user complaints into actionable summaries.` {}

// ─── the channel's DOMAIN input ─────────────────────────────────
//
// A Channel does not receive raw UIMessage[] / Prompt.Message[]. The
// serving adapter converts those transport values into this domain
// value before admission, and the handler is inferred as PostThread.
export const ThreadMessage = S.Struct({
  role: S.Literals(["user", "assistant"]),
  author: S.String,
  text: S.String,
});
export const PostThread = S.Struct({
  id: S.String,
  channel: S.String,
  messages: S.Array(ThreadMessage),
});
export type PostThread = typeof PostThread.Type;

const PostOpened = AI.EventSource("workspace.post.opened", PostThread);

/** Domain-owned formatting for an agent task — never generic stringify. */
const formatPost = (post: PostThread): string =>
  [
    `Post ${post.id} in #${post.channel}`,
    ...post.messages.map(
      (message) => `${message.author} (${message.role}):\n${message.text}`,
    ),
  ].join("\n\n");

const completedText = (outcome: AI.Step.HaltOutcome): string => {
  if (outcome._tag === "Completed") return outcome.text;
  throw new Error(`agent did not complete: ${outcome._tag}`);
};

// ─── #engineering: a DETERMINISTIC coordinator (AI.process) ──────

// a tiny classifier LEAF: the ONE place the coordinator consults an
// LLM, with a typed schema and a deterministic fallback (reassess §C)
const Routing = S.Struct({
  members: S.Array(S.Literals(["Sage", "Scout"])),
  reason: S.String,
});
export class Classify extends AI.Agent<Classify>()("Classify")`
You route an engineering question to the right members. Reply with ONLY
a JSON object {"members":["Sage"|"Scout"...],"reason":"…"}: Sage for
depth (architecture, code, trade-offs), Scout for speed (quick takes),
BOTH when it is urgent and deep. Never empty.` {}

// the channel term: a goal per Post (Out = the resolution). No charter —
// its ProcessService is a handler, not a model loop.
export class Engineering extends AI.Process<Engineering>()("engineering")`
${AI.on(PostOpened)}
${AI.until(S.String)`the Post is resolved`}` {}

export const EngineeringLive = AI.process(Engineering, (post, ctx) =>
  Effect.gen(function* () {
    const classify = yield* Classify;
    const sage = yield* Sage;
    const scout = yield* Scout;
    const members = { Sage: sage, Scout: scout } as const;

    // the leaf: fuzzy routing, with a deterministic fallback. The parse
    // is a TYPED failure (Effect.try), not a synchronous throw — so the
    // fallback (orElseSucceed) actually catches malformed model output
    // (code fences, prose) instead of it becoming an uncaught defect.
    const routed = yield* classify
      .dispatch(formatPost(post))
      .pipe(
        Effect.flatMap((raw) =>
          Effect.try(() => {
            const t = completedText(raw);
            const json = t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1);
            return JSON.parse(json) as unknown;
          }),
        ),
        Effect.flatMap((json) => S.decodeUnknownEffect(Routing)(json)),
        Effect.orElseSucceed(() => ({
          members: ["Scout"] as ReadonlyArray<"Sage" | "Scout">,
          reason: "fallback: default to a quick take",
        })),
      );
    yield* ctx.emit("routing", routed);

    // deterministic fan-out + relay — the coordination path has no LLM
    yield* Effect.forEach(
      routed.members,
      (name) =>
        members[name].dispatch(formatPost(post)).pipe(
          Effect.flatMap((answer) => ctx.post(name, completedText(answer))),
        ),
      { concurrency: "unbounded" },
    );
    return `resolved by ${routed.members.join(", ")}`;
  }),
);

// ─── #support: a PROSE coordinator (the opt-in Process charter) ──

export class Support extends AI.Process<Support>()("support")`
You are the #support channel coordinator — never a participant. Relay
${Helper}'s reply with ${PostReply} (author "Helper"), then resolve.
Escalate engineering-shaped problems by saying so in your resolution.
${AI.on(PostOpened)}
${AI.until(S.String)`the user's question is answered or escalated`}
${AI.budget({ iterations: 6 })}` {}

// ─── #issues: a GOAL with a MACHINE-OBSERVED exit ───────────────

export const IssueClosed = AI.EventSource(
  "github.issue.closed",
  S.Struct({ number: S.Number, by: S.String }),
);
const issueNumber = AI.Parameter("number", S.Number)`the issue number`;
class CloseIssue extends AI.Tool<CloseIssue>()("close_issue")`
Close issue ${issueNumber} once it is resolved.` {}

// the run settles when the WORLD closes the issue — not a model claim.
// The model may cause it (close_issue) or a human may.
export class Issues extends AI.Process<Issues>()("issues")`
Work the issue described in the Post. Investigate with ${Sage}, and
close it with ${CloseIssue} when genuinely resolved.
${AI.on(PostOpened)}
${AI.until(IssueClosed)}` {}

// ─── physics ─────────────────────────────────────────────────────

export const PostReplyLive = Layer.succeed(PostReply, ((input: {
  author: string;
  text: string;
}) => Effect.succeed(`posted as ${input.author}`)) as never);

export const ReadFileLive = Layer.succeed(ReadFile, ((input: {
  path: string;
}) =>
  Effect.succeed(
    `// ${input.path} (demo stub)\nexport const answer = 42;\n`,
  )) as never);

// close_issue publishes the world event — the reconciler doctrine: the
// model CAUSES it, the run settles on OBSERVING it
export const CloseIssueLive = Layer.succeed(CloseIssue, ((input: {
  number: number;
}) =>
  Effect.gen(function* () {
    const bus = yield* AI.EventBus;
    yield* bus.publish(IssueClosed, { number: input.number, by: "Sage" });
    return "closed";
  })) as never).pipe(Layer.provide(AI.EventBusMemory));

/** The sidebar: everything the app renders is derived from these roots. */
export const roots = [Engineering, Support, Issues, Sage, Scout, Helper];
