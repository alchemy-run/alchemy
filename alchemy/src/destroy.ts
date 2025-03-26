import { alchemy } from "./alchemy";
import { context } from "./context";
import { PROVIDERS, type Provider, type Resource } from "./resource";
import type { Scope } from "./scope";

export class DestroyedSignal extends Error {}

export interface DestroyOptions {
  quiet?: boolean;
}

export interface DestroyScopeOptions extends DestroyOptions {
  strategy: "sequential" | "parallel";
}

declare function isScopeArgs(
  a: any,
): a is [scope: Scope, options?: DestroyScopeOptions];

/**
 * Prune all resources from an Output and "down", i.e. that branches from it.
 */
export async function destroy<Type extends string>(
  ...args:
    | [scope: Scope, options?: DestroyScopeOptions]
    | [resource: Resource<Type> | undefined | null, options?: DestroyOptions]
): Promise<void> {
  if (isScopeArgs(args)) {
    const [scope, options] = args;
    const strategy = options?.strategy ?? "sequential";

    return;
  }

  const [instance, options] = args;

  if (!instance) {
    return;
  }

  const Provider: Provider<Type> | undefined = PROVIDERS.get(instance.Kind);
  if (!Provider) {
    throw new Error(
      `Cannot destroy resource type ${instance.Kind} - no provider found. You may need to import the provider in your alchemy.config.ts.`,
    );
  }

  const scope = instance.Scope;
  const quiet = options?.quiet ?? scope.quiet;

  try {
    if (!quiet) {
      console.log(`Delete:  ${instance.FQN}`);
    }

    const state = (await scope.state.get(instance.ID))!;

    if (state === undefined) {
      console.warn(`Resource ${instance.FQN} not found`);
      return;
    }

    const ctx = context({
      scope,
      phase: "delete",
      kind: instance.Kind,
      id: instance.ID,
      fqn: instance.FQN,
      state,
      replace: () => {
        throw new Error("Cannot replace a resource that is being deleted");
      },
    });

    try {
      await alchemy.run(instance.ID, async () =>
        Provider.handler.bind(ctx)(instance.ID, state.oldProps!),
      );
    } catch (err) {
      // TODO: should we fail if the DestroyedSignal is not thrown?
      if (err instanceof DestroyedSignal) {
        console.log(`Destroyed: ${instance.FQN}`);
        return;
      }
      throw err;
    }

    await scope.state.delete(instance.ID);

    if (!quiet) {
      console.log(`Deleted: ${instance.FQN}`);
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
