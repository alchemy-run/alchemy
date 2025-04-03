/// <reference types="bun" />

import { afterAll, beforeAll, it } from "bun:test";
import path from "node:path";
import { alchemy } from "../alchemy";
import { R2RestStateStore } from "../cloudflare";
import { destroy } from "../destroy";
import type { Scope } from "../scope";
import type { StateStoreType } from "../state";

/**
 * Extend the Alchemy interface to include test functionality
 */
declare module "../alchemy" {
  interface Alchemy {
    test: typeof test;
  }
}

/**
 * Add test functionality to alchemy instance
 */
alchemy.test = test;

/**
 * Options for configuring test behavior
 */
export interface TestOptions {
  /**
   * Whether to automatically destroy resources after test.
   * @default true.
   */
  destroy?: boolean;

  /**
   * Whether to suppress logging output.
   * @default false.
   */
  quiet?: boolean;

  /**
   * Password to use for test resources.
   * @default "test-password".
   */
  password?: string;

  /**
   * Override the default state store for the test.
   */
  stateStore?: StateStoreType;

  /**
   * Prefix to use for the scope to isolate tests and environments.
   */
  prefix?: string;
}

/**
 * Test function type definition with overloads
 */
type test = {
  /**
   * Create a test with default options
   * @param name Test name
   * @param fn Test function
   * @param timeout Optional timeout in milliseconds
   */
  (name: string, fn: (scope: Scope) => Promise<any>, timeout?: number): void;

  /**
   * Create a test with custom options
   * @param name Test name
   * @param options Test configuration options
   * @param fn Test function
   * @param timeout Optional timeout in milliseconds
   */
  (
    name: string,
    options: TestOptions,
    fn: (scope: Scope) => Promise<any>,
    timeout?: number,
  ): void;

  /**
   * Skip test conditionally
   * @param condition If true, test will be skipped
   */
  skipIf(condition: boolean): test;

  beforeAll(fn: (scope: Scope) => Promise<void>): void;

  afterAll(fn: (scope: Scope) => Promise<void>): void;

  /**
   * Current test scope
   */
  scope: Scope;
};

/**
 * Creates a test helper function that provides scoped resource management
 *
 * @param meta Import meta object from the test file
 * @param defaultOptions Default options to apply to all tests
 * @returns Test function with scope management
 *
 * @example
 * ```typescript
 * const test = alchemy.test(import.meta);
 *
 * describe("My Resource", () => {
 *   test("create and delete", async (scope) => {
 *     try {
 *       const resource = await MyResource("test", { ... });
 *       expect(resource.id).toBeTruthy();
 *     } finally {
 *       await alchemy.destroy(scope);
 *     }
 *   });
 * });
 * ```
 */
export function test(meta: ImportMeta, defaultOptions?: TestOptions): test {
  defaultOptions = defaultOptions ?? {};
  if (
    defaultOptions.stateStore === undefined &&
    // process.env.CI &&
    process.env.ALCHEMY_STATE_STORE === "cloudflare"
  ) {
    defaultOptions.stateStore = (scope) =>
      new R2RestStateStore(scope, {
        apiKey: process.env.CLOUDFLARE_API_KEY,
        email: process.env.CLOUDFLARE_EMAIL,
        bucketName: process.env.CLOUDFLARE_BUCKET_NAME!,
      });
  }

  // Add skipIf functionality
  test.skipIf = (condition: boolean) => {
    if (condition) {
      // TODO: proxy through to bun:test.skipIf
      return (...args: any[]) => {};
    }
    return test;
  };

  // Create local test scope based on filename
  const localTestScope = alchemy.scope(
    `${defaultOptions.prefix ? `${defaultOptions.prefix}-` : ""}${path.basename(meta.filename)}`,
    {
      // parent: globalTestScope,
      stateStore: defaultOptions?.stateStore,
    },
  );
  test.scope = localTestScope;

  test.beforeAll = (fn: (scope: Scope) => Promise<void>) => {
    return beforeAll(async () => {
      test.scope.enter();
      await fn(test.scope);
    });
  };

  test.afterAll = (fn: (scope: Scope) => Promise<void>) => {
    return afterAll(async () => {
      test.scope.enter();
      await fn(test.scope);
    });
  };

  // Clean up test scope after all tests complete
  afterAll(async () => {
    if (defaultOptions?.destroy !== false) {
      await alchemy.destroy(test.scope);
    }
  });

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

    // Merge options with defaults
    const options = {
      destroy: true,
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
          // Enter test scope since bun calls from different scope
          scope.enter();
          try {
            await fn(scope);
          } catch (err) {
            console.error(err);
            throw err;
          } finally {
            if (options.destroy !== false) {
              await destroy(scope);
            }
          }
        });
      },
    );
  }
}
