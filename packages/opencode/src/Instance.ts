import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/**
 * Which instance of its host a harness is running in: a Durable Object's
 * id, a machine's name. Session names are only unique within one instance,
 * so each session's sandbox is keyed on both.
 */
export class Instance extends Context.Service<
  Instance,
  {
    /**
     * This instance's id. Runs where the harness is yielded (a Durable
     * Object's outer Effect, once per instance); performs no I/O.
     */
    readonly id: Effect.Effect<string>;
  }
>()("OpenCode.Instance") {}

/**
 * A fixed instance id, for a host that is one long-lived process: a Fly
 * Machine, an ECS task, a container.
 *
 * @layer
 * @provides OpenCode.Instance
 */
export const NamedInstance = (id: string): Layer.Layer<Instance> =>
  Layer.succeed(Instance, { id: Effect.succeed(id) });
