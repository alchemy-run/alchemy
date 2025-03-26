import { alchemy } from "./alchemy";
import { context } from "./context";
import {
  PROVIDERS,
  type PendingResource,
  type Provider,
  type Resource,
  type ResourceProps,
} from "./resource";
import type { State } from "./state";

export interface ApplyOptions {
  quiet?: boolean;
  alwaysUpdate?: boolean;
}

export async function apply<Out extends Resource>(
  resource: PendingResource<Out>,
  props: ResourceProps,
  options?: ApplyOptions,
): Promise<Awaited<Out | void>> {
  const scope = resource.Scope;
  const quiet = props.quiet ?? scope.quiet;
  let state: State | undefined = (await scope.state.get(resource.ID))!;
  const provider: Provider = PROVIDERS.get(resource.ID);
  if (state === undefined) {
    state = {
      provider: PROVIDERS.get(resource.ID)!,
      status: "creating",
      data: {},
      output: undefined!,
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
      if (!quiet) {
        console.log(`Skip:    ${resource.FQN} (no changes)`);
      }
      // if (resourceState.output !== undefined) {
      //   resource[Provide](resourceState.output);
      // }
      return state.output as Awaited<Out>;
    }
  }

  const event = state.status === "creating" ? "create" : "update";
  state.status = event === "create" ? "creating" : "updating";
  state.oldProps = state.props;
  state.props = props;

  if (!quiet) {
    console.log(
      `${event === "create" ? "Create" : "Update"}:  ${resource.FQN}`,
    );
  }

  await scope.state.set(resource.ID, state);

  let isReplaced = false;

  const ctx = context({
    scope,
    event,
    kind: resource.Kind,
    id: resource.ID,
    fqn: resource.FQN,
    state,
    replace: () => {
      if (isReplaced) {
        console.warn(
          `Resource ${resource.Kind} ${resource.FQN} is already marked as REPLACE`,
        );
        return;
      }
      isReplaced = true;
    },
  });

  const output = await alchemy.run(resource.ID, async () =>
    provider.handler.bind(ctx)(resource.ID, props),
  );

  if (!quiet) {
    console.log(
      `${event === "create" ? "Created" : "Updated"}: ${resource.FQN}`,
    );
  }

  await scope.state.set(resource.ID, {
    provider: resource.Kind,
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
