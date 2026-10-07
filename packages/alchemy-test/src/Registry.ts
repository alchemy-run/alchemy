/**
 * Per-file registration state.
 *
 * While a test file's module body is evaluating, `describe`/`test`/hook
 * calls register nodes against that file's collector. The runner imports
 * all test files in PARALLEL; attribution stays correct because the
 * collector is carried by AsyncLocalStorage — the module loader propagates
 * the async context of the `import()` call into the module's top-level
 * evaluation (and into microtasks queued from it), so each file's
 * registrations resolve to its own root no matter how many imports are in
 * flight.
 *
 * Bun >= 1.4 no longer propagates the async context of `import()` into the
 * imported module's evaluation (alchemy-run/alchemy#2056), so the runner
 * also prefixes each collected file's source with a call to `enterFile`
 * (see `installCollectorPlugin` in Runner.ts), which re-enters the file's
 * collector from inside its own module body. Context entered there still
 * flows into microtasks and top-level-await continuations, and stays
 * isolated between parallel imports.
 *
 * The storage lives on `globalThis` so that a duplicated module instance
 * (e.g. two resolutions of the package) still shares one registry.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { makeFileSuite, type FileSuite, type Suite } from "./Model.ts";

interface FileContext {
  /** Suite that `describe`/`test` calls currently attach to. */
  current: Suite;
}

const key = Symbol.for("alchemy-test/registry");

const storage: AsyncLocalStorage<FileContext> = ((globalThis as any)[key] ??=
  new AsyncLocalStorage<FileContext>());

/** Collectors of in-flight collections, keyed by absolute file path. */
const pending: Map<string, FileContext> = ((globalThis as any)[
  Symbol.for("alchemy-test/pending")
] ??= new Map<string, FileContext>());

/**
 * Collect one file: run `f` (the file's dynamic import + microtask flush)
 * with a fresh root as the ambient collector, and return the root.
 */
export const collect = async (
  file: string,
  absolute: string,
  f: () => Promise<void>,
): Promise<FileSuite> => {
  const root = makeFileSuite(file);
  const context: FileContext = { current: root };
  pending.set(absolute, context);
  try {
    await storage.run(context, f);
  } finally {
    pending.delete(absolute);
  }
  return root;
};

/**
 * Re-enter the collector of the file at `absolute` for the rest of the
 * caller's synchronous execution and its async continuations. Called from
 * the top of each collected file's module body.
 */
export const enterFile = (absolute: string): void => {
  const context = pending.get(absolute);
  if (context !== undefined && storage.getStore() !== context) storage.enterWith(context);
};

/** Global through which injected file prefixes reach `enterFile`. */
export const enterFileKey = "alchemy-test/enterFile";
(globalThis as any)[Symbol.for(enterFileKey)] = enterFile;

const currentContext = (): FileContext => {
  const context = storage.getStore();
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
  let suite: Suite | undefined = storage.getStore()?.current;
  while (suite?.parent !== undefined) suite = suite.parent;
  return suite !== undefined && "file" in suite ? (suite as FileSuite).file : undefined;
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
