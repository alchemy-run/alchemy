/**
 * In-process side channel between the Worker provider and the test harness.
 *
 * Test deploys run in the same process as the tests themselves, so when the
 * provider ensures the logger worker (see `Ensure.ts`) it records the
 * connection info here; the harness reads it back when a test starts to know
 * which logger DO instance(s) to subscribe to. Keyed by DO instance name
 * (`{stackName}/{stage}`), so multiple stacks deployed from one test file
 * each get their own subscription.
 */

export interface TestLoggerTarget {
  /** Base URL of the logger worker, e.g. `https://alchemy-test-logger.<sub>.workers.dev`. */
  loggerUrl: string;
  /** Logger DO instance name — `{stackName}/{stage}`. */
  doName: string;
  accountId: string;
}

const targets = new Map<string, TestLoggerTarget>();

export const registerTestLoggerTarget = (target: TestLoggerTarget): void => {
  targets.set(target.doName, target);
};

export const getTestLoggerTargets = (): TestLoggerTarget[] =>
  Array.from(targets.values());
