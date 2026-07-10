/**
 * The org (designs/ai/org-chat.md): channels, agents, and their
 * hierarchy — all process terms. `Channel` is a USER-DEFINED kind
 * (proof of the §2.5 extension mechanism, defined here in the example,
 * not in the framework): its scaffold simulates the room and drives
 * each Post to resolution; instances only say what's specific to them.
 * The UI's sidebar is `AI.topology` over these roots — nothing below
 * is configuration.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as AI from "alchemy/AI";

// ─── shared tools ────────────────────────────────────────────────

const author = AI.Parameter("author", S.String)`who is speaking (your own name)`;
const text = AI.Parameter("text", S.String)`the message text`;
class PostReply extends AI.Tool<PostReply>()("post_reply")`
Post a reply into the Post's thread as ${author} saying ${text}. Use
this to relay each participant's contribution so the room can read it.` {}

const path = AI.Parameter("path", S.String)`repo-relative file path`;
class ReadFile extends AI.Tool<ReadFile>()("read_file")`
Read the file at ${path} from the project.` {}

// ─── the agents (DM-able members) ────────────────────────────────

export class Sage extends AI.Agent<Sage>()("Sage")`
You are Sage, the team's senior engineer. Thorough and terse; you read
code before you opine (${ReadFile}). You end with a concrete
recommendation.` {}

export class Scout extends AI.Agent<Scout>()("Scout")`
You are Scout, fast and breadth-first. You answer immediately with
your best take, clearly flagging what you're unsure about.` {}

export class Helper extends AI.Agent<Helper>()("Helper")`
You are Helper, the support specialist. Friendly, practical, you turn
user complaints into actionable summaries.` {}

// ─── the Channel kind (userland!) ────────────────────────────────

export const Channel = AI.Process("Channel", {
  charter: (name: string) => AI.charter`
You are the #${name} channel of a team workspace. A Post has arrived
(with its thread so far, if any). You are the room, not a participant:
you never answer with your own opinion.

${AI.body}

Drive the Post to completion:
1. Decide who should respond — one member for simple things, several
   (in parallel, as background runs) when the Post is both urgent and
   deep.
2. Relay every member contribution into the thread with ${PostReply}
   (author = the member's name, text = their contribution, condensed
   only if very long).
3. If one responder finishes while another is still working, you may
   steer the slow one with what was found.
4. When the Post is answered, resolve with a one-line resolution
   summary.
${AI.until(S.String)`the Post is resolved — every needed member has contributed and the resolution is posted`}
${AI.budget({ iterations: 8 })}`,
  meta: { category: "channel", icon: "hash" },
});

// ─── the channels ────────────────────────────────────────────────

export class Engineering extends Channel<Engineering>()("engineering")`
This is the engineering channel. ${Sage} (depth: architecture, code,
trade-offs) and ${Scout} (speed: quick takes, breadth) are here. Route
deep questions to Sage, quick ones to Scout, and genuinely hard ones
to both in parallel.` {}

export class Support extends Channel<Support>()("support")`
This is the user-support channel. ${Helper} handles user questions
and complaints. Escalate anything engineering-shaped by saying so in
your resolution.` {}

// ─── physics ─────────────────────────────────────────────────────

/**
 * PostReply's physics: the reply lands in the Trace via the tool's
 * `tool.completed` row (params carry author+text) — the UI renders
 * those as authored message bubbles. The handler itself just echoes.
 */
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

/** The sidebar: everything the app renders is derived from these roots. */
export const roots = [Engineering, Support, Sage, Scout, Helper];
