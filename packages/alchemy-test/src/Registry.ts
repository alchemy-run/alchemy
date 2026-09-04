/**
 * Per-file registration state.
 *
 * While a test file's module body runs, `describe`/`test`/hook calls
 * register nodes on that file's collector. AsyncLocalStorage carries the
 * collector from the `import()` call into the module's top-level code and
 * its microtasks, so each file's registrations reach its own root.
 *
 * Bun 1.4 does not carry the AsyncLocalStorage context into a dynamic
 * `import()`. So `collect` runs one file at a time, and `collecting` holds
 * the collector of the file under import. Collection is serial: the
 * runner's `collectConcurrency` does not make it parallel.
 *
 * The state lives on `globalThis` so that a duplicated module instance
 * (e.g. two resolutions of the package) still shares one registry.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { makeFileSuite, type FileSuite, type Suite } from "./Model.ts";

interface FileContext {
  /** Suite that `describe`/`test` calls currently attach to. */
  current: Suite;
}

interface Registry {
  storage: AsyncLocalStorage<FileContext>;
  /** Collector of the file under import. */
  collecting: FileContext | undefined;
  /** Chain of collections. Each collection starts after the previous one. */
  collectQueue: Promise<void>;
}

const key = Symbol.for("alchemy-test/registry");

const registry: Registry = ((globalThis as any)[key] ??= {
  storage: new AsyncLocalStorage<FileContext>(),
  collecting: undefined,
  collectQueue: Promise.resolve(),
} satisfies Registry);

/**
 * Collect one file: run `f` (the file's dynamic import + microtask flush)
 * with a fresh root as the ambient collector, and return the root.
 */
export const collect = (
  file: string,
  f: () => Promise<void>,
): Promise<FileSuite> => {
  const run = registry.collectQueue.then(() => collectOne(file, f));
  registry.collectQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
};

const collectOne = async (
  file: string,
  f: () => Promise<void>,
): Promise<FileSuite> => {
  const root = makeFileSuite(file);
  const context: FileContext = { current: root };
  registry.collecting = context;
  try {
    await registry.storage.run(context, f);
  } finally {
    registry.collecting = undefined;
  }
  return root;
};

const currentContext = (): FileContext => {
  const context = registry.storage.getStore() ?? registry.collecting;
  if (context === undefined) {
    throw new Error(
      "alchemy-test: describe/test/hook called outside of a test file collection. " +
        "Run tests with the `alchemy-test` CLI.",
    );
  }
  return context;
};

export const currentSuite = (): Suite => currentContext().current;

/**
 * The file currently being collected (path relative to the run root, e.g.
 * `test/Cloudflare/R2/Bucket.test.ts`), or `undefined` when called outside
 * of a collection (e.g. from a non-alchemy-test runner). Adapters use this
 * at registration time to namespace per-test durable state by file.
 */
export const currentFile = (): string | undefined => {
  let suite: Suite | undefined = registry.storage.getStore()?.current;
  while (suite?.parent !== undefined) suite = suite.parent;
  return suite !== undefined && "file" in suite
    ? (suite as FileSuite).file
    : undefined;
};

/** Run `f` with `suite` as the current registration target. */
export const withSuite = (suite: Suite, f: () => void): void => {
  const context = currentContext();
  const previous = context.current;
  context.current = suite;
  try {
    f();
  } finally {
    context.current = previous;
  }
};
