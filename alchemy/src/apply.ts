import { alchemy } from "./alchemy";
import { DestroyedSignal } from "./destroy";
import {
  PROVIDERS,
  type PendingResource,
  type Provider,
  type ResourceProps,
} from "./resource";
import type { State } from "./state";

export interface ApplyOptions {
  quiet?: boolean;
  alwaysUpdate?: boolean;
}

export async function apply<Out>(
  resource: PendingResource<Out>,
  props: ResourceProps,
  options?: ApplyOptions,
): Promise<Awaited<Out | void>> {
  const scope = resource.Scope;
  const quiet = props.quiet ?? scope.quiet;
  const resourceFQN = scope.fqn(resource.ID);
  let state: State | undefined = (await scope.state.get(resource.ID))!;
  const provider: Provider = PROVIDERS.get(resource.ID);
  if (state === undefined) {
    state = {
      provider: PROVIDERS.get(resource.ID)!,
      status: "creating",
      data: {},
      output: undefined,
      // deps: [...deps],
      props,
    };
    await scope.state.set(resource.ID, state);
  }

  const alwaysUpdate =
    options?.alwaysUpdate ?? provider.options?.alwaysUpdate ?? false;

  // Skip update if inputs haven't changed and resource is in a stable state
  if (state.status === "created" || state.status === "updated") {
    if (
      JSON.stringify(state.props) === JSON.stringify(props) &&
      alwaysUpdate !== true
    ) {
      if (!scope.quiet) {
        console.log(`Skip:    ${resourceFQN} (no changes)`);
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
    console.log(`${event === "create" ? "Create" : "Update"}:  ${resourceFQN}`);
  }

  await scope.state.set(resource.ID, state);

  let isReplaced = false;

  const output = await alchemy.run(resource.ID, async (scope) =>
    provider.handler.bind({
      stage: scope.stage,
      resourceID: resource.ID,
      resourceFQN: resourceFQN,
      event,
      scope,
      output: state.output,
      replace: () => {
        if (isReplaced) {
          console.warn(
            `Resource ${resource.Kind} ${resourceFQN} is already marked as REPLACE`,
          );
          return;
        }
        isReplaced = true;
      },
      get: (key) => state!.data[key],
      set: async (key, value) => {
        state!.data[key] = value;
        await scope.state.set(resource.ID, state!);
      },
      delete: async (key) => {
        const value = state!.data[key];
        delete state!.data[key];
        await scope.state.set(resource.ID, state!);
        return value;
      },
      quiet: scope.quiet,
      destroy: () => {
        throw new DestroyedSignal();
      },
    })(resource.ID, props),
  );

  if (!scope.quiet) {
    console.log(
      `${event === "create" ? "Created" : "Updated"}: ${resourceFQN}`,
    );
  }

  await scope.state.set(resource.ID, {
    provider: resourceFQN,
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
