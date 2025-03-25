import { alchemy } from "./alchemy";
import type { Context } from "./context";
import { DestroyedSignal } from "./destroy";
import { Scope } from "./scope";
import type { State } from "./state";

const PROVIDERS = new Map<ResourceType, Provider<any, any>>();

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

// helper for semantic syntax highlighting (color as a type/class instead of function/value)
type IsClass = {
  new (_: never): never;
};

export type ResourceProps = {
  [key: string]: any;
};

export type Provider<
  Type extends string = string,
  F extends ResourceLifecycleHandler = ResourceLifecycleHandler,
> = F &
  IsClass & {
    type: Type;
  } & {
    apply(
      scope: Scope,
      resource: any, // TODO: typed
      props: ResourceProps,
    ): Promise<Awaited<ReturnType<F>> | void>;
    delete(scope: Scope, resourceID: ResourceID): Promise<void>;
  };

type ResourceLifecycleHandler = (
  this: Context<any> | void,
  id: string,
  props: any,
) => Promise<Resource<string>>;

export function Resource<
  const Type extends string,
  F extends ResourceLifecycleHandler,
>(type: Type, fn: F): Provider<Type, F>;

export function Resource<
  const Type extends string,
  F extends ResourceLifecycleHandler,
>(type: Type, options: Partial<ProviderOptions>, fn: F): Provider<Type, F>;

export function Resource<
  const Type extends ResourceType,
  F extends ResourceLifecycleHandler,
>(type: Type, ...args: [Partial<ProviderOptions>, F] | [F]): Provider<Type, F> {
  if (PROVIDERS.has(type)) {
    throw new Error(`Resource ${type} already exists`);
  }
  const [options, func] = args.length === 2 ? args : [undefined, args[0]];

  type Out = Awaited<ReturnType<F>>;

  const provider = ((
    resourceID: string,
    props: ResourceProps,
  ): Promise<Resource<string>> => {
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
    // TODO: trigger the signal on the first then
    // resource.then = (onfulfilled, onrejected) => {

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
  PROVIDERS.set(type, provider);
  return provider;

  async function apply(
    scope: Scope,
    resource: PendingResource<Out>,
    props: ResourceProps,
  ): Promise<Awaited<Out | void>> {
    let state: State | undefined = (await scope.stateStore.get(resource.id))!;
    if (state === undefined) {
      state = {
        provider: type,
        status: "creating",
        data: {},
        output: undefined,
        // deps: [...deps],
        props,
      };
      await scope.stateStore.set(resource.id, state);
    }

    // Skip update if inputs haven't changed and resource is in a stable state
    if (state.status === "created" || state.status === "updated") {
      if (
        JSON.stringify(state.props) === JSON.stringify(props) &&
        options?.alwaysUpdate !== true
      ) {
        if (!scope.quiet) {
          console.log(`Skip:    ${resource.fqn} (no changes)`);
        }
        // if (resourceState.output !== undefined) {
        //   resource[Provide](resourceState.output);
        // }
        return state.output;
      }
    }

    const event = state.status === "creating" ? "create" : "update";
    state.status = event === "create" ? "creating" : "updating";
    state.oldProps = state.props;
    state.props = props;

    if (!scope.quiet) {
      console.log(
        `${event === "create" ? "Create" : "Update"}:  ${resource.fqn}`,
      );
    }

    await scope.stateStore.set(resource.id, state);

    let isReplaced = false;

    const output = await alchemy.run(resource.id, async (scope) =>
      func.bind({
        stage: scope.stage,
        resourceID: resource.id,
        resourceFQN: resource.fqn,
        event,
        scope,
        output: state.output,
        replace: () => {
          if (isReplaced) {
            console.warn(
              `Resource ${type} ${resource.fqn} is already marked as REPLACE`,
            );
            return;
          }
          isReplaced = true;
        },
        get: (key) => state!.data[key],
        set: async (key, value) => {
          state!.data[key] = value;
          await scope.stateStore.set(resource.id, state!);
        },
        delete: async (key) => {
          const value = state!.data[key];
          delete state!.data[key];
          await scope.stateStore.set(resource.id, state!);
          return value;
        },
        quiet: scope.quiet,
        destroy: () => {
          throw new DestroyedSignal();
        },
      })(resource.id, props),
    );

    if (!scope.quiet) {
      console.log(
        `${event === "create" ? "Created" : "Updated"}: ${resource.fqn}`,
      );
    }

    await scope.stateStore.set(resource.id, {
      provider: type,
      data: state.data,
      status: event === "create" ? "created" : "updated",
      output,
      props,
      // deps: [...deps],
    });
    // if (output !== undefined) {
    //   resource[Provide](output as Out);
    // }
    return output as any;
  }

  async function _delete(scope: Scope, resourceID: ResourceID) {
    const resourceFQN = scope.fqn(resourceID);

    if (!scope.quiet) {
      console.log(`Delete:  ${resourceFQN}`);
    }

    const state = (await scope.stateStore.get(resourceID))!;

    if (state === undefined) {
      console.warn(`Resource ${resourceFQN} not found`);
      return;
    }

    try {
      await alchemy.run(resourceID, async (scope) =>
        func.bind({
          stage: scope.stage,
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
          quiet: scope.quiet,
          destroy: () => {
            throw new DestroyedSignal();
          },
        })(resourceID, state.oldProps!),
      );
    } catch (err) {
      // TODO: should we fail if the DestroyedSignal is not thrown?
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
}
