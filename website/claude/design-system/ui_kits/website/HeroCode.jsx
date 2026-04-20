function HeroCode({ children }) {
  return (
    <div style={{
      background: "var(--alc-bg-code)", border: "1px solid var(--alc-hairline)",
      borderRadius: 8, overflow: "hidden",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 14px", borderBottom: "1px solid rgba(232,220,192,0.08)" }}>
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--alc-danger)" }} />
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--alc-warn)" }} />
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--alc-accent-bright)" }} />
        <span style={{ marginLeft: 8, fontFamily: "var(--alc-font-mono)", fontSize: 11, color: "var(--alc-code-comment)" }}>
          alchemy.run.ts
        </span>
      </div>
      <pre style={{
        margin: 0, padding: "16px 18px",
        fontFamily: "var(--alc-font-mono)", fontSize: 13, lineHeight: 1.65,
        color: "var(--alc-code-var)", overflowX: "auto",
      }}>{children}</pre>
    </div>
  );
}

// Not real syntax highlighting; just enough color to look right.
const T = {
  k: (s) => <span style={{ color: "var(--alc-code-keyword)" }}>{s}</span>,
  s: (s) => <span style={{ color: "var(--alc-code-string)" }}>{s}</span>,
  f: (s) => <span style={{ color: "var(--alc-code-fn)" }}>{s}</span>,
  t: (s) => <span style={{ color: "var(--alc-code-type)" }}>{s}</span>,
  c: (s) => <span style={{ color: "var(--alc-code-comment)", fontStyle: "italic" }}>{s}</span>,
  v: (s) => <span style={{ color: "var(--alc-code-var)" }}>{s}</span>,
  n: (s) => <span style={{ color: "var(--alc-code-literal)" }}>{s}</span>,
};

Object.assign(window, { HeroCode, T });
