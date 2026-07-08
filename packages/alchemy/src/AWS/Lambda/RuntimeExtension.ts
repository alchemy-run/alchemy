/**
 * Runtime-only bridge between the generated Lambda entry and the handler
 * dispatch, built on a self-registered *internal extension*.
 *
 * Registering an internal extension buys two things:
 *
 * 1. **A Shutdown phase.** A sandbox with no registered extensions is
 *    killed with no signal at all (0 ms); with an internal extension Lambda
 *    sends SIGTERM and allows 500 ms before SIGKILL — the entry closes the
 *    instance scope in that window.
 * 2. **A post-response window per invocation.** The extension subscribes to
 *    `INVOKE` events, and the Invoke phase only ends when the runtime *and*
 *    every subscribed extension have signaled done — but Lambda returns the
 *    function response to the client as soon as the runtime produces it,
 *    "even if extensions are still running". Holding our `/event/next` call
 *    until queued work settles therefore runs that work *after* the
 *    response without blocking it — the Lambda equivalent of workerd's
 *    `ctx.waitUntil`. The handler dispatch uses it to close the per-invoke
 *    request scope off the response path.
 *
 * The window is billed (it extends the Invoke phase) and bounded by the
 * function timeout, so queued work is raced against the invocation's
 * `deadlineMs` with a safety margin — a hung finalizer must never turn into
 * a function-timeout reset.
 *
 * https://docs.aws.amazon.com/lambda/latest/dg/runtimes-extensions-api.html
 */

let active = false;
let pending: Promise<unknown>[] = [];
let settledInvocations = 0;
let dispatchedInvocations = 0;
let waiters: (() => void)[] = [];

/**
 * Whether the extension registered and its event loop is running — i.e.
 * whether {@link enqueuePostResponse} work actually runs post-response.
 */
export const isLambdaExtensionActive = () => active;

/**
 * Queue work to run after the current invocation's response is returned.
 * Only meaningful while {@link isLambdaExtensionActive}; callers must fall
 * back to awaiting inline otherwise.
 */
export const enqueuePostResponse = (work: Promise<unknown>) => {
  pending.push(work);
};

/**
 * Signal that the handler for the current invocation has produced its
 * result (the runtime is about to post the response). The extension loop
 * rendezvouses on a monotonic counter — Lambda runs one invocation at a
 * time — so signaling before the loop starts waiting cannot lose a wakeup.
 */
export const settleLambdaInvocation = () => {
  settledInvocations++;
  for (const wake of waiters.splice(0)) wake();
};

const awaitSettled = async (count: number) => {
  while (settledInvocations < count) {
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
};

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Register the internal extension and start its event loop. Called once at
 * the top of the generated entry, before the layer build. Registration
 * failure is non-fatal: the function still works, it just gets no shutdown
 * window and post-response work degrades to inline.
 *
 * A registered extension must signal readiness by calling `/event/next`
 * (a registered extension that never does wedges the Init phase), which the
 * loop's first iteration performs.
 */
export const registerLambdaExtension = async (): Promise<void> => {
  const api = process.env.AWS_LAMBDA_RUNTIME_API;
  if (!api) return;
  const base = `http://${api}/2020-01-01/extension`;
  try {
    const registration = await fetch(`${base}/register`, {
      method: "POST",
      headers: { "Lambda-Extension-Name": "alchemy-graceful-shutdown" },
      body: JSON.stringify({ events: ["INVOKE"] }),
    });
    const extensionId = registration.headers.get("lambda-extension-identifier");
    if (!extensionId) return;
    active = true;
    void (async () => {
      // Each `/event/next` both signals "done with the previous event" and
      // blocks until the next INVOKE. Holding the call back until queued
      // post-response work settles is what keeps the environment thawed
      // after the response is delivered.
      while (true) {
        const event = await fetch(`${base}/event/next`, {
          headers: { "Lambda-Extension-Identifier": extensionId },
        });
        const { deadlineMs } = (await event.json().catch(() => ({}))) as {
          deadlineMs?: number;
        };
        dispatchedInvocations++;
        await awaitSettled(dispatchedInvocations);
        const work = pending.splice(0);
        if (work.length > 0) {
          // Never outlive the invocation: exceeding deadlineMs is a
          // function timeout, which resets the environment.
          const budget = Math.max(
            0,
            (deadlineMs ?? Date.now() + 3_000) - Date.now() - 500,
          );
          await Promise.race([Promise.allSettled(work), sleep(budget)]);
        }
      }
    })().catch(() => {
      active = false;
    });
  } catch {
    // Not running on Lambda (or the Extensions API refused) — no shutdown
    // window, post-response work runs inline.
  }
};
