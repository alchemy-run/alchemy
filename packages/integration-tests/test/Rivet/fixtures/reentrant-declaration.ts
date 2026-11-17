/**
 * A Durable Object that calls back into itself, declared apart from its
 * implementation so the implementation can reach its own namespace.
 */
import * as Rivet from "@alchemy.run/rivet";
import type { RpcCallError } from "alchemy/Rpc";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import type * as Effect from "effect/Effect";

/** How a piece of work ended, and how long it took. */
export interface Outcome {
  readonly ok: boolean;
  /** The failure's tag (and HTTP status, for an RPC call), when it failed. */
  readonly error?: string;
  readonly ms: number;
}

export interface AlarmState {
  readonly runs: number;
  readonly done: number;
  readonly alarm: number | null;
}

type Run<A, E = never> = Effect.Effect<A, E, RuntimeContext>;

export interface ReentrantShape {
  ping(): Run<string>;
  read(key: string): Run<number>;
  touch(): Run<number>;
  forward(target: string): Run<number, RpcCallError>;
  constructed(): Run<Outcome | null>;
  selfCallInTransaction(): Run<Outcome>;
  peerCallInTransaction(peer: string): Run<Outcome>;
  selfPingInTransaction(): Run<Outcome>;
  selfCallOutsideTransaction(): Run<Outcome>;
  awaitReleaseInTransaction(): Run<Outcome>;
  release(): Run<Outcome>;
  writeAfterTimeout(): Run<Outcome>;
  outliveTransaction(): Run<Outcome>;
  armFlakyAlarm(failures: number): Run<void>;
  armSlowAlarm(): Run<void>;
  alarmState(): Run<AlarmState>;
  alarm(): Run<void>;
}

export class Reentrant extends Rivet.DurableObject<Reentrant, ReentrantShape>()("Reentrant") {}
