import { destroy } from "./destroy";
import { DEFAULT_STAGE } from "./global";
import { Scope } from "./scope";
import { secret } from "./secret";
import type { StateStoreType } from "./state";

// Alchemy is for module augmentation
export interface Alchemy {
  scope: typeof scope;
  run: typeof run;
  destroy: typeof destroy;
  secret: typeof secret;
}
// alchemy is to semantically highlight `alchemy` as a type (keyword)
export type alchemy = Alchemy;

// @ts-ignore
export const alchemy: Alchemy = {
  destroy,
  run,
  scope,
  secret,
};

export interface AlchemyOptions {
  /**
   * Determines whether the resources will be created/updated or deleted.
   *
   * @default "up"
   */
  mode?: "up" | "destroy";
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
async function scope(
  ...args:
    | [id?: string]
    | [options: AlchemyOptions]
    | [id: string | undefined, options?: AlchemyOptions]
  // TODO: maybe we want to allow await using _ = await alchemy.scope(import.meta)
  // | [meta: ImportMeta]
): Promise<Scope> {
  const [scopeName, options] =
    args.length === 2
      ? args
      : typeof args[0] === "string"
        ? [args[0], args[1]]
        : [DEFAULT_STAGE, args[0]];
  const scope = new Scope({
    ...options,
    stage: options?.stage ?? DEFAULT_STAGE,
    scopeName,
    parent: options?.parent ?? Scope.get(),
  });
  scope.enter();

  // if (parent.resources.size == 0) {
  //   await parent.init();
  // }

  return scope;
}

async function run<T>(
  ...args:
    | [fn: (this: Scope, scope: Scope) => Promise<T>]
    | [id: string, fn: (this: Scope, scope: Scope) => Promise<T>]
    | [options: AlchemyOptions, fn: (this: Scope, scope: Scope) => Promise<T>]
    | [
        id: string,
        options: AlchemyOptions,
        fn: (this: Scope, scope: Scope) => Promise<T>,
      ]
): Promise<T> {
  const [id, options, fn] =
    args.length === 3
      ? [args[0], args[1], args[2]]
      : args.length === 2
        ? typeof args[0] === "string"
          ? [args[0], undefined, args[1]]
          : [undefined, args[0], args[1]]
        : [undefined, undefined, args[0]];
  await using scope = await alchemy.scope(
    id,
    options ??
      {
        // TODO: defaults
      },
  );
  return await fn.bind(scope)(scope);
}
