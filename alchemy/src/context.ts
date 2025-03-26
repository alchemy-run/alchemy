import type { Resource, ResourceFQN, ResourceID } from "./resource";
import type { Scope } from "./scope";

export interface BaseContext<Out extends Resource> {
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

  create(props: Omit<Out, "Kind" | "ID" | "Scope">): Out;
  (props: Omit<Out, "Kind" | "ID" | "Scope">): Out;
}

export interface CreateContext<Out extends Resource> extends BaseContext<Out> {
  event: "create";
  output?: undefined;
}

export interface UpdateContext<Out extends Resource> extends BaseContext<Out> {
  event: "update";
  output: Out;
}

export interface DeleteContext<Out extends Resource> extends BaseContext<Out> {
  event: "delete";
  output: Out;
}

export type Context<Out extends Resource> =
  | CreateContext<Out>
  | UpdateContext<Out>
  | DeleteContext<Out>;
