function ProviderCards() {
  const cards = [
    { title: "Cloudflare", body: "Workers, R2 Buckets, KV, D1, Durable Objects, Queues, Vectorize, AI" },
    { title: "AWS",        body: "Lambda, S3, DynamoDB, SQS, Kinesis, IAM, EC2, API Gateway" },
    { title: "More",       body: "GitHub, Stripe, DNS, and a growing ecosystem of community providers" },
  ];
  return (
    <section style={{ padding: "0 32px 80px", maxWidth: 1152, margin: "0 auto", textAlign: "center" }}>
      <h3 style={{
        fontFamily: "var(--alc-font-serif)", fontWeight: 500, fontSize: 34,
        letterSpacing: "-0.01em", color: "var(--alc-fg-1)", margin: "0 0 12px",
      }}>Cloud providers</h3>
      <p style={{
        fontFamily: "var(--alc-font-sans)", fontSize: 15, lineHeight: 1.6,
        color: "var(--alc-fg-3)", maxWidth: 560, margin: "0 auto 40px",
      }}>
        Alchemy supports multiple cloud providers with more being added. Each provider is a typed Layer that the compiler verifies at build time.
      </p>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
        {cards.map((c) => (
          <div key={c.title} className="alc-provider-card" style={{
            background: "var(--alc-bg-elev-1)",
            border: "1px solid var(--alc-hairline)",
            borderRadius: 8, padding: 24,
            textAlign: "left", display: "flex", flexDirection: "column", gap: 10,
            transition: "border-color 150ms var(--alc-ease)",
          }}>
            <strong style={{ fontFamily: "var(--alc-font-sans)", fontSize: 17, fontWeight: 600, color: "var(--alc-fg-1)" }}>
              {c.title}
            </strong>
            <p style={{ fontSize: 14, lineHeight: 1.55, color: "var(--alc-fg-3)", margin: 0 }}>{c.body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section style={{
      padding: "64px 32px 80px",
      borderTop: "1px solid var(--alc-hairline)",
      textAlign: "center",
    }}>
      <h3 style={{ fontFamily: "var(--alc-font-serif)", fontWeight: 500, fontSize: 34, letterSpacing: "-0.01em", margin: "0 0 12px", color: "var(--alc-fg-1)" }}>
        Ready to start?
      </h3>
      <p style={{ color: "var(--alc-fg-3)", maxWidth: 560, margin: "0 auto 28px", fontSize: 15, lineHeight: 1.6 }}>
        Follow the tutorial to go from zero to a deployed Cloudflare Worker with R2 bindings, integration tests, local dev, and CI/CD — in under 30 minutes.
      </p>
      <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
        <Button variant="primary" icon="arrow">Start the Tutorial</Button>
        <Button variant="secondary" icon="book">Quick Start</Button>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer style={{
      padding: "32px", borderTop: "1px solid var(--alc-hairline)",
      display: "flex", justifyContent: "space-between", alignItems: "center",
      fontFamily: "var(--alc-font-mono)", fontSize: 12, color: "var(--alc-fg-4)",
    }}>
      <span>© alchemy · Apache-2.0</span>
      <div style={{ display: "flex", gap: 20 }}>
        <a href="#" style={{ color: "var(--alc-fg-4)", textDecoration: "none" }}>GitHub</a>
        <a href="#" style={{ color: "var(--alc-fg-4)", textDecoration: "none" }}>Discord</a>
        <a href="#" style={{ color: "var(--alc-fg-4)", textDecoration: "none" }}>npm</a>
      </div>
    </footer>
  );
}

Object.assign(window, { ProviderCards, CTA, Footer });
