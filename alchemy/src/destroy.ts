import { alchemy } from "./alchemy";
import { context } from "./context";
import { PROVIDERS, type Provider, type Resource } from "./resource";

export class DestroyedSignal extends Error {}

export interface DestroyOptions {
  quiet?: boolean;
}

/**
 * Prune all resources from an Output and "down", i.e. that branches from it.
 */
export async function destroy<Type extends string>(
  resource: Resource<Type> | undefined | null,
  options?: DestroyOptions,
): Promise<void> {
  if (!resource) {
    return;
  }

  const Provider: Provider<Type> | undefined = PROVIDERS.get(resource.Kind);
  if (!Provider) {
    throw new Error(
      `Cannot destroy resource type ${resource.Kind} - no provider found. You may need to import the provider in your alchemy.config.ts.`,
    );
  }

  const scope = resource.Scope;
  const quiet = options?.quiet ?? scope.quiet;

  try {
    if (!quiet) {
      console.log(`Delete:  ${resource.FQN}`);
    }

    const state = (await scope.state.get(resource.ID))!;

    if (state === undefined) {
      console.warn(`Resource ${resource.FQN} not found`);
      return;
    }

    const ctx = context({
      scope,
      event: "delete",
      kind: resource.Kind,
      id: resource.ID,
      fqn: resource.FQN,
      state,
      replace: () => {
        throw new Error("Cannot replace a resource that is being deleted");
      },
    });

    try {
      await alchemy.run(resource.ID, async () =>
        Provider.handler.bind(ctx)(resource.ID, state.oldProps!),
      );
    } catch (err) {
      // TODO: should we fail if the DestroyedSignal is not thrown?
      if (err instanceof DestroyedSignal) {
        console.log(`Destroyed: ${resource.FQN}`);
        return;
      }
      throw err;
    }

    await scope.state.delete(resource.ID);

    if (!quiet) {
      console.log(`Deleted: ${resource.FQN}`);
    }
  } catch (error) {
    console.error(error);
    throw error;
  }
}

export namespace destroy {
  export async function sequentially(
    ...resources: (Resource<string> | undefined | null)[]
  ) {
    for (const resource of resources) {
      if (resource) {
        await destroy(resource);
      }
    }
  }
}
