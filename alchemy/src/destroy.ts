import { defaultStage, defaultStateStore } from "./global";
import type { Output } from "./output";
import { Provider, ResourceID, isResource } from "./resource";
import { type Scope, rootScope } from "./scope";
import type { State, StateStore } from "./state";

export interface DestroyOptions {
  stage?: string;
  stateStore?: StateStore;
  scope?: Scope;
  quiet?: boolean;
}

/**
 * Prune all resources from an Output and "down", i.e. that branches from it.
 */
export async function destroy<T>(
  output: Output<T>,
  options?: DestroyOptions,
): Promise<void>;

/**
 * @internal
 */
export async function destroy<T>(
  stage: string,
  scope: Scope,
  resourceID: ResourceID,
  resourceState: State,
  resourceProvider: Provider,
  stateStore: StateStore,
  options: DestroyOptions,
): Promise<void>;

export async function destroy<T>(
  ...args:
    | [Output<T>, DestroyOptions?]
    | [string, Scope, ResourceID, State, Provider, StateStore, DestroyOptions]
): Promise<void> {
  let resourceID: ResourceID;
  let resourceState: State;
  let resourceProvider: Provider;
  let stage: string;
  let stateStore: StateStore;
  let scope: Scope | undefined = undefined;
  let options: DestroyOptions | undefined = undefined;
  if (args.length === 7) {
    stage = args[0];
    scope = args[1];
    resourceID = args[2];
    resourceState = args[3];
    resourceProvider = args[4];
    stateStore = args[5];
    options = args[6];
  } else if (isResource(args[0])) {
    const resource = args[0];
    // stage = args[1]?.stage ?? defaultStage;
    resourceID = resource[ResourceID];
    stage = args[1]?.stage ?? defaultStage;
    scope = args[1]?.scope ?? rootScope;
    const statePath = scope.getScopePath(stage);
    stateStore = args[1]?.stateStore ?? new defaultStateStore(statePath);
    // First destroy all dependencies
    const _resourceState = await stateStore.get(resourceID);
    if (_resourceState === undefined) {
      // we have no record of this resource, we must assume it's already deleted
      return;
    }
    resourceState = _resourceState;
    resourceProvider = resource[Provider];
    options = args[1];
  } else {
    console.log(args[0]);
    throw new Error("Not implemented: must handle destroy a Output chain");
  }
  await resourceProvider.delete(
    stage,
    scope,
    resourceID,
    resourceState,
    resourceState.inputs as [],
    options ?? {
      quiet: false,
    },
  );
  await stateStore.delete(resourceID);
}
