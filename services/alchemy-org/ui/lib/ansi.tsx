import { Fragment, memo, type CSSProperties } from "react";

/**
 * ANSI (SGR) text → styled spans, for tool output that came off a
 * process with colors forced on (pnpm, turbo, vitest under
 * FORCE_COLOR). Only the styling sequences are honored; cursor
 * motion, erase-line, mode toggles, and OSC (title / hyperlink)
 * sequences are removed, since a transcript is not a terminal.
 */

/** Every escape sequence a program is likely to emit: CSI (`ESC [`
 *  … final byte), OSC (`ESC ]` … BEL or ST), and lone two-byte ESC
 *  sequences (`ESC (B` charset selects and the like). */
const ANSI_SEQUENCE =
  // eslint-disable-next-line no-control-regex
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[()][A-Za-z0-9]|\u001b[@-Z\\-_]/g;

/** Text with every escape sequence removed — for one-line summaries,
 *  badges, and anything measured or truncated by character count. */
export const stripAnsi = (text: string): string =>
  text.replace(ANSI_SEQUENCE, "");

/** Whether rendering through {@link Ansi} would change anything. */
export const hasAnsi = (text: string): boolean => text.includes("\u001b");

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  inverse?: boolean;
}

/** The 16 named colors as theme tokens — the palette lives in
 *  index.css (light and dark), not here. */
const NAMED = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
] as const;

const named = (index: number, bright: boolean): string =>
  `var(--ansi-${bright ? "bright-" : ""}${NAMED[index]})`;

/** xterm's 256-color cube and grey ramp, as sRGB. */
const indexed = (n: number): string => {
  if (n < 8) return named(n, false);
  if (n < 16) return named(n - 8, true);
  if (n < 232) {
    const v = n - 16;
    const step = (i: number) => (i === 0 ? 0 : 55 + i * 40);
    return `rgb(${step(Math.floor(v / 36))},${step(Math.floor(v / 6) % 6)},${step(v % 6)})`;
  }
  const grey = 8 + (n - 232) * 10;
  return `rgb(${grey},${grey},${grey})`;
};

/** Apply one SGR parameter list to a style; returns the new style. */
const applySgr = (style: Style, params: ReadonlyArray<number>): Style => {
  if (params.length === 0) return {};
  const next: Style = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (p === 0) {
      for (const key of Object.keys(next) as Array<keyof Style>) {
        delete next[key];
      }
    } else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 3) next.italic = true;
    else if (p === 4) next.underline = true;
    else if (p === 7) next.inverse = true;
    else if (p === 9) next.strike = true;
    else if (p === 22) {
      delete next.bold;
      delete next.dim;
    } else if (p === 23) delete next.italic;
    else if (p === 24) delete next.underline;
    else if (p === 27) delete next.inverse;
    else if (p === 29) delete next.strike;
    else if (p >= 30 && p <= 37) next.fg = named(p - 30, false);
    else if (p >= 90 && p <= 97) next.fg = named(p - 90, true);
    else if (p === 39) delete next.fg;
    else if (p >= 40 && p <= 47) next.bg = named(p - 40, false);
    else if (p >= 100 && p <= 107) next.bg = named(p - 100, true);
    else if (p === 49) delete next.bg;
    else if (p === 38 || p === 48) {
      // extended color: 5;n (256) or 2;r;g;b (truecolor)
      const mode = params[i + 1];
      let color: string | undefined;
      if (mode === 5 && params[i + 2] !== undefined) {
        color = indexed(params[i + 2]!);
        i += 2;
      } else if (mode === 2 && params[i + 4] !== undefined) {
        color = `rgb(${params[i + 2]},${params[i + 3]},${params[i + 4]})`;
        i += 4;
      }
      if (color !== undefined) {
        if (p === 38) next.fg = color;
        else next.bg = color;
      }
    }
  }
  return next;
};

const isPlain = (style: Style): boolean => Object.keys(style).length === 0;

const toCss = (style: Style): CSSProperties | undefined => {
  if (isPlain(style)) return undefined;
  const fg = style.inverse ? style.bg ?? "var(--background)" : style.fg;
  const bg = style.inverse ? style.fg ?? "var(--foreground)" : style.bg;
  const decorations = [
    style.underline ? "underline" : undefined,
    style.strike ? "line-through" : undefined,
  ].filter(Boolean);
  return {
    color: fg,
    backgroundColor: bg,
    fontWeight: style.bold ? 600 : undefined,
    opacity: style.dim ? 0.6 : undefined,
    fontStyle: style.italic ? "italic" : undefined,
    textDecoration: decorations.length > 0 ? decorations.join(" ") : undefined,
  };
};

export interface AnsiSpan {
  readonly text: string;
  readonly style: CSSProperties | undefined;
}

/** Split text into runs of uniform style. Non-SGR sequences vanish. */
export const parseAnsi = (text: string): ReadonlyArray<AnsiSpan> => {
  const spans: AnsiSpan[] = [];
  let style: Style = {};
  let last = 0;
  const push = (end: number) => {
    if (end > last) {
      spans.push({ text: text.slice(last, end), style: toCss(style) });
    }
  };
  for (const match of text.matchAll(ANSI_SEQUENCE)) {
    push(match.index);
    last = match.index + match[0].length;
    const sequence = match[0];
    // SGR is the CSI sequence whose final byte is `m`
    if (sequence.startsWith("\u001b[") && sequence.endsWith("m")) {
      const body = sequence.slice(2, -1);
      // `ESC[m` is `ESC[0m`; private-mode prefixes (`?`, `>`) are not SGR
      if (/^[0-9;:]*$/.test(body)) {
        const params = body.length === 0 ? [] : body.split(/[;:]/).map((v) => (v === "" ? 0 : Number(v)));
        style = applySgr(style, params);
      }
    }
  }
  push(text.length);
  return spans;
};

/** The text, colored as a terminal would show it. */
export const Ansi = memo(({ text }: { text: string }) => {
  if (!hasAnsi(text)) return <>{text}</>;
  return (
    <>
      {parseAnsi(text).map((span, index) =>
        span.style === undefined ? (
          <Fragment key={index}>{span.text}</Fragment>
        ) : (
          <span key={index} style={span.style}>
            {span.text}
          </span>
        ),
      )}
    </>
  );
});
Ansi.displayName = "Ansi";
