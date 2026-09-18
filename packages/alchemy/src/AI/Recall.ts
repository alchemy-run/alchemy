import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as S from "effect/Schema";
import * as Prompt from "effect/unstable/ai/Prompt";
import { renderTranscript } from "./Compaction.ts";
import { Thing, out } from "./Thing.ts";
import { Thread } from "./Thread.ts";
import { parseContextRef, ThreadStorage } from "./ThreadStorage.ts";
import { Tool } from "./Tool.ts";

const ref = Thing("ref", S.optionalKey(S.String))`
  Context ref of the generation to read — "<term>/<key>@<n>", the
  addresses your thread's lineage lists. Defaults to this session's
  tip (the live surface).`;

const from = Thing(
  "from",
  S.optionalKey(S.Int.pipe(S.check(S.isGreaterThanOrEqualTo(0)))),
)`
  Index of the first message to render (default 0).`;

const limit = Thing(
  "limit",
  S.optionalKey(S.Int.pipe(S.check(S.isGreaterThanOrEqualTo(1)))),
)`
  Maximum messages to render (default: all from \`from\`).`;

const transcript = Thing("transcript", S.String)`
  The generation's messages rendered as a plain transcript (tool
  payloads truncated), headed by the ref and the window rendered.`;

/**
 * Page RAW history that compaction shadowed — the model's time
 * machine over the generations ledger. An observation log or handoff
 * summary is deliberately lossy; when a shadowed detail matters
 * again, recall the generation that held it instead of guessing.
 */
export class Recall extends (Tool<Recall>()("recall")`
  Read RAW history that compaction shadowed: renders the messages of
  the generation at ${ref} — answers ${out(transcript)}. Use it to
  recover exact detail (paths, commands, error strings) your
  observation log or summary dropped. Window large generations with
  ${from} and ${limit}.`) {}

const MAX_CHARS = 24_000;

/** Physics over the {@link ThreadStorage} generations ledger. */
export const RecallLive: Layer.Layer<Recall, never, ThreadStorage> =
  Layer.effect(
    Recall,
    Effect.gen(function* () {
      const storage = yield* ThreadStorage;
      return Effect.fn(function* (input: {
        ref?: string;
        from?: number;
        limit?: number;
      }) {
        const thread = yield* Thread;
        const target = input.ref ?? (yield* thread.tip);
        const parsed = parseContextRef(target);
        if (parsed === undefined) {
          return {
            transcript: `'${target}' is not a context ref — expected "<term>/<key>@<n>"`,
          };
        }
        const handle = yield* storage.open(parsed.term, parsed.key);
        const rows = yield* handle.messagesAt(parsed.generation);
        if (rows.length === 0) {
          return { transcript: `no messages at ${target}` };
        }
        const start = Math.max(0, input.from ?? 0);
        const window = rows.slice(
          start,
          input.limit === undefined ? undefined : start + input.limit,
        );
        const rendered = renderTranscript(Prompt.make([...window]).content);
        const body =
          rendered.length <= MAX_CHARS
            ? rendered
            : `${rendered.slice(0, MAX_CHARS)}\n[truncated — ${rendered.length} chars total; narrow with from/limit]`;
        return {
          transcript: `${target} — messages ${start}–${start + window.length - 1} of ${rows.length}\n\n${body}`,
        };
      }) as never;
    }),
  );
