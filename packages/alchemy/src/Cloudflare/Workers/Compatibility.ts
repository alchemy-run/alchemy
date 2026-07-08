import type { WorkerProps } from "./Worker.ts";

// TODO: figure out why the later one from workerd breaks
const DEFAULT_COMPATIBILITY_DATE = "2026-03-17";

export const getCompatibility = (props: WorkerProps, testLogging = false) => ({
  date: props.compatibility?.date ?? DEFAULT_COMPATIBILITY_DATE,
  flags: [
    ...(props.compatibility?.flags ?? []),
    ...(props.isExternal
      ? // The test-logging wrapper entry needs `AsyncLocalStorage` to thread
        // the request ID through external workers. Effect workers already
        // get it via `nodejs_compat` (which implies `nodejs_als`).
        testLogging &&
        !(props.compatibility?.flags ?? []).includes("nodejs_compat")
        ? ["nodejs_als"]
        : []
      : ["nodejs_compat"]),
  ].filter((value, index, self) => self.indexOf(value) === index),
});
