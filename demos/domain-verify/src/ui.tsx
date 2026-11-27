import type { CSSProperties, ReactNode } from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { brand, FACE, mono, sans, serif, serifItalic } from "./theme.ts";

/** 0 before `at`, easing to 1 over `over` frames. */
export const useRise = (at: number, over = 14): number => {
  const frame = useCurrentFrame();
  return interpolate(frame, [at, at + over], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
};

/** A spring that starts at `at`. */
export const usePop = (at: number): number => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - at, fps, config: { damping: 200, mass: 0.6 } });
};

/** Something that fades and slides up into place at `at`. */
export const Rise = ({
  at,
  children,
  style,
  by = 18,
}: {
  at: number;
  children: ReactNode;
  style?: CSSProperties;
  by?: number;
}) => {
  const shown = useRise(at);
  return (
    <div style={{ opacity: shown, transform: `translateY(${(1 - shown) * by}px)`, ...style }}>
      {children}
    </div>
  );
};

/** The mark and wordmark, as the website's header has them. */
export const Logo = ({ size = 40 }: { size?: number }) => (
  <div style={{ display: "inline-flex", alignItems: "center", gap: size * 0.36 }}>
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={brand.moss}
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9.5" />
      <path d="M12 21.125 L4.0975 7.4375 L19.9025 7.4375 Z" />
      <circle cx="12" cy="12" r="1.3" fill={brand.ember} stroke="none" />
    </svg>
    <span
      style={{
        fontFamily: serifItalic,
        fontStyle: "italic",
        fontWeight: 500,
        fontSize: size * 1.05,
        letterSpacing: "-0.01em",
        color: brand.fg,
      }}
    >
      Alchemy
    </span>
  </div>
);

/** Where the camera picture goes: drawn only when a composition asks to see it. */
export const FaceGuide = () => (
  <div
    style={{
      position: "absolute",
      right: FACE.right,
      bottom: FACE.bottom,
      width: FACE.width,
      height: FACE.height,
      border: `2px dashed ${brand.fgMuted}`,
      borderRadius: 24,
      color: brand.fgMuted,
      fontFamily: mono,
      fontSize: 22,
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
    }}
  >
    camera
  </div>
);

/** One scene: the page, its small label, its headline, and what it shows. */
export const Scene = ({
  kicker,
  title,
  children,
  length,
}: {
  kicker: string;
  title: ReactNode;
  children: ReactNode;
  /** The scene's length in frames: it fades out over the last few. */
  length: number;
}) => {
  const frame = useCurrentFrame();
  const out = interpolate(frame, [length - 10, length], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill
      style={{
        background: brand.bg,
        color: brand.fg,
        fontFamily: sans,
        opacity: out,
        padding: "56px 96px 64px",
      }}
    >
      <Logo />
      <Rise at={0} style={{ marginTop: 34 }}>
        <div
          style={{
            fontFamily: mono,
            fontSize: 24,
            letterSpacing: 4,
            textTransform: "uppercase",
            color: brand.moss,
          }}
        >
          {kicker}
        </div>
      </Rise>
      <Rise at={4}>
        <div
          style={{
            fontFamily: serif,
            fontSize: 62,
            lineHeight: 1.12,
            marginTop: 12,
            maxWidth: 1500,
          }}
        >
          {title}
        </div>
      </Rise>
      <div
        style={{
          position: "relative",
          flex: 1,
          marginTop: 36,
        }}
      >
        {children}
      </div>
    </AbsoluteFill>
  );
};

/** A panel with a title bar, for code and reports. */
export const Panel = ({
  title,
  children,
  style,
}: {
  title?: string;
  children: ReactNode;
  style?: CSSProperties;
}) => (
  <div
    style={{
      background: brand.bgElevated,
      border: `1px solid ${brand.border}`,
      borderRadius: 18,
      overflow: "hidden",
      ...style,
    }}
  >
    {title !== undefined && (
      <div
        style={{
          fontFamily: mono,
          fontSize: 20,
          color: brand.fgMuted,
          padding: "14px 26px",
          borderBottom: `1px solid ${brand.border}`,
        }}
      >
        {title}
      </div>
    )}
    <div style={{ padding: "22px 26px" }}>{children}</div>
  </div>
);

const KEYWORDS = new Set([
  "export",
  "class",
  "extends",
  "const",
  "return",
  "new",
  "yield",
  "function",
  "if",
  "import",
  "from",
]);

/** A line of TypeScript, coloured by what each word is. */
const tokens = (line: string): ReadonlyArray<{ text: string; color: string }> => {
  const out: Array<{ text: string; color: string }> = [];
  const pattern =
    /(\/\/.*$)|("[^"]*"|'[^']*'|`[^`]*`)|(\b\d[\d_]*\b)|([A-Za-z_$][\w$]*)|(\s+)|([^\w\s])/g;
  for (const match of line.matchAll(pattern)) {
    const [text, comment, string, number, word] = match;
    out.push({
      text,
      color: comment
        ? brand.fgMuted
        : string
          ? brand.gold
          : number
            ? brand.ember
            : word
              ? KEYWORDS.has(word)
                ? brand.ember
                : /^[A-Z]/.test(word)
                  ? brand.sky
                  : brand.fg
              : brand.fgMuted,
    });
  }
  return out;
};

