import { destroy } from "./destroy";
import { Scope } from "./scope";
import { secret } from "./secret";
import type { StateStoreType } from "./state";

// TODO: support browser
const DEFAULT_STAGE = process.env.ALCHEMY_STAGE ?? process.env.USER ?? "dev";

function _alchemy(appName: string, options: Omit<AlchemyOptions, "appName">) {
  return scope(undefined, {
    ...options,
    appName,
    stage: options.stage,
  });
}
_alchemy.destroy = destroy;
_alchemy.run = run;
_alchemy.scope = scope;
_alchemy.secret = secret;

// alchemy type is to semantically highlight `alchemy` as a type (keyword)
export type alchemy = Alchemy;

export const alchemy: Alchemy = _alchemy as any;

// Alchemy is for module augmentation
export interface Alchemy {
  scope: typeof scope;
  run: typeof run;
  destroy: typeof destroy;
  secret: typeof secret;
  (...parameters: Parameters<typeof scope>): ReturnType<typeof scope>;
}

export interface AlchemyOptions {
  /**
   * The name of the application.
   */
  appName?: string;
  /**
   * Determines whether the resources will be created/updated or deleted.
   *
   * @default "up"
   */
  phase?: "up" | "destroy";
  /**
   * Name to scope the resource state under (e.g. `.alchemy/{stage}/..`).
   *
   * @default - your POSIX username
   */
  stage?: string;
  /**
   * If true, will not prune resources that were dropped from the root stack.
   *
   * @default true
   */
  destroyOrphans?: boolean;
  /**
   * A custom state store to use instead of the default file system store.
   */
  stateStore?: StateStoreType;
  /**
   * A custom scope to use as a parent.
   */
  parent?: Scope;
  /**
   * If true, will not print any Create/Update/Delete messages.
   *
   * @default false
   */
  quiet?: boolean;

  /**
   * A passphrase to use to encrypt/decrypt secrets.
   */
  password?: string;
}

/**
 * Enter a new scope synchronously.
 * @param options
 * @returns
 */
function scope(
  id: string | undefined,
  options?: AlchemyOptions,
  // TODO: maybe we want to allow using _ = await alchemy.scope(import.meta)
  // | [meta: ImportMeta]
): Scope {
  const scope = new Scope({
    ...options,
    appName: options?.appName,
    stage: options?.stage ?? DEFAULT_STAGE,
    scopeName: id,
    parent: options?.parent ?? Scope.get(),
  });
  scope.enter();
  return scope;
}

async function run<T>(
  ...args:
    | [id: string, fn: (this: Scope, scope: Scope) => Promise<T>]
    | [
        id: string,
        options: AlchemyOptions,
        fn: (this: Scope, scope: Scope) => Promise<T>,
      ]
): Promise<T> {
  const [id, options, fn] =
    typeof args[1] === "function"
      ? [args[0], undefined, args[1]]
      : (args as [
          string,
          AlchemyOptions | undefined,
          (this: Scope, scope: Scope) => Promise<T>,
        ]);
  await using scope = alchemy.scope(id, options);
  return await fn.bind(scope)(scope);
}
