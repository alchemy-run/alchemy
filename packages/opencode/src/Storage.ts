import type { OpenCodeWorkerd } from "@opencode/sdk/workerd";
import type { Callbacks } from "alchemy/Callback";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Layer from "effect/Layer";
import type { OpenCodeError } from "./Errors.ts";

/** OpenCode running in this process: its own typed client. */
export type Host = OpenCodeWorkerd.Interface;

/** What the harness starts OpenCode with; where its data is kept is the storage's. */
export type HostOptions = Omit<OpenCodeWorkerd.CreateOptions, "storage">;

/** One instance's storage, and OpenCode started on it. */
export interface InstanceStorage {
  /**
   * Identifies this instance among every instance of the harness: a Durable
   * Object's id. Session names are only unique within it, so a session's
   * sandbox is keyed on both.
   */
  readonly id: string;
  /** Start OpenCode on this instance's storage. */
  readonly open: (options: HostOptions) => Effect.Effect<Host, OpenCodeError>;
  /**
   * Whether the process can be evicted while a prompt runs (a Durable
   * Object). The harness then keeps a durable alarm armed while one does,
   * and the prompt resumes when the alarm starts the instance again.
   */
  readonly evictable: boolean;
  /** The durable callbacks of an evictable instance: what the harness registers its alarms with. */
  readonly callbacks?: Layer.Layer<Callbacks>;
}

/**
 * Where a harness keeps its sessions, and so where OpenCode runs: OpenCode
 * is started in the process that owns the storage.
 */
export class Storage extends Context.Service<
  Storage,
  {
    /**
     * The storage of the instance yielding the harness. Runs where the
     * harness is yielded (a Durable Object's outer Effect, once per
     * instance); performs no I/O.
     */
    readonly instance: Effect.Effect<InstanceStorage>;
  }
>()("OpenCode.Storage") {}