/**
 * Code that appears a line at a time. Lines in `lit` are marked from the
 * frame `litAt`, and the rest dim.
 */
export const Code = ({
  code,
  at = 0,
  every = 3,
  size = 28,
  lit: always,
  litAt = 0,
  marks,
  struck,
  struckAt = 0,
  added,
}: {
  code: string;
  at?: number;
  every?: number;
  size?: number;
  lit?: ReadonlyArray<number>;
  litAt?: number;
  /** Lines marked for a while each: the last one that has started wins. */
  marks?: ReadonlyArray<{ readonly lines: ReadonlyArray<number>; readonly from: number }>;
  /** Lines crossed out from `struckAt`: the code that was taken away. */
  struck?: ReadonlyArray<number>;
  struckAt?: number;
  /** Lines that are written in from `struckAt`: the code that replaced it. */
  added?: ReadonlyArray<number>;
}) => {
  const frame = useCurrentFrame();
  const current = marks?.filter((mark) => frame >= mark.from).at(-1);
  const lit = current?.lines ?? always;
  const marking = lit !== undefined && (current !== undefined || frame >= litAt);
  const striking = struck !== undefined && frame >= struckAt;
  return (
    <div
      style={{
        fontFamily: mono,
        fontSize: size,
        lineHeight: 1.5,
        whiteSpace: "pre",
        fontVariantLigatures: "none",
      }}
    >
      {code.split("\n").map((line, index) => {
        const shown = interpolate(frame, [at + index * every, at + index * every + 10], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const marked = marking && lit.includes(index);
        const gone = striking && struck.includes(index);
        const fresh = added?.includes(index) ?? false;
        const written = interpolate(frame, [struckAt + 8, struckAt + 18], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        return (
          <div
            key={index}
            style={{
              opacity: (fresh ? written : shown) * (gone ? 0.5 : marking && !marked ? 0.35 : 1),
              textDecoration: gone ? "line-through" : "none",
              background: gone
                ? "rgba(216, 131, 90, 0.16)"
                : marked || fresh
                  ? "rgba(163, 196, 115, 0.14)"
                  : "transparent",
              borderLeft: `4px solid ${gone ? brand.ember : marked || fresh ? brand.moss : "transparent"}`,
              paddingLeft: 14,
              marginLeft: -18,
              minHeight: size * 1.5,
            }}
          >
            {tokens(line).map((token, at) => (
              <span key={at} style={{ color: token.color }}>
                {token.text}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  );
};

/** Plain monospaced lines that appear one at a time, each with its own colour. */
export const Lines = ({
  lines,
  at = 0,
  every = 4,
  size = 26,
}: {
  lines: ReadonlyArray<{ readonly text: string; readonly color?: string }>;
  at?: number;
  every?: number;
  size?: number;
}) => {
  const frame = useCurrentFrame();
  return (
    <div
      style={{
        fontFamily: mono,
        fontSize: size,
        lineHeight: 1.5,
        whiteSpace: "pre",
        fontVariantLigatures: "none",
      }}
    >
      {lines.map((line, index) => (
        <div
          key={index}
          style={{
            color: line.color ?? brand.fg,
            minHeight: size * 1.5,
            opacity: interpolate(frame, [at + index * every, at + index * every + 8], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
            }),
          }}
        >
          {line.text}
        </div>
      ))}
    </div>
  );
};

/** The sentence under a scene: what to take from it. */
export const Caption = ({ at, children }: { at: number; children: ReactNode }) => (
  <Rise
    at={at}
    style={{
      position: "absolute",
      left: 0,
      right: 0,
      bottom: 0,
      fontSize: 36,
      lineHeight: 1.35,
      color: brand.fgMuted,
      maxWidth: 1500,
    }}
  >
    {children}
  </Rise>
);

/** A word in a caption that carries the point. */
export const Em = ({ children, color = brand.fg }: { children: ReactNode; color?: string }) => (
  <span style={{ color, fontWeight: 600 }}>{children}</span>
);

/** A rounded box of a diagram. */
export const Box = ({
  children,
  color = brand.fgMuted,
  style,
}: {
  children: ReactNode;
  color?: string;
  style?: CSSProperties;
}) => (
  <div
    style={{
      border: `2px solid ${color}`,
      borderRadius: 16,
      padding: "18px 26px",
      fontSize: 30,
      fontWeight: 600,
      color,
      background: brand.bgElevated,
      textAlign: "center",
      ...style,
    }}
  >
    {children}
  </div>
);
