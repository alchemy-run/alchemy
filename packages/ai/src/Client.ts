/**
 * alchemy/AI/Client — what a browser (or any client) needs to render coding
 * agent sessions: the session schemas (to decode what your own API returns)
 * and the transcript adapter that folds a session's events into renderable
 * messages. No harness drivers, no Node built-ins.
 *
 * ```typescript
 * import * as AI from "@alchemy.run/ai/Client";
 *
 * // `events` is whatever your API streams: SSE, your own Effect RPC, …
 * yield* events.pipe(
 *   Stream.scan(AI.emptyTranscript, AI.reduceTranscript),
 *   Stream.runForEach(render),
 * );
 * ```
 */
export * from "./Session.ts";
export * from "./Transcript.ts";
