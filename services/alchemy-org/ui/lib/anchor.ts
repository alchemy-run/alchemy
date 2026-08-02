/**
 * Scroll anchoring for expand/collapse toggles: the toggled element
 * keeps its exact on-screen position and the growth spends itself
 * downward, off-screen — no viewport lurch.
 *
 * Two forces must be tamed:
 * 1. ordinary layout shift — compensated by adjusting the scroll
 *    container by the element's position delta (flushSync so the
 *    correction lands in the same frame);
 * 2. `use-stick-to-bottom`'s ResizeObserver, which re-pins the bottom
 *    on ANY positive content resize while `isAtBottom` — and ignores
 *    scroll events during a resize window, so a scrollTop correction
 *    alone loses the fight. `stopScroll()` breaks the lock first.
 */
import { useCallback } from "react";
import { flushSync } from "react-dom";
import { useStickToBottomContext } from "use-stick-to-bottom";

const findScroller = (start: HTMLElement): HTMLElement | undefined => {
  let node: HTMLElement | null = start.parentElement;
  while (node !== null) {
    const style = getComputedStyle(node);
    if (
      /(auto|scroll)/.test(style.overflowY) &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return undefined;
};

/**
 * Returns a toggle runner: `run(anchorElement, () => setOpen(!open))`.
 * Must be used inside a `<Conversation>` (StickToBottom provider).
 */
export const useAnchoredToggle = () => {
  const { stopScroll } = useStickToBottomContext();
  return useCallback(
    (anchor: HTMLElement, update: () => void) => {
      // break the bottom lock BEFORE the resize fires — the library's
      // resize handler only re-pins while isAtBottom
      stopScroll();
      const scroller = findScroller(anchor);
      const before = anchor.getBoundingClientRect().top;
      flushSync(update);
      if (scroller === undefined) return;
      const delta = anchor.getBoundingClientRect().top - before;
      if (delta !== 0) scroller.scrollTop += delta;
    },
    [stopScroll],
  );
};
