/**
 * The org under test on the Cloudflare driver: two agents, two tools,
 * and a DETERMINISTIC model — so every assertion lands on driver
 * mechanics (run identity, durable threads, `AI.reply`, cross-DO
 * delegation, the alarm clock) instead of on model behavior.
 *
 * The model is a pure function of the prompt it is handed, which is
 * what makes it usable here: a scripted call-list would be isolate
 * state, and a Durable Object may be evicted between rounds. Reading
 * the thread instead means the model REPORTS the thread — exactly the
 * fact these tests need to observe.
 */
import * as AI from "@/AI/index.ts";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as S from "effect/Schema";
import * as Stream from "effect/Stream";
import * as LanguageModel from "effect/unstable/ai/LanguageModel";
import type * as Prompt from "effect/unstable/ai/Prompt";
import type * as Response from "effect/unstable/ai/Response";

// ── the deterministic model ──────────────────────────────────────────

/** Every user-role text in the thread, oldest first. */
const userTexts = (prompt: Prompt.Prompt): Array<string> =>
  prompt.content.flatMap((message) =>
    message.role === "user"
      ? message.content.flatMap((part) =>
          part.type === "text" ? [part.text] : [],
        )
      : [],
  );

/**
 * The prompt is the instruction set. A user message of
 * `call:<verb>:<argument>` asks for one tool call; anything else asks
 * for a report. Outstanding requests are counted against tool results
 * already in the thread, so the loop advances instead of re-calling
 * the same tool forever — and it stays STATELESS, which is what lets
 * an evicted run resume correctly.
 */
const respond = (prompt: Prompt.Prompt): Array<Response.PartEncoded> => {
  const users = userTexts(prompt);
  const requests = users.filter((text) => text.startsWith("call:"));
  const answered = prompt.content.filter(
    (message) => message.role === "tool",
  ).length;

  if (requests.length > answered) {
    const [, verb, ...rest] = requests[requests.length - 1]!.split(":");
    const argument = rest.join(":");
    switch (verb) {
      case "write":
        return [toolCall("write", { line: argument }), finish("tool-calls")];
      case "remind":
        return [
          toolCall("remind", { seconds: Number(argument) || 2 }),
          finish("tool-calls"),
        ];
      // the driver's own delegation tool — `agent` must name an agent
      // the charter mentions, `session` makes the child resumable
      case "delegate":
        return [
          toolCall("dispatch", { agent: "Scribe", task: argument }),
          finish("tool-calls"),
        ];
      case "session":
        return [
          toolCall("dispatch", {
            agent: "Scribe",
            task: argument,
            session: "s1",
          }),
          finish("tool-calls"),
        ];
      default:
        break;
    }
  }

  return [
    text(
      JSON.stringify({
        users: users.length,
        tools: answered,
        assistants: prompt.content.filter(
          (message) => message.role === "assistant",
        ).length,
        last: users[users.length - 1] ?? null,
        thread: users,
      }),
    ),
    finish(),
  ];
};

/**
 * The CRASH directive, for the durability tests: while a directive
 * `call:crash:<id>:<n>` is the last REAL user message and its budget
 * `n` is not spent, the sampling DIES — the way an eviction, deploy,
 * or defect kills a burst mid-round. Driver-authored `<note>` rows
 * (recovery notices, abandonment) are skipped when finding it, so a
 * recovery re-sample crashes again until the budget is spent — but
 * any later ordinary message (a post-mortem poll) shields it. The
 * budget is isolate memory on purpose: recovery re-enters in the same
 * isolate, and the (n+1)th sampling succeeding is exactly the
 * "transient failure" shape.
 */
const crashBudgets = new Map<string, number>();

const crashRequested = (prompt: Prompt.Prompt): string | undefined => {
  const real = userTexts(prompt).filter((text) => !text.startsWith("<note>"));
  const last = real[real.length - 1];
  const match = last?.match(/^call:crash:([^:]+):(\d+)$/);
  if (match === null || match === undefined) return undefined;
  const [, id, budget] = match;
  const used = crashBudgets.get(id!) ?? 0;
  if (used >= Number(budget)) return undefined;
  crashBudgets.set(id!, used + 1);
  return id;
};

const text = (content: string): Response.PartEncoded =>
  ({ type: "text", text: content }) as Response.PartEncoded;

const toolCall = (name: string, params: unknown): Response.PartEncoded =>
  ({
    type: "tool-call",
    id: `call-${name}`,
    name,
    params,
  }) as Response.PartEncoded;

