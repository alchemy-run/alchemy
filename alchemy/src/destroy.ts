import { alchemy } from "./alchemy";
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

  try {
    const scope = resource.Scope;
    const resourceID = resource.ID;
    const resourceFQN = scope.getScopePath(resourceID) + "/" + resourceID;

    if (!scope.quiet) {
      console.log(`Delete:  ${resourceFQN}`);
    }

    const state = (await scope.state.get(resourceID))!;

    if (state === undefined) {
      console.warn(`Resource ${resourceFQN} not found`);
      return;
    }

    try {
      await alchemy.run(resourceID, async (scope) =>
        Provider.handler.bind({
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

    scope.state.delete(resource.ID);

    if (!scope.quiet) {
      console.log(`Deleted: ${resourceFQN}`);
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
