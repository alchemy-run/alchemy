import type { ResourceFQN, ResourceID } from "./resource";
import type { Scope } from "./scope";

export interface BaseContext {
  quiet: boolean;
  stage: string;
  resourceID: ResourceID;
  resourceFQN: ResourceFQN;
  scope: Scope;
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  delete<T>(key: string): Promise<T | undefined>;
  /**
   * Indicate that this resource is being replaced.
   * This will cause the resource to be deleted at the end of the stack's CREATE phase.
   */
  replace(): void;

  /**
   * Terminate the resource lifecycle handler and destroy the resource.
   *
   * This is the final operation performed during a delete operation.
   *
   * It is so that the resource lifecycle handler can "return never" instead of
   * "return undefined" so that `await MyResource()` always returns a value.
   */
  destroy(): never;
}

export interface CreateContext extends BaseContext {
  event: "create";
  output?: undefined;
}

export interface UpdateContext<Outputs> extends BaseContext {
  event: "update";
  output: Outputs;
}

export interface DeleteContext<Outputs> extends BaseContext {
  event: "delete";
  output: Outputs;
}

export type Context<Outputs> =
  | CreateContext
  | UpdateContext<Outputs>
  | DeleteContext<Outputs>;
