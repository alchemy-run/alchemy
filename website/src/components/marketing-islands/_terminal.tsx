import { useEffect, useState } from "react";

export const SPINNER_FRAMES = [
  "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
];

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function useSpinner(active: boolean, intervalMs = 80): string {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(
      () => setI((v) => (v + 1) % SPINNER_FRAMES.length),
      intervalMs,
    );
    return () => clearInterval(t);
  }, [active, intervalMs]);
  return SPINNER_FRAMES[i]!;
}

export function TermChrome({
  title,
  badge,
  badgeColor,
  children,
  bodyMinHeight,
}: {
  title: string;
  badge?: string;
  badgeColor?: string;
  children: React.ReactNode;
  bodyMinHeight?: number;
}) {
  return (
    <div
      style={{
        background: "var(--alc-bg-code)",
        border: "1px solid var(--alc-hairline)",
        borderRadius: 10,
        overflow: "hidden",
        boxShadow: "var(--alc-shadow-sm)",
        fontFamily: "var(--alc-font-mono)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "10px 14px",
          borderBottom: "1px solid rgba(232,220,192,0.08)",
          background: "rgba(255,255,255,0.02)",
        }}
      >
        <span style={dot("var(--alc-danger)")} />
        <span style={dot("var(--alc-warn)")} />
        <span style={dot("var(--alc-accent-bright)")} />
        <span
          style={{
            marginLeft: 10,
            fontSize: 11,
            color: "var(--alc-code-comment)",
          }}
        >
          {title}
        </span>
        <span style={{ flex: 1 }} />
        {badge && badgeColor && (
          <span
            style={{
              fontSize: 10,
              letterSpacing: "0.14em",
              fontWeight: 700,
              padding: "2px 8px",
              borderRadius: 4,
              color: badgeColor,
              border: `1px solid ${badgeColor}`,
              background: "transparent",
              transition: "color 280ms ease, border-color 280ms ease",
            }}
          >
            {badge}
          </span>
        )}
      </div>
      <div
        style={{
          padding: "14px 18px",
          fontSize: 12.5,
          lineHeight: 1.65,
          color: "var(--alc-code-var)",
          minHeight: bodyMinHeight ?? 296,
        }}
      >
        {children}
      </div>
    </div>
  );
}

function dot(bg: string): React.CSSProperties {
  return { width: 10, height: 10, borderRadius: "50%", background: bg };
}

export function Line({
  children,
  style,
}: {
  children?: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div style={{ minHeight: "1.55em", whiteSpace: "pre", ...style }}>
      {children}
    </div>
  );
}
