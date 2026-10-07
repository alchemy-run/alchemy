import * as Context from "effect/Context";

/**
 * Fully-qualified name (namespace path + logical id, see `./FQN.ts`) of the
 * resource whose lifecycle operation is running. The engine provides it next
 * to {@link import("./InstanceId.ts").InstanceId}, so helpers that run inside
 * a provider (e.g. `Bundle.build`) can key per-resource files without the
 * provider passing its identity through.
 */
export class ResourceFqn extends Context.Service<ResourceFqn, string>()("ResourceFqn") {}
