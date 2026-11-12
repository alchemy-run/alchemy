/**
 * Works around a Bun TTY stdin bug that freezes Sigil's input once a terminal
 * capability query runs (e.g. when a text field mounts).
 *
 * Sigil's query swaps its `readable` listener for a `data` listener, and when
 * the reply arrives it calls `pause()` and re-attaches `readable` in the same
 * tick. Node restarts reading for the new `readable` listener; Bun never does,
 * so every later keypress is lost. Re-attaching on the next macrotask works on
 * both, so under Bun any `readable` listener added in the same tick as a
 * `pause()` is deferred (and a `removeListener` before then cancels it).
 *
 * TODO: remove once Sigil defers the re-attach itself
 * (`handleQueryTerminal` in sigil `src/components/App.tsx`).
 */
const patched = new WeakSet<object>();

export const deferReadableAfterPauseOnBun = (stdin: NodeJS.ReadStream): void => {
  if (typeof globalThis.Bun === "undefined" || patched.has(stdin)) return;
  patched.add(stdin);

  const pause = stdin.pause;
  const addListener = stdin.addListener;
  const removeListener = stdin.removeListener;
  const pending = new Map<(...args: any[]) => void, ReturnType<typeof setTimeout>>();
  let pausedThisTick = false;

  stdin.pause = function (this: NodeJS.ReadStream) {
    if (!pausedThisTick) {
      pausedThisTick = true;
      setTimeout(() => {
        pausedThisTick = false;
      }, 0);
    }
    return pause.call(this);
  };

  const add = function (
    this: NodeJS.ReadStream,
    event: string | symbol,
    listener: (...args: any[]) => void,
  ) {
    if (event !== "readable" || !pausedThisTick) {
      return addListener.call(this, event, listener);
    }
    clearTimeout(pending.get(listener));
    pending.set(
      listener,
      setTimeout(() => {
        pending.delete(listener);
        addListener.call(this, event, listener);
      }, 0),
    );
    return this;
  };

  const remove = function (
    this: NodeJS.ReadStream,
    event: string | symbol,
    listener: (...args: any[]) => void,
  ) {
    const timer = event === "readable" ? pending.get(listener) : undefined;
    if (timer !== undefined) {
      clearTimeout(timer);
      pending.delete(listener);
      return this;
    }
    return removeListener.call(this, event, listener);
  };

  stdin.addListener = add;
  stdin.on = add;
  stdin.removeListener = remove;
  stdin.off = remove;
};
