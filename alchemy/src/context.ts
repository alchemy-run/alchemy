import { DestroyedSignal } from "./destroy";
import type {
  Resource,
  ResourceFQN,
  ResourceID,
  ResourceKind,
  ResourceProps,
} from "./resource";
import type { Scope } from "./scope";
import type { State } from "./state";

export type Context<Out extends Resource> =
  | CreateContext<Out>
  | UpdateContext<Out>
  | DeleteContext<Out>;

export interface CreateContext<Out extends Resource> extends BaseContext<Out> {
  phase: "create";
  output?: undefined;
}

export interface UpdateContext<Out extends Resource> extends BaseContext<Out> {
  phase: "update";
  output: Out;
}

export interface DeleteContext<Out extends Resource> extends BaseContext<Out> {
  phase: "delete";
  output: Out;
}

export interface BaseContext<Out extends Resource> {
  quiet: boolean;
  stage: string;
  id: ResourceID;
  fqn: ResourceFQN;
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
  /**
   * Create the Resource envelope (with Alchemy + User properties)
   */
  create(props: Omit<Out, keyof Resource>): Out;
  /**
   * Create the Resource envelope (with Alchemy + User properties)
   */
  (props: Omit<Out, keyof Resource>): Out;
}

export function context<Props extends ResourceProps, Out extends Resource>({
  scope,
  phase,
  kind,
  id,
  fqn,
  state,
  replace,
}: {
  scope: Scope;
  phase: "create" | "update" | "delete";
  kind: ResourceKind;
  id: ResourceID;
  fqn: ResourceFQN;
  state: State<Props, Out>;
  replace: () => void;
}): Context<Out> {
  function create(props: Omit<Out, "Kind" | "ID" | "Scope">): Out {
    return {
      ...props,
      Kind: kind,
      ID: id,
      FQN: fqn,
      Scope: scope,
    } as Out;
  }
  return Object.assign(create, {
    stage: scope.stage,
    scope,
    id: id,
    fqn: fqn,
    phase,
    output: state.output,
    replace,
    get: (key: string) => state.data[key],
    set: async (key: string, value: any) => {
      state.data[key] = value;
    },
    delete: async (key: string) => {
      const value = state.data[key];
      delete state.data[key];
      return value;
    },
    quiet: scope.quiet,
    destroy: () => {
      throw new DestroyedSignal();
    },
    create,
  }) as Context<Out>;
}
