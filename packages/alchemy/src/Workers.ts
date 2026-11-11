/**
 * The shared Durable Object and Worker runtime, for every engine that
 * hosts one (Cloudflare, Rivet).
 *
 * ```ts
 * import * as Workers from "alchemy/Workers";
 *
 * Effect.provide(Layer.mergeAll(Default, Workers.InputGate));
 * ```
 *
 * @module
 */
export { InputGate } from "./Workers/InputGate.ts";
