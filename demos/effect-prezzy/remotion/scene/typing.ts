import { diffLines } from "diff";
import type { Colors } from "./highlight.ts";

/**
 * A human-looking edit from `before` to `after`: each changed block of lines
 * is reduced to one contiguous deletion (select, then delete) followed by one
 * contiguous insertion typed character by character. Indentation after a
 * newline appears instantly, like an editor's auto-indent.
 */
export interface TypingPlan {
  parts: Part[];
  /** Frames from the start of typing until the last character lands. */
  frames: number;
}

export interface Part {
  kind: "equal" | "delete" | "insert";
  text: string;
  /** Offset of `text` in `before` (equal/delete) or `after` (equal/insert). */
  beforeOffset: number;
  afterOffset: number;
  /** delete: frame the selection appears; insert: frame the first character lands. */
  start: number;
  /** delete: frame the text disappears; insert: frame of each character. */
  end: number;
  charFrames: number[];
}

export interface TypingOptions {
  fps: number;
  /** Typed characters per second. */
  cps: number;
  /** Frames a selection shows before it is deleted. */
  selectFrames: number;
  /** Frames the cursor rests between two changes. */
  gapFrames: number;
}

const commonPrefix = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
};
const commonSuffix = (a: string, b: string, limit: number) => {
  let i = 0;
  while (
    i < a.length - limit &&
    i < b.length - limit &&
    a[a.length - 1 - i] === b[b.length - 1 - i]
  ) {
    i++;
  }
  return i;
};

/** Small deterministic variation so typing does not look metronomic. */
const jitter = (i: number) => {
  const x = Math.sin(i * 12.9898) * 43758.5453;
  return x - Math.floor(x);
};

export const planTyping = (
  before: string,
  after: string,
  opts: TypingOptions,
): TypingPlan => {
  const parts: Part[] = [];
  let b = 0;
  let a = 0;
  const push = (kind: Part["kind"], text: string) => {
    if (!text) return;
    parts.push({ kind, text, beforeOffset: b, afterOffset: a, start: 0, end: 0, charFrames: [] });
    if (kind !== "insert") b += text.length;
    if (kind !== "delete") a += text.length;
  };

  const changes = diffLines(before, after);
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]!;
    if (!change.added && !change.removed) {
      push("equal", change.value);
      continue;
    }
    // Gather one changed block: consecutive removed/added chunks.
    let removed = "";
    let added = "";
    while (i < changes.length && (changes[i]!.added || changes[i]!.removed)) {
      if (changes[i]!.added) added += changes[i]!.value;
      else removed += changes[i]!.value;
      i++;
    }
    i--;
    const prefix = commonPrefix(removed, added);
    const suffix = commonSuffix(removed, added, prefix);
    push("equal", removed.slice(0, prefix));
    push("delete", removed.slice(prefix, removed.length - suffix));
    push("insert", added.slice(prefix, added.length - suffix));
    push("equal", removed.slice(removed.length - suffix));
  }

  const perChar = opts.fps / opts.cps;
  let frame = 0;
  let typed = 0;
  let first = true;
  for (const part of parts) {
    if (part.kind === "equal") continue;
    if (!first) frame += opts.gapFrames;
    first = false;
    part.start = frame;
    if (part.kind === "delete") {
      frame += opts.selectFrames;
      part.end = frame;
      continue;
    }
    let atLineStart = false;
    for (let i = 0; i < part.text.length; i++) {
      const char = part.text[i]!;
      const indent = atLineStart && (char === " " || char === "\t");
      if (!indent) frame += perChar * (0.6 + 0.8 * jitter(typed++));
      part.charFrames.push(frame);
      if (char === "\n") atLineStart = true;
      else if (!indent) atLineStart = false;
    }
    part.end = frame;
  }
  return { parts, frames: Math.ceil(frame) };
};

export interface Glyph {
  char: string;
  color: string;
  selected: boolean;
}

export interface TypedDocument {
  glyphs: Glyph[];
  /** Index into `glyphs` where the cursor sits. */
  cursor: number;
}

/** The document `frame` frames into the plan (negative: nothing typed yet). */
export const typedAt = (
  plan: TypingPlan,
  frame: number,
  beforeColors: Colors,
  afterColors: Colors,
): TypedDocument => {
  const glyphs: Glyph[] = [];
  let cursor = -1;
  let firstChange = -1;
  for (const part of plan.parts) {
    if (part.kind === "equal") {
      for (let i = 0; i < part.text.length; i++) {
        glyphs.push({ char: part.text[i]!, color: afterColors[part.afterOffset + i] ?? "", selected: false });
      }
      continue;
    }
    if (firstChange < 0) firstChange = glyphs.length;
    if (part.kind === "delete") {
      if (frame >= part.end) {
        if (frame >= part.start) cursor = glyphs.length;
        continue;
      }
      const selected = frame >= part.start;
      if (selected) cursor = glyphs.length + part.text.length;
      for (let i = 0; i < part.text.length; i++) {
        glyphs.push({ char: part.text[i]!, color: beforeColors[part.beforeOffset + i] ?? "", selected });
      }
      continue;
    }
    if (frame < part.start) continue;
    let count = 0;
    while (count < part.charFrames.length && part.charFrames[count]! <= frame) count++;
    for (let i = 0; i < count; i++) {
      glyphs.push({ char: part.text[i]!, color: afterColors[part.afterOffset + i] ?? "", selected: false });
    }
    cursor = glyphs.length;
  }
  return { glyphs, cursor: cursor >= 0 ? cursor : Math.max(0, firstChange) };
};

/** A document with nothing in flight. */
export const staticDocument = (text: string, colors: Colors): TypedDocument => ({
  glyphs: Array.from({ length: text.length }, (_, i) => ({
    char: text[i]!,
    color: colors[i] ?? "",
    selected: false,
  })),
  cursor: -1,
});
