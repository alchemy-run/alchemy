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
}

const testScope = await alchemy.scope("test");

type test = {
  (
    name: string,
    options: TestOptions,
    fn: (scope: Scope) => Promise<void>,
  ): void;

  (name: string, fn: (scope: Scope) => Promise<void>): void;

  [Symbol.asyncDispose](): Promise<void>;
};

function isImportMeta(value: any): value is ImportMeta {
  return typeof value.dir === "string";
}

export function test(meta: ImportMeta, options?: TestOptions): test;

export function test(
  ...args:
    | [name: string, options: TestOptions, fn: (scope: Scope) => Promise<void>]
    | [name: string, fn: (scope: Scope) => Promise<void>]
): Promise<void>;

export function test(
  ...args:
    | [meta: ImportMeta, options?: TestOptions]
    | [name: string, options: TestOptions, fn: (scope: Scope) => Promise<void>]
    | [name: string, fn: (scope: Scope) => Promise<void>]
): any {
  if (isImportMeta(args[0])) {
    const meta = args[0];
    const defaultOptions = args[1];

    return (
      ...args:
        | [
            name: string,
            options: TestOptions,
            fn: (scope: Scope) => Promise<void>,
          ]
        | [name: string, fn: (scope: Scope) => Promise<void>]
    ) => {
      const name = args[0];
      const _options = typeof args[1] === "object" ? args[1] : undefined;
      const options = {
        ...defaultOptions,
        ..._options,
      };
      const fn = typeof args[1] === "function" ? args[1] : args[2]!;
      return test(
        name,
        {
          ...defaultOptions,
          ...options,
        },
        async () => {
          await alchemy.run(
            path.basename(meta.filename),
            {
              parent: testScope,
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
        },
      );
    };
  }

  const options = args.length === 3 ? args[1] : {};
  const name = args[0];
  const fn = typeof args[1] === "function" ? args[1] : args[2]!;

  return it(name, async () => {
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
  });
}
