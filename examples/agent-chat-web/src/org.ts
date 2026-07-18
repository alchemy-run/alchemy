/**
 * The org (designs/ai/business-processes.md — the canon): channels,
 * agents, and their hierarchy — process terms whose sidebar is derived
 * by `AI.topology`. This example is the TUTORIAL for the resting point:
 * it shows the same "channel" three ways —
 *
 * - `#engineering` — a **deterministic** coordinator (`AI.process`,
 *   effectful-constructor form: dependencies resolve once at Layer
 *   build): a routing classifier LEAF picks members, `Effect.forEach`
 *   fans out, `ctx.post` relays, and the route decision is a **typed
 *   emit** (`ctx.emit(PostRouted, …)` — one durable Trace row AND a
 *   typed EventBus publication, granted by the bare `${PostRouted}`
 *   mention in the term). No LLM in the coordination path.
 * - `#support` — a **prose** coordinator (a `Process` charter): the
 *   rarer, open-ended form where a charter drives the room.
 * - `#issues` — a **goal** process with a **machine-observed exit**
 *   (`AI.exit(AI.when(IssueClosed), match)`): the run settles when the
 *   world closes ITS issue — the per-item `match` correlates each
 *   observed close to the run whose Post names that issue number, so
 *   concurrent runs never steal each other's exits.
 *
 * Delivery is always code (canon §5): `AI.when(PostOpened)` is a pure
 * input declaration — the server's front door (ChatSessions) validates,
 * adapts UI messages into typed `PostThread`s, and delivers explicitly
 * with `send`. Nothing here self-subscribes.
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

const PostOpened = AI.Event("workspace.post.opened", PostThread);

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

// the typed broadcast the coordinator publishes: "this Post was routed"
// — a fact other code may subscribe to. The bare ${PostRouted} mention
// on the term below IS the publish grant (canon §2a), so topology knows
// the published language
export const PostRouted = AI.Event(
  "workspace.post.routed",
  S.Struct({
    post: S.String,
    members: S.Array(S.String),
    reason: S.String,
  }),
);

// the channel term: a goal per Post (Out = the resolution). Minimal
// charter prose — its ProcessService is a handler, not a model loop.
// AI.when declares the input (types In); the bare ${PostRouted} mention
// grants the publication (the sentence carries the verb).
export class Engineering extends AI.Process<Engineering>()("engineering")`
${AI.when(PostOpened)} route it and publish ${PostRouted} with the decision.
${AI.until(S.String)`the Post is resolved`}` {}

// the effectful-constructor form (canon §2): the Effect resolves the
// classifier and members ONCE at Layer build; the returned handler
// closes over them — no per-run resolution, no model in the loop.
export const EngineeringLive = AI.process(
  Engineering,
  Effect.gen(function* () {
    const classify = yield* Classify;
    const sage = yield* Sage;
    const scout = yield* Scout;
    const members = { Sage: sage, Scout: scout } as const;

    return (post: PostThread, ctx: AI.ProcessContext) =>
      Effect.gen(function* () {
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
        // the typed emit: ONE durable Trace row + a typed EventBus
        // publication — subscribers see exactly what the Trace records
        yield* ctx.emit(PostRouted, {
          post: post.id,
          members: routed.members,
          reason: routed.reason,
        });

        // deterministic fan-out + relay — the coordination path has no LLM
        const selected = [...new Set(routed.members)];
        yield* Effect.forEach(
          selected,
          (name) =>
            ctx.run(name, members[name].dispatch(formatPost(post))).pipe(
              Effect.flatMap((answer) =>
                ctx.post(name, completedText(answer)),
              ),
            ),
          { concurrency: "unbounded" },
        );
        return `resolved by ${selected.join(", ")}`;
      });
  }),
);

// ─── #support: a PROSE coordinator (the opt-in Process charter) ──

export class Support extends AI.Process<Support>()("support")`
You are the #support channel coordinator — never a participant. Relay
${Helper}'s reply with ${PostReply} (author "Helper"), then resolve.
Escalate engineering-shaped problems by saying so in your resolution.
${AI.when(PostOpened)}
${AI.until(S.String)`the user's question is answered or escalated`}` {}

// ─── #issues: a GOAL the model resolves after closing ────────────

const issueNumber = AI.Parameter("number", S.Number)`the issue number`;
class CloseIssue extends AI.Tool<CloseIssue>()("close_issue")`
Close issue ${issueNumber} once it is resolved.` {}

// the demo keeps this model-declared (`AI.until`): the run resolves
// after the model has ACTUALLY closed the issue with its tool. The
// externally-settled shape (no halt; the component delivers the
// world's close via `settle(key, event)`) is the production pattern —
// see services/alchemy-org/src/issues.ts.
export class Issues extends AI.Process<Issues>()("issues")`
Work the issue described in the Post. If the Post explicitly says the
fix is already verified/applied, close it immediately with ${CloseIssue}
using its issue number. Otherwise investigate with ${Sage}, and close it
with ${CloseIssue} only when genuinely resolved.
${AI.when(PostOpened)}
${AI.until(S.String)`the issue is closed (close_issue succeeded) — resolve
with the issue number you closed`}` {}

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

// close_issue is demo physics: a stub acknowledging the close (a real
// deployment's tool would call the tracker's API; the run's END would
// then be delivered by the implementation Layer — settle, not a claim)
export const CloseIssueLive = Layer.succeed(CloseIssue, ((input: {
  number: number;
}) => Effect.succeed(`closed #${input.number}`)) as never);

/** The sidebar: everything the app renders is derived from these roots. */
export const roots = [Engineering, Support, Issues, Sage, Scout, Helper];
