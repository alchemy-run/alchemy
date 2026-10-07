import { pathToFileURL } from "node:url";
import type { LoaderHooks } from "./hooks.ts";
import { isFileLikeSpecifier } from "./resolve.ts";

export interface NamespaceOptions {
  /**
   * Isolates one import graph in Node's module cache: every file URL the
   * graph resolves carries this namespace as a query parameter, so the same
   * files import again as fresh modules under a new namespace. This is how
   * `alchemy dev` reloads the user's stack.
   */
  readonly namespace: string;
  /** Controls which file URLs belong to the graph. */
  readonly shouldInvalidate?: ((url: string, parentURL: string | undefined) => boolean) | undefined;
  /** Called once the runtime loads a file in the graph. */
  readonly onImport?: ((url: string) => void) | undefined;
}

const parameter = "alchemy-import-namespace";

const namespaceOf = (url: string | undefined) => {
  if (url === undefined || !url.startsWith("file:")) return undefined;
  return new URL(url).searchParams.get(parameter) ?? undefined;
};

const withoutNamespace = (url: string) => {
  if (!url.startsWith("file:")) return url;
  const parsed = new URL(url);
  parsed.searchParams.delete(parameter);
  return parsed.href;
};

const withNamespace = (url: string, namespace: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set(parameter, namespace);
  return parsed.href;
};

/**
 * `hooks` scoped to one namespaced graph. A graph's entry carries the
 * namespace itself (see `importNamespaced`); everything it imports inherits
 * it from the importing module's URL. Specifiers from any other graph pass
 * straight through, and the underlying hooks never see a namespace: it is
 * stripped before they run and added back to what they resolve.
 */
export const namespaced = (hooks: LoaderHooks, options: NamespaceOptions): LoaderHooks => {
  const { namespace, shouldInvalidate = () => true, onImport } = options;
  return {
    resolve(specifier, context, nextResolve) {
      if ((namespaceOf(specifier) ?? namespaceOf(context.parentURL)) !== namespace) {
        return nextResolve(specifier, context);
      }
      const resolved = hooks.resolve(withoutNamespace(specifier), context, nextResolve);
      const parentURL =
        context.parentURL === undefined ? undefined : withoutNamespace(context.parentURL);
      if (
        resolved.url.startsWith("file:") &&
        shouldInvalidate(withoutNamespace(resolved.url), parentURL)
      ) {
        return { ...resolved, url: withNamespace(resolved.url, namespace) };
      }
      return resolved;
    },
    load(url, context, nextLoad) {
      if (namespaceOf(url) !== namespace) return nextLoad(url, context);
      const clean = withoutNamespace(url);
      onImport?.(clean);
      return hooks.load(clean, context, nextLoad);
    },
  };
};

/**
 * Imports a file as the entry of `namespace`'s graph. `specifier` is a file
 * URL, an absolute path, or a path relative to `parentURL`.
 */
export const importNamespaced = <T>(
  specifier: string,
  parentURL: string,
  namespace: string,
): Promise<T> => {
  if (!isFileLikeSpecifier(specifier)) {
    throw new Error(`Cannot import '${specifier}': expected a file URL or path.`);
  }
  const base = parentURL.startsWith("file:") ? parentURL : pathToFileURL(parentURL).href;
  const url = specifier.startsWith("file:")
    ? specifier
    : new URL(specifier.startsWith(".") ? specifier : pathToFileURL(specifier).href, base).href;
  return import(withNamespace(url, namespace)) as Promise<T>;
};
