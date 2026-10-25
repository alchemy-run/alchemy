import { Easing, interpolate } from "remotion";

/** 0 → 1 between frames `from` and `from + length` of a step, eased. */
export const progress = (t: number, from = 0, length = 14) =>
  interpolate(t, [from, from + length], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });

/** Fade and rise in. */
export const enter = (p: number) => ({
  opacity: p,
  transform: `translateY(${(1 - p) * 24}px)`,
});