const finish = (reason: "stop" | "tool-calls" = "stop"): Response.PartEncoded =>
  ({
    type: "finish",
    reason,
    response: undefined,
    usage: {
      inputTokens: {
        uncached: undefined,
        total: undefined,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    },
  }) as unknown as Response.PartEncoded;

export const DeterministicModel = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: (options) =>
      Effect.suspend(() => {
        const crash = crashRequested(options.prompt);
        return crash !== undefined
          ? Effect.die(new Error(`scripted crash '${crash}'`))
          : Effect.sync(() => respond(options.prompt));
      }),
    streamText: (options) => {
      const crash = crashRequested(options.prompt);
      // a DEFECT, not a failure: it skips the driver's in-round retry
      // the way an eviction would, and lands in the crash path
      return crash !== undefined
        ? Stream.fromEffect(Effect.die(new Error(`scripted crash '${crash}'`)))
        : Stream.fromIterable(respond(options.prompt).flatMap(streamed));
    },
  }),
);

/** Re-cut a whole part as the start/delta/end triple a provider streams. */
const streamed = (
  part: Response.PartEncoded,
  index: number,
): Array<Response.StreamPartEncoded> => {
  if (part.type === "text" || part.type === "reasoning") {
    const id = `part-${index}`;
    return [
      { type: `${part.type}-start`, id },
      { type: `${part.type}-delta`, id, delta: part.text },
      { type: `${part.type}-end`, id },
    ] as Array<Response.StreamPartEncoded>;
  }
  return [part as Response.StreamPartEncoded];
};

// ── the org ──────────────────────────────────────────────────────────

export const line = AI.Parameter("line", S.String)`
The line to write into the record.`;

export class Write extends (AI.Tool<Write>()("write")`
Write ${line} into the record, and hand the record back to whoever
asked for it.`) {}

/**
 * The `AI.reply` seam: the ANSWER to the round is the artifact this
 * handler produced, not the model's closing text. Replying neither
 * parks nor ends the run.
 */
export const WriteLive = Layer.succeed(Write, ((input: { line: string }) =>
  Effect.gen(function* () {
    yield* AI.reply({ wrote: input.line });
    return `wrote ${input.line}`;
  })) as never);

export const seconds = AI.Parameter("seconds", S.Int)`
How long to wait, in seconds.`;

export class Remind extends (AI.Tool<Remind>()("remind")`
Come back to this in ${seconds} — you will be woken with a note.`) {}

export const RemindLive = Layer.succeed(Remind, ((input: { seconds: number }) =>
  Effect.gen(function* () {
    const thread = yield* AI.Thread;
    yield* thread.remind(`${input.seconds} seconds`, "the timer elapsed");
    return `scheduled in ${input.seconds}s`;
  })) as never);

export class Scribe extends AI.Agent<Scribe>()("Scribe") {}

export const ScribeLive = Scribe.make(
  AI.prose`
    You keep the record. Put anything you are handed into it with
    ${Write}, and use ${Remind} when you are asked to wait.

    When you are not calling a tool, report the state of your thread.
  `,
).pipe(Layer.provide([WriteLive, RemindLive]));

export class Supervisor extends AI.Agent<Supervisor>()("Supervisor") {}

/** Mentioning ${Scribe} compiles the driver's delegation tool — whose
 *  handler RPCs into the Scribe's OWN Durable Object. */
export const SupervisorLive = Supervisor.make(
  AI.prose`
    You do no work yourself. Hand every task to ${Scribe} and report
    what came back.
  `,
);

/**
 * Every driver observation into the Worker's log, which is what makes
 * a hang legible in `wrangler tail`: the last phase logged is the
 * phase that stalled.
 */
export const LoggingObserver = Layer.succeed(AI.SessionObserver, {
  emit: (observation) =>
    Effect.log(
      `[driver] ${observation.term}/${observation.key} #${observation.seq} ${observation.type}`,
    ),
});

/**
 * The org as ONE layer, exactly as an app composes it: the agents over
 * the driver over the model. This is what the Worker provides to its
 * constructor's init effect.
 */
export const Agents = SupervisorLive.pipe(
  Layer.provideMerge(ScribeLive),
  Layer.provideMerge(Cloudflare.AI.DriverCloudflare),
  Layer.provideMerge(
    Layer.mergeAll(
      DeterministicModel,
      LoggingObserver,
      // recovery in SECONDS, not the production half-minute, so the
      // durability tests can watch the alarm re-enter a broken round
      Layer.succeed(Cloudflare.AI.DriverDurability, {
        recoverAfterMillis: 3_000,
        maxAttempts: 2,
      }),
      // the driver's own breadcrumbs are Debug — a deployed test that
      // can't be attached to is only as debuggable as its log level
      Layer.succeed(MinimumLogLevel, "Debug"),
    ),
  ),
);
