import fs from "node:fs/promises";
import path from "node:path";

import { DestroyedSignal, destroy } from "./destroy";
import { Scope } from "./scope";
import { secret } from "./secret";
import type { StateStoreType } from "./state";

// TODO: support browser
const DEFAULT_STAGE = process.env.ALCHEMY_STAGE ?? process.env.USER ?? "dev";

/**
 * Type alias for semantic highlighting of `alchemy` as a type keyword
 */
export type alchemy = Alchemy;

export const alchemy: Alchemy = _alchemy as any;

/**
 * The Alchemy interface provides core functionality and is augmented by providers.
 * Supports both application scoping with secrets and template string interpolation.
 *
 * @example
 * // Create an application scope with stage and secret handling
 * const app = alchemy("github:alchemy", {
 *   stage: "prod",
 *   phase: "up",
 *   // Required for encrypting/decrypting secrets
 *   password: process.env.SECRET_PASSPHRASE
 * });
 *
 * // Create a resource with encrypted secrets
 * const resource = await Resource("my-resource", {
 *   apiKey: alchemy.secret(process.env.API_KEY)
 * });
 *
 * await app.finalize();
 */
export interface Alchemy {
  scope: typeof scope;
  run: typeof run;
  destroy: typeof destroy;
  /**
   * Creates an encrypted secret that can be safely stored in state files.
   * Requires a password to be set either globally in the application options
   * or locally in the current scope.
   */
  secret: typeof secret;
  /**
   * Creates a new application scope with the given name and options.
   * Used to create and manage resources with proper secret handling.
   *
   * @example
   * const app = alchemy("my-app", {
   *   stage: "prod",
   *   // Required for encrypting/decrypting secrets
   *   password: process.env.SECRET_PASSPHRASE
   * });
   */
  (...parameters: Parameters<typeof scope>): ReturnType<typeof scope>;
  /**
   * Template literal tag that supports file interpolation for documentation.
   * Automatically formats the content and appends file contents as code blocks.
   *
   * @example
   * // Generate documentation using file contents
   * await Document("api-docs", {
   *   prompt: await alchemy`
   *     Generate docs using the contents of:
   *     ${alchemy.file("README.md")}
   *     ${alchemy.file("./.cursorrules")}
   *
   *     And here are the source files:
   *     ${alchemy.files(files)}
   *   `
   * });
   */
  (template: TemplateStringsArray, ...values: any[]): Promise<string>;
}

/**
 * Implementation of the alchemy function that handles both application scoping
 * and template string interpolation.
 */
function _alchemy(
  ...args:
    | [template: TemplateStringsArray, ...values: any[]]
    | [appName: string, options?: Omit<AlchemyOptions, "appName">]
): any {
  if (typeof args[0] === "string") {
    const [appName, options] = args;
    return scope(undefined, {
      ...options,
      appName,
      stage: options?.stage,
    });
  } else {
    const [template, ...values] = args;
    const [, secondLine] = template[0].split("\n");
    const leadingSpaces = secondLine
      ? secondLine.match(/^(\s*)/)?.[1]?.length || 0
      : 0;
    const indent = " ".repeat(leadingSpaces);

    return (async () => {
      const { isFileCollection, isFileRef } = await import("./fs");

      const appendices: Record<string, string> = {};

      const stringValues = await Promise.all(
        values.map(async function resolve(value): Promise<string> {
          if (typeof value === "string") {
            return indent + value;
          } else if (value === null) {
            return "null";
          } else if (value === undefined) {
            return "undefined";
          } else if (
            typeof value === "number" ||
            typeof value === "boolean" ||
            typeof value === "bigint"
          ) {
            return value.toString();
          } else if (value instanceof Promise) {
            return resolve(await value);
          } else if (isFileRef(value)) {
            if (!(value.path in appendices)) {
              appendices[value.path] = await fs.readFile(value.path, "utf-8");
            }
            return `[${path.basename(value.path)}](${value.path})`;
          } else if (isFileCollection(value)) {
            return Object.entries(value.files)
              .map(([filePath, content]) => {
                appendices[filePath] = content;
                return `[${path.basename(filePath)}](${filePath})`;
              })
              .join("\n\n");
          } else if (Array.isArray(value)) {
            return (
              await Promise.all(
                value.map(async (value, i) => `${i}. ${await resolve(value)}`)
              )
            ).join("\n");
          } else {
            // TODO: support other types
            console.log(value);
            throw new Error(`Unsupported value type: ${value}`);
          }
        })
      );

      // Construct the string template by joining template parts with interpolated values
      const lines = template
        .map((part) =>
          part
            .split("\n")
            .map((line) =>
              line.startsWith(indent) ? line.slice(indent.length) : line
            )
            .join("\n")
        )
        .flatMap((part, i) =>
          i < stringValues.length ? [part, stringValues[i] ?? ""] : [part]
        )
        .join("")
        .split("\n");

      // Collect and sort appendices by file path
      return [
        // format the user prompt and trim the first line if it's empty
        lines.length > 1 && lines[0].replaceAll(" ", "").length === 0
          ? lines.slice(1).join("\n")
          : lines.join("\n"),

        // sort appendices by path and include at the end of the prompt
        Object.entries(appendices)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([filePath, content]) => {
            const extension = path.extname(filePath).slice(1);
            const codeTag = extension ? extension : "";
            return `// ${filePath}\n\`\`\`${codeTag}\n${content}\n\`\`\``;
          })
          .join("\n\n"),
      ].join("\n");
    })();
  }
}
_alchemy.destroy = destroy;
_alchemy.run = run;
_alchemy.scope = scope;
_alchemy.secret = secret;

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
   * Required if using alchemy.secret() in this scope.
   */
  password?: string;
}

/**
 * Enter a new scope synchronously.
 *
 * @example
 * // Create a scope with a password for secret handling
 * await using scope = alchemy.scope("my-scope", {
 *   password: process.env.SECRET_PASSPHRASE
 * });
 *
 * // Use secrets within the scope
 * const resource = await Resource("my-resource", {
 *   apiKey: alchemy.secret(process.env.API_KEY)
 * });
 */
function scope(
  id: string | undefined,
  options?: AlchemyOptions
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

/**
 * Run a function in a new scope asynchronously.
 * Useful for isolating secret handling with a specific password.
 *
 * @example
 * // Run operations in a scope with its own password
 * await alchemy.run("secure-scope", {
 *   password: process.env.SCOPE_PASSWORD
 * }, async () => {
 *   // Secrets in this scope will use this password
 *   const resource = await Resource("my-resource", {
 *     apiKey: alchemy.secret(process.env.API_KEY)
 *   });
 * });
 */
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
  const scope = alchemy.scope(id, options);
  try {
    return await fn.bind(scope)(scope);
  } catch (error) {
    if (!(error instanceof DestroyedSignal)) {
      scope.fail();
    } else {
    }
    throw error;
  } finally {
    await scope.finalize();
  }
}
