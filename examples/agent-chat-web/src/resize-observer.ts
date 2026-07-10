/**
 * `@shadcn/react/message-scroller` observes both its viewport and
 * content, then adjusts scroll/spacer layout from the observer callback.
 * Chrome can detect the resulting same-delivery resize cycle and report:
 *
 *   ResizeObserver loop completed with undelivered notifications.
 *
 * Delivering callbacks on the next animation frame breaks that cycle
 * (and batches multiple resize records into one paint). Install once,
 * before React mounts; HMR must not wrap the constructor repeatedly.
 */
const installed = Symbol.for("alchemy/resize-observer-raf-installed");
const global = globalThis as typeof globalThis & {
  [installed]?: boolean;
};

if (typeof ResizeObserver !== "undefined" && global[installed] !== true) {
  global[installed] = true;
  const NativeResizeObserver = ResizeObserver;

  globalThis.ResizeObserver = class ResizeObserverWithRaf extends
    NativeResizeObserver
  {
    constructor(callback: ResizeObserverCallback) {
      let frame: number | undefined;
      super((entries, observer) => {
        if (frame !== undefined) cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => {
          frame = undefined;
          callback(entries, observer);
        });
      });
    }
  };
}
