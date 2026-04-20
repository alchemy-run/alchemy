function Hero() {
  return (
    <section style={{ padding: "96px 32px 48px", maxWidth: 1152, margin: "0 auto", textAlign: "center" }}>
      <div style={{
        display: "inline-flex", alignItems: "center", gap: 8,
        padding: "5px 12px", borderRadius: 999, whiteSpace: "nowrap",
        border: "1px solid var(--alc-hairline-2)",
        fontFamily: "var(--alc-font-mono)", fontSize: 12, color: "var(--alc-fg-3)",
        marginBottom: 28,
      }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--alc-accent-bright)" }} />
        alpha · v0.1.0 · not for production
      </div>
      <h1 style={{
        fontFamily: "var(--alc-font-serif)", fontWeight: 500,
        fontSize: 76, lineHeight: 1.02, letterSpacing: "-0.015em",
        margin: 0, color: "var(--alc-fg-1)",
      }}>
        Infrastructure as{" "}
        <span style={{
          color: "var(--alc-accent-deep)",
          fontStyle: "italic",
          fontFamily: "var(--alc-font-serif)",
          fontWeight: 500,
        }}>Effects</span>.
      </h1>
      <p style={{
        fontFamily: "var(--alc-font-sans)", fontSize: 20, lineHeight: 1.55,
        color: "var(--alc-fg-3)", maxWidth: 640, margin: "22px auto 36px",
      }}>
        Your infrastructure and application logic in a single, type-safe program.
      </p>
      <div style={{ display: "flex", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
        <Button variant="primary" icon="arrow">Get Started</Button>
        <Button variant="secondary" icon="book">Tutorial</Button>
        <Button variant="ghost">View on GitHub</Button>
      </div>
    </section>
  );
}

Object.assign(window, { Hero });
