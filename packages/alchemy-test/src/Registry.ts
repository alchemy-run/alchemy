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
 * That propagation is NOT universal: Bun dropped it in 1.3.14 (1.3.13 and
 * earlier propagate; Node does too), which makes every registration throw
 * "called outside of a test file collection". `probeAsyncContext` detects
 * the behaviour at startup and the runner falls back to SERIAL collection,
 * where the ambient `serialContext` below is an unambiguous stand-in.
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

/**
 * Ambient collector for runtimes that lose the async context across module
 * evaluation. Only sound while collection is serial — the runner guarantees
 * that by dropping collect concurrency to 1 when `probeAsyncContext` fails.
 */
let serialContext: FileContext | undefined;

/**
 * Collect one file: run `f` (the file's dynamic import + microtask flush)
 * with a fresh root as the ambient collector, and return the root.
 */
export const collect = async (
  file: string,
  f: () => Promise<void>,
): Promise<FileSuite> => {
  const root = makeFileSuite(file);
  const context: FileContext = { current: root };
  const previous = serialContext;
  serialContext = context;
  try {
    await storage.run(context, f);
  } finally {
    serialContext = previous;
  }
  return root;
};

/**
 * True when the runtime propagates AsyncLocalStorage into the top-level
 * evaluation of a dynamically imported module — i.e. when test files may be
 * collected concurrently. Imports a real on-disk module (a `data:` URL is
 * evaluated without the importer's context even on runtimes that are fine,
 * so it would report a false negative) exactly once per process.
 */
export const probeAsyncContext = async (): Promise<boolean> => {
  const key = Symbol.for("alchemy-test/async-context-probe");
  let propagated = false;
  (globalThis as any)[key] = () => {
    propagated = storage.getStore() !== undefined;
  };
  try {
    await storage.run(
      { current: makeFileSuite("<probe>") },
      () => import("./AsyncContextProbe.ts"),
    );
  } finally {
    delete (globalThis as any)[key];
  }
  return propagated;
};

const currentContext = (): FileContext => {
  const context = storage.getStore() ?? serialContext;
  if (context === undefined) {
    throw new Error(
      "alchemy-test: describe/test/hook called outside of a test file collection. " +
        "Run tests with the `alchemy-test` CLI.",
    );
  }
  return context;
};

export const currentSuite = (): Suite => currentContext().current;

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
