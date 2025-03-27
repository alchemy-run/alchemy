/// <reference types="bun" />

import { afterAll, it } from "bun:test";
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

const globalTestScope = alchemy.scope("test");

type test = {
  (name: string, fn: (scope: Scope) => Promise<any>, timeout?: number): void;
  (
    name: string,
    options: TestOptions,
    fn: (scope: Scope) => Promise<any>,
    timeout?: number,
  ): void;
  skipIf(condition: boolean): test;
  scope: Scope;
};

export function test(meta: ImportMeta, defaultOptions?: TestOptions): test {
  test.skipIf = (condition: boolean) => {
    if (condition) {
      // TODO: proxy through to bun:test.skipIf
      return (...args: any[]) => {};
    }
    return test;
  };

  const localTestScope = alchemy.scope(path.basename(meta.filename), {
    parent: globalTestScope,
  });
  test.scope = localTestScope;

  afterAll(() => alchemy.destroy(test.scope));

  return test as any;

  function test(
    ...args:
      | [
          name: string,
          options: TestOptions,
          fn: (scope: Scope) => Promise<void>,
        ]
      | [name: string, fn: (scope: Scope) => Promise<void>]
  ) {
    const testName = args[0];
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

    return alchemy.run(
      testName,
      {
        ...options,
        parent: localTestScope,
      },
      async (scope) => {
        return it(testName, async () => {
          // bun will call from a different scope, so we need to enter the test's scope manually
          scope.enter();
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
    );
  }
}
