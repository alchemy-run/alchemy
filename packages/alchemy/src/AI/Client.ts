/**
 * alchemy/AI/Client — what a browser (or any client) needs to drive coding
 * agent sessions: the session schemas, the `SessionRpcs` contract to build an
 * Effect RPC client from, and the transcript adapter that folds a session's
 * events into renderable messages. No harness drivers, no Node built-ins.
 *
 * ```typescript
 * import * as AI from "alchemy/AI/Client";
 *
 * const client = yield* RpcClient.make(AI.SessionRpcs); // over a WebSocket to the session's DO
 * yield* client.events({ after: 0 }).pipe(
 *   Stream.scan(AI.emptyTranscript, AI.reduceTranscript),
 *   Stream.runForEach(render),
 * );
 * ```
 */
export * from "./Session.ts";
export { HarnessRpcs, SessionRpcs } from "./SessionRpcs.ts";
export * from "./Transcript.ts";
