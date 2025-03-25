import { alchemy } from "./alchemy";
import type { Context } from "./context";
import { DestroyedSignal } from "./destroy";
import { PROVIDERS } from "./global";
import { Scope } from "./scope";
import type { State } from "./state";

export type ResourceID = string;
export type ResourceFQN = string;
export type ResourceType = string;

export const ResourceID = Symbol.for("ResourceID");
export const ResourceFQN = Symbol.for("ResourceFQN");

export type PendingResource<Out = unknown> = Promise<Out> & {
  id: ResourceID;
  fqn: ResourceFQN;
  signal: () => void;
};

export interface ProviderOptions {
  /**
   * If true, the resource will be updated even if the inputs have not changed.
   */
  alwaysUpdate: boolean;
}

export interface Resource<Kind extends string = string> {
  kind: Kind;
}

export function isResource(value: any): value is Resource<any> {
  return value?.kind !== undefined;
}

const applied = new Map<Object, any>();

// helper for semantic syntax highlighting (color as a type/class instead of function/value)
type IsClass = {
  new (_: never): never;
};

export type ResourceProps = {
  [key: string]: any;
};

export type Provider<
  Type extends string,
  F extends (this: Context<any>, id: string, props: ResourceProps) => any,
> = F &
  IsClass & {
    type: Type;
  } & {
    apply(
      scope: Scope,
      resource: any, // TODO: typed
      inputs: Parameters<F>,
    ): Promise<Awaited<ReturnType<F>> | void>;
    delete(
      scope: Scope,
      resourceID: ResourceID,
      inputs: Parameters<F>,
    ): Promise<void>;
  };

export function Resource<
  const Type extends string,
  F extends (this: Context<any>, id: string, props: ResourceProps) => any,
>(type: Type, fn: F): Provider<Type, F>;

export function Resource<
  const Type extends string,
  F extends (this: Context<any>, id: string, props: ResourceProps) => any,
>(type: Type, options: Partial<ProviderOptions>, fn: F): Provider<Type, F>;

export function Resource<
  const Type extends ResourceType,
  F extends (this: Context<any>, id: string, props: ResourceProps) => any,
