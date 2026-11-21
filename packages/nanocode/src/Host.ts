import type { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Contracts } from "nanocode-ts";
import { NanocodeError } from "./Errors.ts";

export interface InstanceHost {
  /**
   * Identifies this instance among every instance of the harness: a Durable
   * Object's id. Session names are only unique within it.
   */
  readonly id: string;
  /** nanocode's WebAssembly module: the agent runtime itself. */
  readonly module: Effect.Effect<WebAssembly.Module, NanocodeError, RuntimeContext>;
  /** The SQL database nanocode journals every session into. */
  readonly sql: Effect.Effect<Contracts.SqlHost, NanocodeError, RuntimeContext>;
}

/**
 * What nanocode's runtime runs on: its WebAssembly module and the SQL
 * database it journals to. A platform's Layer supplies both.
 */
export class Host extends Context.Service<
  Host,
  {
    /**
     * The host of the instance yielding the harness. Runs where the
     * harness is yielded (a Durable Object's outer Effect, once per
     * instance); performs no I/O.
     */
    readonly instance: Effect.Effect<InstanceHost>;
  }
>()("Nanocode.Host") {}

/** A host for a place nanocode cannot run: every use fails with `message`. */
export const unavailable = (message: string): Layer.Layer<Host> =>
  Layer.succeed(Host, {
    instance: Effect.succeed({
      id: "",
      module: Effect.fail(new NanocodeError({ message })),
      sql: Effect.fail(new NanocodeError({ message })),
    }),
  });
