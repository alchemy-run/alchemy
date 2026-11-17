import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadJetBrainsMono } from "@remotion/google-fonts/JetBrainsMono";
import { loadFont as loadSourceSerif } from "@remotion/google-fonts/SourceSerif4";

export const VIDEO = { width: 1920, height: 1080, fps: 30 } as const;

/** Alchemy brand colours (website/src/styles/tokens.css, dark mode). */
export const brand = {
  bg: "#14110d",
  bgElevated: "#221e18",
  border: "#3a3327",
  fg: "#faf6ec",
  fgMuted: "#a89572",
  moss: "#a3c473",
  ember: "#d8835a",
  gold: "#e3c06a",
  sky: "#8fb8d8",
} as const;

/** The website's type stack. */
export const sans = loadInter("normal", {
  weights: ["400", "500", "600", "700"],
  subsets: ["latin"],
}).fontFamily;
export const mono = loadJetBrainsMono("normal", {
  weights: ["400", "500", "700"],
  subsets: ["latin"],
}).fontFamily;
export const serif = loadSourceSerif("normal", {
  weights: ["400", "600"],
  subsets: ["latin"],
}).fontFamily;

/** Seconds as frames. */
export const s = (seconds: number): number => Math.round(seconds * VIDEO.fps);
