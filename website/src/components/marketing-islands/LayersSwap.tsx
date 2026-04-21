import { useState, type ReactNode } from "react";
import { AWS_COLOR, CF_COLOR, tint } from "../marketing/diagrams/_colors";

// Tiny inline TS-token spans. Mirrors the T.x helpers in the original
// TrackCloud.jsx so the layer-swap code panel is syntax-highlighted.
const tok = (color: string, extra?: React.CSSProperties) =>
  ({ children }: { children: ReactNode }) => (
    <span style={{ color, ...extra }}>{children}</span>
  );
const K = tok("var(--alc-code-keyword)");
const S = tok("var(--alc-code-string)");
const F = tok("var(--alc-code-fn)");
const T = tok("var(--alc-code-type)");
const V = tok("var(--alc-code-var)");
const C = tok("var(--alc-code-comment)", { fontStyle: "italic" });

const layers = [
  {
    k: "kv",
    layerName: "SessionsKV",
    resourceLabel: "KVNamespace",
    resourceSub: "Cloudflare KV",
    bind: ".bind(ns)",
    color: CF_COLOR,
    iconKind: "kv",
  },
  {
    k: "ddb",
    layerName: "SessionsDynamoDB",
    resourceLabel: "DynamoDB.Table",
    resourceSub: "AWS DynamoDB",
    bind: ".bind(table)",
    color: AWS_COLOR,
    iconKind: "ddb",
  },
  {
    k: "d1",
    layerName: "SessionsD1",
    resourceLabel: "D1Database",
    resourceSub: "Cloudflare D1",
    bind: ".bind(db)",
    color: CF_COLOR,
    iconKind: "d1",
  },
] as const;

type Layer = (typeof layers)[number];

function ResourceIcon({ kind, color }: { kind: Layer["iconKind"]; color: string }) {
  const fill = tint(color);
  if (kind === "kv") {
    return (
      <svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden>
        <circle cx="11" cy="16" r="6" fill={fill} stroke={color} strokeWidth="1.5" />
        <circle cx="11" cy="16" r="2.2" fill={color} />
        <path d="M17 16 L27 16 M23 16 L23 21 M27 16 L27 12" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      </svg>
    );
  }
  if (kind === "ddb") {
    return (
      <svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden>
        <ellipse cx="16" cy="8" rx="10" ry="3" fill={fill} stroke={color} strokeWidth="1.4" />
        <ellipse cx="16" cy="16" rx="10" ry="3" fill={fill} stroke={color} strokeWidth="1.4" />
        <ellipse cx="16" cy="24" rx="10" ry="3" fill={fill} stroke={color} strokeWidth="1.4" />
      </svg>
    );
  }
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden>
      <ellipse cx="16" cy="8" rx="10" ry="3" fill={fill} stroke={color} strokeWidth="1.5" />
      <path d="M6 8 V24 C6 25.7 10.5 27 16 27 C21.5 27 26 25.7 26 24 V8" fill={fill} stroke={color} strokeWidth="1.5" />
      <path d="M9 14 L23 14 M9 18 L23 18 M9 22 L19 22" stroke={color} strokeWidth="1.2" strokeLinecap="round" />
    </svg>
  );
}

function LayerStack({ color }: { color: string }) {
  const fill = tint(color);
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden>
      <path d="M16 4 L28 10 L16 16 L4 10 Z" fill={fill} stroke={color} strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M4 16 L16 22 L28 16" stroke={color} strokeWidth="1.4" fill="none" strokeLinejoin="round" opacity="0.85" />
      <path d="M4 22 L16 28 L28 22" stroke={color} strokeWidth="1.4" fill="none" strokeLinejoin="round" opacity="0.55" />
    </svg>
  );
}

function Node({
  label, sub, color, accent, icon,
}: {
  label: string;
  sub: string;
  color: string;
  accent?: boolean;
  icon: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: "var(--alc-bg-elev-1)",
        border: `1px solid ${accent ? color : "var(--alc-hairline-2)"}`,
        borderRadius: 10,
        padding: "10px 12px 8px",
        minWidth: 92,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 4,
        textAlign: "center",
        boxShadow: accent ? `0 0 0 2px ${tint(color, 0.12)}` : "none",
      }}
    >
      {icon}
      <div style={{ fontFamily: "var(--alc-font-sans)", fontSize: 12, fontWeight: 600, color: "var(--alc-fg-1)", lineHeight: 1.2 }}>{label}</div>
      <div style={{ fontFamily: "var(--alc-font-mono)", fontSize: 10, color: "var(--alc-fg-3)", lineHeight: 1.25 }}>{sub}</div>
    </div>
  );
}

