import { alchemy } from "./alchemy.js";
import { context } from "./context.js";
import { PROVIDERS, type Provider, type Resource } from "./resource.js";
import { Scope } from "./scope.js";

export class DestroyedSignal extends Error {}

export interface DestroyOptions {
  quiet?: boolean;
  strategy?: "sequential" | "parallel";
}

function isScopeArgs(a: any): a is [scope: Scope, options?: DestroyOptions] {
  return a[0] instanceof Scope;
}

/**
 * Prune all resources from an Output and "down", i.e. that branches from it.
 */
export async function destroy<Type extends string>(
  ...args:
    | [scope: Scope, options?: DestroyOptions]
    | [resource: Resource<Type> | undefined | null, options?: DestroyOptions]
): Promise<void> {
  if (isScopeArgs(args)) {
    const [scope] = args;
    const options = {
      strategy: "sequential",
      ...(args[1] ?? {}),
    } satisfies DestroyOptions;

    // destroy all active resources
    await destroy.all(Array.from(scope.resources.values()), options);

    // then detect orphans and destroy them
    const orphans = await scope.state.all();
    await destroy.all(
      Object.values(orphans).map((orphan) => ({
        ...orphan.output,
        Scope: scope,
      })),
      options,
    );
    // finally, destroy the scope container
    await scope.deinit();
    return;
  }

  const [instance, options] = args;

  if (!instance) {
    return;
  }

  if (instance.Kind === "alchemy::Scope") {
    const scope = new Scope({
      parent: instance.Scope,
      scopeName: instance.ID,
    });
    console.log("Destroying scope", scope.chain.join("/"));
    return await destroy(scope, options);
  }

  const Provider: Provider<Type> | undefined = PROVIDERS.get(instance.Kind);
  if (!Provider) {
    throw new Error(
      `Cannot destroy resource "${instance.FQN}" type ${instance.Kind} - no provider found. You may need to import the provider in your alchemy.config.ts.`,
    );
  }

  const scope = instance.Scope;
  if (!scope) {
    console.warn(`Resource "${instance.FQN}" has no scope`);
  }
  const quiet = options?.quiet ?? scope.quiet;

  try {
    if (!quiet) {
      console.log(`Delete:  "${instance.FQN}"`);
    }

    const state = await scope.state.get(instance.ID);

    if (state === undefined) {
      return;
    }

    const ctx = context({
      scope,
      phase: "delete",
      kind: instance.Kind,
      id: instance.ID,
      fqn: instance.FQN,
      seq: instance.Seq,
      props: state.props,
      state,
      replace: () => {
        throw new Error("Cannot replace a resource that is being deleted");
      },
    });

    let nestedScope: Scope | undefined;
    try {
      // BUG: this does not restore persisted scope
      await alchemy.run(
        instance.ID,
        {
          // TODO(sam): this is an awful hack to differentiate between naked scopes and resources
          isResource: instance.Kind !== "alchemy::Scope",
          parent: scope,
        },
        async (scope) => {
          nestedScope = scope;
          return await Provider.handler.bind(ctx)(instance.ID, state.props);
        },
      );
    } catch (err) {
      if (err instanceof DestroyedSignal) {
        // TODO: should we fail if the DestroyedSignal is not thrown?
      } else {
        throw err;
      }
    }

    if (nestedScope) {
      await destroy(nestedScope, options);
    }

    await scope.delete(instance.ID);

    if (!quiet) {
      console.log(`Deleted: "${instance.FQN}"`);
    }
  } catch (error) {
    console.error(error);
    throw error;
  }
}

export namespace destroy {
  export async function all(resources: Resource[], options?: DestroyOptions) {
    if (options?.strategy !== "parallel") {
      const sorted = resources.sort((a, b) => b.Seq - a.Seq);
      for (const resource of sorted) {
        await destroy(resource, options);
      }
    } else {
      await Promise.all(
        resources.map((resource) => destroy(resource, options)),
      );
    }
  }

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
