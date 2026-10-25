import { loadFont as loadCaveat } from "@remotion/google-fonts/Caveat";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadJetBrainsMono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadSourceSerif } from "@remotion/google-fonts/SourceSerif4";

export const VIDEO = { width: 1920, height: 1080, fps: 30 } as const;

/** The website's type stack (website/src/styles/tokens.css). */
export const font = {
  sans: loadInter("normal", { weights: ["400", "500", "600", "700"], subsets: ["latin"] })
    .fontFamily,
  mono: loadJetBrainsMono("normal", { weights: ["400", "500", "700"], subsets: ["latin"] })
    .fontFamily,
  serif: loadSourceSerif("normal", { weights: ["400", "600"], subsets: ["latin"] }).fontFamily,
  hand: loadCaveat("normal", { weights: ["600", "700"], subsets: ["latin"] }).fontFamily,
};

/** Alchemy brand colours (dark mode). */
export const color = {
  bg: "#14110d",
  panel: "#1c1915",
  hairline: "#2e2922",
  fg: "#faf6ec",
  muted: "#a89572",
  moss: "#a3c473",
  ember: "#d8835a",
  red: "#e5675f",
} as const;

export type Tone = "construct" | "runtime" | "good" | "bad";
export const tone: Record<Tone, string> = {
  construct: color.moss,
  runtime: "#e0a86b",
  good: color.moss,
  bad: color.red,
};