function Arrow({ label, color }: { label: string; color: string }) {
  const height = 22;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "2px 0" }}>
      <div style={{ fontFamily: "var(--alc-font-mono)", fontSize: 10, color: "var(--alc-fg-3)" }}>{label}</div>
      <svg width="14" height={height} viewBox={`0 0 14 ${height}`}>
        <path d={`M7 0 L7 ${height - 6}`} stroke={color} strokeWidth="1.4" />
        <path d={`M3 ${height - 8} L7 ${height - 1} L11 ${height - 8}`} stroke={color} strokeWidth="1.4" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export default function LayersSwap() {
  const [idx, setIdx] = useState(0);
  const active: Layer = layers[idx]!;

  const next = (e: React.AnimationEvent<HTMLSpanElement>) => {
    if (e.animationName === "layer-cycle") {
      setIdx((i) => (i + 1) % layers.length);
    }
  };

  return (
    <div className="layers-swap-grid">
      <div className="alc-code-block">
        <div className="alc-code-block__header">
          <span className="alc-code-block__dot" style={{ background: "var(--alc-danger)" }} />
          <span className="alc-code-block__dot" style={{ background: "var(--alc-warn)" }} />
          <span className="alc-code-block__dot" style={{ background: "var(--alc-accent-bright)" }} />
          <span className="alc-code-block__filename">src/Api.ts</span>
        </div>
        <pre className="alc-code-block__pre">
          <K>export default</K> <K>class</K> <T>Api</T> <K>extends</K>{" "}
          <V>Cloudflare</V>.<F>Worker</F>{"<"}<T>Api</T>{">()("}
          {"\n  "}
          <S>"Api"</S>,
          {"\n  "}
          <V>Effect</V>.<F>gen</F>(<K>function</K>* () {"{"}
          {"\n    "}
          <K>const</K> sessions = <K>yield</K>* <V>Sessions</V>;
          {"\n    "}
          <K>return</K> {"{ fetch: "}<C>{"/* uses sessions */"}</C>{" };"}
          {"\n  "}
          {"}).pipe("}
          {"\n    "}
          <C>{"// swap one Layer — the resource graph swaps with it"}</C>
          {"\n    "}
          <V>Effect</V>.<F>provide</F>(
          <span
            key={idx}
            className="layer-swap"
            onAnimationEnd={next}
            style={{ color: active.color, fontWeight: 600 }}
          >
            {active.layerName}
          </span>
          ),
          {"\n  "}
          {"),"}
          {"\n"}
          {") {}"}
        </pre>
      </div>

      <div
        style={{
          background: "var(--alc-bg-elev-1)",
          border: "1px solid var(--alc-hairline)",
          borderRadius: 10,
          padding: "18px 14px",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 320,
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "8px 4px", width: "100%" }}>
          <Node
            label="Sessions"
            sub="Context.Service"
            color="var(--alc-accent-deep)"
            accent
            icon={
              <svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden>
                <rect x="4" y="6" width="24" height="20" rx="4" fill="rgba(184,138,74,0.15)" stroke="var(--alc-accent-deep)" strokeWidth="1.5" />
                <path d="M9 13 H23 M9 17 H19 M9 21 H21" stroke="var(--alc-accent-deep)" strokeWidth="1.4" strokeLinecap="round" />
              </svg>
            }
          />
          <div key={`a1-${idx}`} className="layer-swap-edge">
            <Arrow label="Layer.effect" color={active.color} />
          </div>
          <div key={`l-${idx}`} className="layer-swap-node">
            <Node label={active.layerName} sub="Layer" color={active.color} accent icon={<LayerStack color={active.color} />} />
          </div>
          <div key={`a2-${idx}`} className="layer-swap-edge">
            <Arrow label={active.bind} color={active.color} />
          </div>
          <div key={`r-${idx}`} className="layer-swap-node">
            <Node label={active.resourceLabel} sub={active.resourceSub} color={active.color} icon={<ResourceIcon kind={active.iconKind} color={active.color} />} />
          </div>
        </div>
      </div>
    </div>
  );
}
