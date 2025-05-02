/**
 * Properties for creating a Durable Object Namespace
 */
export interface DurableObjectNamespaceInput {
  className: string;
  scriptName?: string | undefined;
  environment?: string | undefined;
  sqlite?: boolean | undefined;
  namespaceId?: string | undefined;
}

/**
 * @example
 * // Create a basic Durable Object namespace for stateful chat rooms
 * const rooms = new DurableObjectNamespace("chat-rooms", {
 *   className: "ChatRoom"
 * });
 *
 * @example
 * // Create a Durable Object with SQLite storage for user data
 * const users = new DurableObjectNamespace("user-store", {
 *   className: "User",
 *   sqlite: true
 * });
 *
 * @example
 * // Create a Durable Object in production for game state management
 * const game = new DurableObjectNamespace("game-state", {
 *   className: "GameState",
 *   scriptName: "game-worker",
 *   environment: "production"
 * });
 */
export class DurableObjectNamespace implements DurableObjectNamespaceInput {
  public readonly type = "durable_object_namespace" as const;
  // alias for bindingName to be consistent with other bindings
  public readonly className: string;
  public readonly scriptName?: string | undefined;
  public readonly environment?: string | undefined;
  public readonly sqlite?: boolean | undefined;
  public readonly namespaceId?: string | undefined;

  constructor(
    public readonly id: string,
    input: DurableObjectNamespaceInput,
  ) {
    this.className = input.className;
    this.scriptName = input.scriptName;
    this.environment = input.environment;
    this.sqlite = input.sqlite;
  }
}