>(type: Type, ...args: [Partial<ProviderOptions>, F] | [F]): Provider<Type, F> {
  if (PROVIDERS.has(type)) {
    throw new Error(`Resource ${type} already exists`);
  }
  const [options, func] = args.length === 2 ? args : [undefined, args[0]];

  type Out = Awaited<ReturnType<F>>;

  const provider = ((resourceID: string, props: ResourceProps) => {
    const scope = Scope.current;

    if (scope.resources.has(resourceID)) {
      // TODO(sam): do we want to throw?
      // it's kind of awesome that you can re-create a resource and call apply
      // console.warn(`Resource ${id} already exists in the stack: ${stack.id}`);
    }

    // use a lazy promise to defer execution until a signal is received
    let _signal: () => void;
    const signal = new Promise<void>((resolve) => (_signal = resolve));

    const resource = new Promise<Out>((resolve, reject) => {
      signal.then(() =>
        apply(scope, resource, props)
          .then((value) => resolve!(value!))
          .catch(reject),
      );
    }) as PendingResource<Out>;
    resource.id = resourceID;
    resource.fqn = scope.getScopePath(resourceID) + "/" + resourceID;
    resource.signal = _signal!;

    const node = {
      provider,
      resource,
    } as const;

    scope.resources.set(resourceID, node as any);

    return resource;
  }) as Provider<Type, F>;
  provider.type = type;
  provider.apply = apply;
  provider.delete = _delete;

  async function apply(
    scope: Scope,
    resource: PendingResource<Out>,
    props: ResourceProps,
  ): Promise<Awaited<Out | void>> {
    let resourceState: State = (await scope.stateStore.get(resource.id))!;
    if (resourceState === undefined) {
      resourceState = {
        provider: type,
        status: "creating",
        data: {},
        output: undefined,
        deps: [...deps],
        inputs: props,
      };
      await scope.stateStore.set(resource.id, resourceState);
    }

    // Skip update if inputs haven't changed and resource is in a stable state
    if (
      resourceState.status === "created" ||
      resourceState.status === "updated"
    ) {
      if (
        JSON.stringify(resourceState.inputs) === JSON.stringify(props) &&
        options?.alwaysUpdate !== true
      ) {
        if (!scope.quiet) {
          console.log(`Skip:    ${resourceFQN} (no changes)`);
        }
        if (resourceState.output !== undefined) {
          resource[Provide](resourceState.output);
        }
        return resourceState.output;
      }
    }

    const event = resourceState.status === "creating" ? "create" : "update";
    resourceState.status = event === "create" ? "creating" : "updating";
    resourceState.oldInputs = resourceState.inputs;
    resourceState.inputs = props;

    if (!scope.quiet) {
      console.log(
        `${event === "create" ? "Create" : "Update"}:  ${resourceFQN}`,
      );
    }

    await scope.stateStore.set(resource.id, resourceState);

    let isReplaced = false;

    const quiet = options.quiet ?? false;

    await alchemy.run(async () =>
      func.bind({
        stage,
        resourceID,
        resourceFQN,
        event,
        scope: getScope(),
        output: resourceState.output,
        replace: () => {
          if (isReplaced) {
            console.warn(
              `Resource ${type} ${resourceFQN} is already marked as REPLACE`,
            );
            return;
          }
          isReplaced = true;
        },
        get: (key) => resourceState!.data[key],
        set: async (key, value) => {
          resourceState!.data[key] = value;
          await scope.stateStore.set(resource.id, resourceState!);
        },
        delete: async (key) => {
          const value = resourceState!.data[key];
          delete resourceState!.data[key];
          await scope.stateStore.set(resource.id, resourceState!);
          return value;
        },
        quiet,
        destroy: () => {
          throw new DestroyedSignal();
        },
      })(resourceID, props),
    );

    if (!scope.quiet) {
      console.log(
        `${event === "create" ? "Created" : "Updated"}: ${resourceFQN}`,
      );
    }
    await stateStore.set(resourceID, {
      provider: type,
      data: resourceState.data,
      status: event === "create" ? "created" : "updated",
      output: evaluated,
      inputs: props,
      deps: [...deps],
    });
    if (evaluated !== undefined) {
      resource[Provide](evaluated as Out);
    }
    return evaluated as Awaited<Out>;
  }

  async function _delete(
    scope: Scope,
    resourceID: ResourceID,
    inputs: Parameters<F>,
  ) {
    const { Scope } = await import("./scope");
    const resourceFQN = `${scope.getScopePath(stage)}/${resourceID}`;
    const nestedScope = new Scope(resourceID, scope);

    await alchemize({
      mode: "destroy",
      stage,
      scope: nestedScope,
      // TODO(sam): should use the appropriate state store
      stateStore: defaultStateStore,
      quiet: options.quiet,
    });

    if (!scope.quiet) {
      console.log(`Delete:  ${resourceFQN}`);
    }

    try {
      await func.bind({
        stage,
        scope,
        resourceID,
        resourceFQN,
        event: "delete",
        output: state.output,
        replace() {
          throw new Error("Cannot replace a resource that is being deleted");
        },
        get: (key) => {
          return state.data[key];
        },
        set: async (key, value) => {
          state.data[key] = value;
        },
        delete: async (key) => {
          const value = state.data[key];
          delete state.data[key];
          return value;
        },
        quiet: options.quiet ?? false,
        destroy: () => {
          throw new DestroyedSignal();
        },
      })(resourceID, ...inputs);
    } catch (err) {
      if (err instanceof DestroyedSignal) {
        console.log(`Destroyed: ${resourceFQN}`);
        return;
      }
      throw err;
    }

    if (!scope.quiet) {
      console.log(`Deleted: ${resourceFQN}`);
    }
  }
  PROVIDERS.set(type, Resource as any);
  return Resource as any;
}
