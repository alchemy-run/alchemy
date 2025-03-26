/// <reference types="bun" />

import { it } from "bun:test";
import path from "node:path";
import { alchemy } from "../alchemy";
import { destroy } from "../destroy";
import type { Scope } from "../scope";

declare module "../alchemy" {
  interface Alchemy {
    test: typeof test;
  }
}

alchemy.test = test;

export interface TestOptions {
  destroy?: boolean;
  quiet?: boolean;
  password?: string;
}

const testScope = await alchemy.scope("test");

type test = {
  (name: string, fn: (scope: Scope) => Promise<any>, timeout?: number): void;
  (
    name: string,
    options: TestOptions,
    fn: (scope: Scope) => Promise<any>,
    timeout?: number,
  ): void;

  skipIf(condition: boolean): test;

  [Symbol.asyncDispose](): Promise<void>;
};

function isImportMetaArgs(
  value: Parameters<typeof test>,
): value is [meta: ImportMeta, options?: TestOptions] {
  return typeof value[0] !== "string";
}

// export function test(meta: ImportMeta, options?: TestOptions): test;

// export function test(
//   ...args:
//     | [name: string, options: TestOptions, fn: (scope: Scope) => Promise<void>]
//     | [name: string, fn: (scope: Scope) => Promise<void>]
// ): Promise<void>;

export function test(
  ...args:
    | [meta: ImportMeta, options?: TestOptions]
    | [
        name: string,
        options: TestOptions,
        fn: (scope: Scope) => Promise<void>,
        timeout?: number,
      ]
    | [name: string, fn: (scope: Scope) => Promise<void>, timeout?: number]
): any {
  if (isImportMetaArgs(args)) {
    const meta = args[0];
    const defaultOptions = args[1];

    test.skipIf = (condition: boolean) => {
      if (condition) {
        // TODO: proxy through to bun:test.skipIf
        return (...args: any[]) => {};
      }
      return test;
    };

    return test;

    function test(
      ...args:
        | [
            name: string,
            options: TestOptions,
            fn: (scope: Scope) => Promise<void>,
          ]
        | [name: string, fn: (scope: Scope) => Promise<void>]
    ) {
      const name = args[0];
      const _options = typeof args[1] === "object" ? args[1] : undefined;
      const spread = (obj: any) =>
        obj && typeof obj === "object"
          ? Object.fromEntries(
              Object.entries(obj).flatMap(([k, v]) =>
                v !== undefined ? [[k, v]] : [],
              ),
            )
          : {};
      const options = {
        destroy: false,
        quiet: false,
        password: "test-password",
        ...spread(defaultOptions),
        ...spread(_options),
      };
      const fn = typeof args[1] === "function" ? args[1] : args[2]!;

      return it(name, async () => {
        await alchemy.run(
          path.basename(meta.filename),
          {
            parent: testScope,
            ...options,
          },
          async (scope) => {
            try {
              await fn(scope);
            } finally {
              if (options.destroy !== false) {
                // TODO: auto-destroy resources
                await destroy(scope);
              }
            }
          },
        );
      });
    }
  }

  function find<T>(
    args: any[],
    predicate: (arg: any) => arg is T,
  ): T | undefined {
    return args.find(predicate);
  }

  const options =
    find(args, (arg): arg is TestOptions => typeof arg === "object") ?? {};
  const name = args[0];
  const fn = find(
    args,
    (arg): arg is (scope: Scope) => Promise<void> => typeof arg === "function",
  )!;
  const timeout = find(args, (arg): arg is number => typeof arg === "number");

  return it(
    name,
    async () => {
      await alchemy.run(name, { parent: testScope }, async (scope) => {
        try {
          await fn(scope);
        } finally {
          if (options.destroy !== false) {
            // TODO: auto-destroy resources
            await destroy(scope);
          }
        }
      });
    },
    timeout,
  );
}
