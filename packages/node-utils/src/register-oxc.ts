import {
  registerHooks,
  type LoadFnOutput,
  type ResolveFnOutput,
  type ResolveHookContext,
} from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type {
  ImportLoader,
  ImportLoaderRegistrationOptions,
} from "./import-loader.ts";
import { SourceTransformer, typeScriptSpecifier } from "./transform-source.ts";

export type {
  ImportLoader as RegisteredOxcImporter,
  ImportLoaderRegistrationOptions as RegisterOxcOptions,
  SourceTransform,
  SourceTransformResult,
  TransformContext,
} from "./import-loader.ts";

const protocol = "alchemy-import:";
const namespaceParameter = "alchemy-import-namespace";
const globalRegistrationKey = Symbol.for(
  "@alchemy.run/node-utils/register-oxc",
);

interface ImportRequest {
  readonly namespace?: string | undefined;
  readonly parentURL: string;
  readonly specifier: string;
}

const namespaceOf = (url: string | undefined) => {
  if (url === undefined || !url.startsWith("file:")) return undefined;
  return new URL(url).searchParams.get(namespaceParameter) ?? undefined;
};

const withoutNamespace = (url: string) => {
  if (!url.startsWith("file:")) return url;
  const parsed = new URL(url);
  parsed.searchParams.delete(namespaceParameter);
  return parsed.href;
};

const withNamespace = (url: string, namespace: string) => {
  const parsed = new URL(url);
  parsed.searchParams.set(namespaceParameter, namespace);
  return parsed.href;
};

const parseRequest = (specifier: string): ImportRequest | undefined => {
  if (!specifier.startsWith(protocol)) return undefined;
  return JSON.parse(decodeURIComponent(specifier.slice(protocol.length)));
};

const resolve = (
  specifier: string,
  context: ResolveHookContext,
  nextResolve: (
    specifier: string,
    context?: Partial<ResolveHookContext>,
  ) => ResolveFnOutput,
): ResolveFnOutput => {
  try {
    return nextResolve(specifier, context);
  } catch (error) {
    const alternative = typeScriptSpecifier(specifier);
    if (alternative === undefined) throw error;
    try {
      return nextResolve(alternative, context);
    } catch {
      throw error;
    }
  }
};

/**
 * Registers synchronous Node module hooks that transpile TypeScript with
 * Rolldown's Oxc transformer. A namespaced registration also provides a
 * scoped import whose namespace propagates through the complete ESM graph.
 */
export const registerOxc = (
  options: ImportLoaderRegistrationOptions = {},
): ImportLoader => {
  // One global (un-namespaced) registration per process. Alchemy starts every
  // Node process with `--import` of a file that calls this, and in-process
  // callers (the dev exec child, tests) may call it again; a second copy of
  // the hooks would only re-run the resolve chain. The marker lives on
  // globalThis because a checkout can load this module twice (src/ and lib/).
  const globalRegistration = globalThis as typeof globalThis & {
    [globalRegistrationKey]?: ImportLoader;
  };
  if (options.namespace === undefined) {
    const existing = globalRegistration[globalRegistrationKey];
    if (existing !== undefined) return existing;
  }
  const transformer = new SourceTransformer(options);
  const shouldInvalidate = options.shouldInvalidate ?? (() => true);
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      const request = parseRequest(specifier);
      const inheritedNamespace = namespaceOf(context.parentURL);
      const namespace =
        options.namespace === undefined
          ? undefined
          : (request?.namespace ?? inheritedNamespace);

      if (options.namespace !== undefined && namespace !== options.namespace) {
        return nextResolve(specifier, context);
      }

      const resolved = request
        ? resolve(
            request.specifier,
            { ...context, parentURL: request.parentURL },
            nextResolve,
          )
        : resolve(specifier, context, nextResolve);
      if (
        namespace !== undefined &&
        resolved.url.startsWith("file:") &&
        shouldInvalidate(
          withoutNamespace(resolved.url),
          context.parentURL === undefined
            ? undefined
            : withoutNamespace(context.parentURL),
        )
      ) {
        return { ...resolved, url: withNamespace(resolved.url, namespace) };
      }
      return resolved;
    },
    load(url, context, nextLoad): LoadFnOutput {
      const namespace = namespaceOf(url);
      if (options.namespace !== undefined && namespace !== options.namespace) {
        return nextLoad(url, context);
      }

      const cleanUrl = withoutNamespace(url);
      if (!cleanUrl.startsWith("file:")) return nextLoad(cleanUrl, context);
      options.onImport?.(cleanUrl);

      const filePath = fileURLToPath(cleanUrl);
      if (options.filter !== undefined && !options.filter(filePath)) {
        return nextLoad(cleanUrl, context);
      }
      const transformed = transformer.transform(filePath, cleanUrl);
      if (transformed === undefined) return nextLoad(cleanUrl, context);
      return { ...transformed, shortCircuit: true };
    },
  });

  const loader: ImportLoader = {
    import<T>(specifier: string, parentURL: string) {
      const request: ImportRequest = {
        namespace: options.namespace,
        parentURL: parentURL.startsWith("file:")
          ? parentURL
          : pathToFileURL(parentURL).href,
        specifier,
      };
      return import(
        `${protocol}${encodeURIComponent(JSON.stringify(request))}`
      ) as Promise<T>;
    },
    unregister() {
      hooks.deregister();
      if (globalRegistration[globalRegistrationKey] === loader) {
        delete globalRegistration[globalRegistrationKey];
      }
    },
  };
  if (options.namespace === undefined) {
    globalRegistration[globalRegistrationKey] = loader;
  }
  return loader;
};
