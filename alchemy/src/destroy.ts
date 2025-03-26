import { alchemy } from "./alchemy";
import { context } from "./context";
import { PROVIDERS, type Provider, type Resource } from "./resource";
import { Scope } from "./scope";

export class DestroyedSignal extends Error {}

export interface DestroyOptions {
  quiet?: boolean;
}

export interface DestroyScopeOptions extends DestroyOptions {
  strategy: "sequential" | "parallel";
}

function isScopeArgs(
  a: any,
): a is [scope: Scope, options?: DestroyScopeOptions] {
  return a[0] instanceof Scope;
}

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

    if (strategy === "sequential") {
      const resources = Array.from(scope.resources.values()).sort(
        (a, b) => a.Seq - b.Seq,
      );

      for (const resource of resources) {
        await destroy(resource);
      }
    } else {
      await Promise.all(
        Array.from(scope.resources.values()).map((resource) =>
          destroy(resource, options),
        ),
      );
    }

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
      // console.log("destroy", instance);
      console.log(`Delete:  "${instance.FQN}"`);
    }

    const state = (await scope.state.get(instance.ID))!;

    if (state === undefined) {
      console.warn(`Resource "${instance.FQN}" not found`);
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
        Provider.handler.bind(ctx)(instance.ID, state.props),
      );
    } catch (err) {
      if (err instanceof DestroyedSignal) {
        // TODO: should we fail if the DestroyedSignal is not thrown?
      } else {
        throw err;
      }
    }

    await scope.state.delete(instance.ID);

    if (!quiet) {
      console.log(`Deleted: "${instance.FQN}"`);
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
