// Shared shell: Button, Nav, Footer, Eyebrow, SectionTitle, Badge, DiscordCallout
const { useState, useEffect } = React;

function Button({ variant = "primary", icon, children, href = "#", ...rest }) {
  const base = {
    fontFamily: "var(--alc-font-sans)",
    fontSize: 14,
    fontWeight: 500,
    padding: "10px 18px",
    borderRadius: 8,
    border: "1px solid transparent",
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    whiteSpace: "nowrap",
    cursor: "pointer",
    textDecoration: "none",
    transition: "background 120ms var(--alc-ease), border-color 120ms var(--alc-ease), color 120ms var(--alc-ease)",
  };
  const variants = {
    primary:   { background: "var(--alc-accent)", color: "var(--alc-fg-on-accent)" },
    secondary: { background: "transparent", borderColor: "var(--alc-hairline-3)", color: "var(--alc-fg-1)" },
    ghost:     { background: "transparent", color: "var(--alc-fg-2)" },
    accent:    { background: "var(--alc-terracotta)", color: "var(--alc-fg-on-accent)" },
  };
  return (
    <a href={href} {...rest} style={{ ...base, ...variants[variant], ...(rest.style || {}) }}>
      {children}
      {icon === "arrow" && <span aria-hidden style={{ fontSize: 14 }}>→</span>}
      {icon === "book" && <span aria-hidden style={{ fontSize: 14 }}>❏</span>}
      {icon === "github" && <span aria-hidden style={{ fontSize: 14 }}>☰</span>}
      {icon === "discord" && <span aria-hidden style={{ fontSize: 14 }}>✱</span>}
    </a>
  );
}

function Logo({ size = 22 }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <span style={{ width: 14, height: 14, borderRadius: "50%", background: "var(--alc-accent)" }} />
      <span style={{
        fontFamily: "var(--alc-font-serif)", fontStyle: "italic",
        fontWeight: 500, fontSize: size, color: "var(--alc-fg-1)", letterSpacing: "-0.01em",
      }}>alchemy</span>
    </span>
  );
}

function Nav({ currentTrack }) {
  const links = [
    { href: "/landing", label: "Overview" },
    { href: "/effect", label: "Effect" },
    { href: "/iac", label: "IaC" },
    { href: "/cloud", label: "Cloud" },
    { href: "/ai", label: "AI" },
  ];
  return (
    <nav style={{
      position: "sticky", top: 0, zIndex: 10,
      height: 64, display: "flex", alignItems: "center",
      padding: "0 32px", gap: 32,
      background: "color-mix(in srgb, var(--alc-bg-nav) 92%, transparent)",
      backdropFilter: "saturate(140%) blur(8px)",
      borderBottom: "1px solid var(--alc-hairline)",
    }}>
      <a href="/landing" style={{ textDecoration: "none" }}>
        <Logo />
      </a>
      <div style={{ display: "flex", gap: 4, fontSize: 13, fontFamily: "var(--alc-font-mono)" }}>
        {links.map(l => (
          <a key={l.href} href={l.href} style={{
            padding: "6px 10px",
            borderRadius: 6,
            textDecoration: "none",
            color: currentTrack === l.label.toLowerCase() ? "var(--alc-accent-deep)" : "var(--alc-fg-3)",
            background: currentTrack === l.label.toLowerCase() ? "var(--alc-accent-12)" : "transparent",
            fontSize: 12,
            letterSpacing: "0.04em",
            textTransform: "uppercase",
          }}>{l.label}</a>
        ))}
      </div>
      <div style={{ flex: 1 }} />
      <div style={{
        display: "flex", alignItems: "center",
        width: 220, height: 32, padding: "0 8px 0 12px",
        background: "var(--alc-bg)", border: "1px solid var(--alc-hairline-2)",
        borderRadius: 8, fontSize: 13,
      }}>
        <span style={{ color: "var(--alc-fg-4)", marginRight: 8 }}>⌕</span>
        <span style={{ color: "var(--alc-fg-4)", fontSize: 12 }}>Search docs</span>
        <span style={{ flex: 1 }} />
        <span style={kbd}>⌘</span><span style={kbd}>K</span>
      </div>
      <a href="#" style={navLink}>Docs</a>
      <a href="#" style={navLink}>GitHub</a>
      <a href="#" style={navLink}>Discord</a>
      <Button variant="primary" icon="arrow">Get Started</Button>
    </nav>
  );
}

const navLink = {
  color: "var(--alc-fg-2)", textDecoration: "none", fontSize: 14,
};
const kbd = {
  fontFamily: "var(--alc-font-mono)", fontSize: 11,
  background: "var(--alc-bg-elev-1)",
  border: "1px solid var(--alc-hairline-2)",
  borderRadius: 4, padding: "1px 5px", color: "var(--alc-fg-2)",
  marginLeft: 3,
};

function AlphaBadge() {
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 8,
      padding: "5px 12px", borderRadius: 999, whiteSpace: "nowrap",
      border: "1px solid var(--alc-hairline-2)",
      background: "var(--alc-bg-elev-1)",
      fontFamily: "var(--alc-font-mono)", fontSize: 11.5, color: "var(--alc-fg-3)",
      letterSpacing: "0.02em",
    }}>
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--alc-terracotta)" }} />
      alpha · v0.2.0 · not for production
    </div>
  );
}

function Eyebrow({ children, color }) {
  return (
    <div className="alc-eyebrow" style={{
      color: color || "var(--alc-accent-deep)",
    }}>{children}</div>
  );
}

function DiscordCallout() {
  return (
    <div style={{
      maxWidth: 760, margin: "0 auto",
      padding: "16px 20px",
      background: "var(--alc-bg-elev-1)",
      border: "1px solid var(--alc-hairline)",
      borderRadius: 10,
      display: "flex", alignItems: "center", gap: 16,
      fontFamily: "var(--alc-font-sans)",
    }}>
      <span style={{ fontFamily: "var(--alc-font-hand)", fontSize: 30, color: "var(--alc-accent-deep)", lineHeight: 1 }}>hey —</span>
      <div style={{ flex: 1, fontSize: 14, color: "var(--alc-fg-2)", lineHeight: 1.5 }}>
        alchemy is in alpha and not ready for production use (expect breaking changes).
        Come hang in our Discord to participate in the early stages of development.
      </div>
      <Button variant="secondary" icon="discord">Join Discord</Button>
    </div>
  );
}

function Footer() {
  return (
    <footer style={{
      padding: "40px 32px",
      borderTop: "1px solid var(--alc-hairline)",
      background: "var(--alc-bg-nav)",
    }}>
      <div style={{ maxWidth: 1152, margin: "0 auto", display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr 1fr", gap: 40 }}>
        <div>
          <Logo />
          <p style={{
            fontFamily: "var(--alc-font-sans)", fontSize: 13, lineHeight: 1.6,
            color: "var(--alc-fg-3)", margin: "14px 0 0",
          }}>
            Infrastructure as Effects. A single, type-safe TypeScript program for your cloud.
          </p>
          <div style={{ marginTop: 16, fontFamily: "var(--alc-font-mono)", fontSize: 11, color: "var(--alc-fg-4)" }}>
            Apache-2.0 · © 2026
          </div>
        </div>
        {[
          { h: "Product", links: ["Docs", "Tutorial", "Examples", "Providers", "Changelog"] },
          { h: "Tracks", links: ["Effect", "IaC", "Cloud", "AI"] },
          { h: "Community", links: ["Discord", "GitHub", "X / Twitter", "Blog"] },
          { h: "Compare", links: ["vs Pulumi", "vs SST", "vs Terraform", "vs CDK"] },
        ].map(col => (
          <div key={col.h}>
            <div style={{ fontFamily: "var(--alc-font-mono)", fontSize: 11, letterSpacing: "0.12em", textTransform: "uppercase", color: "var(--alc-fg-4)", marginBottom: 12 }}>
              {col.h}
            </div>
            <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
              {col.links.map(l => (
                <li key={l}>
                  <a href="#" style={{ textDecoration: "none", color: "var(--alc-fg-2)", fontSize: 13 }}>{l}</a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </footer>
  );
}

// Code block & terminal — shared
function CodeBlock({ filename = "alchemy.run.ts", children, compact, maxHeight }) {
  return (
    <div style={{
      background: "var(--alc-bg-code)", border: "1px solid var(--alc-hairline)",
      borderRadius: 10, overflow: "hidden",
      boxShadow: "var(--alc-shadow-sm)",
      display: "flex", flexDirection: "column",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "10px 14px",
        borderBottom: "1px solid rgba(232,220,192,0.08)",
        background: "rgba(255,255,255,0.02)",
        flex: "0 0 auto",
      }}>
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--alc-danger)" }} />
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--alc-warn)" }} />
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--alc-accent-bright)" }} />
        <span style={{ marginLeft: 10, fontFamily: "var(--alc-font-mono)", fontSize: 11, color: "var(--alc-code-comment)" }}>
          {filename}
        </span>
      </div>
      <pre style={{
        margin: 0, padding: compact ? "12px 16px" : "18px 20px",
        fontFamily: "var(--alc-font-mono)", fontSize: compact ? 12 : 13, lineHeight: 1.7,
        color: "var(--alc-code-var)",
        overflowX: "auto",
        overflowY: maxHeight ? "auto" : "visible",
        maxHeight: maxHeight || "none",
      }}>{children}</pre>
    </div>
  );
}

const T = {
  k: (s) => <span style={{ color: "var(--alc-code-keyword)" }}>{s}</span>,
  s: (s) => <span style={{ color: "var(--alc-code-string)" }}>{s}</span>,
  f: (s) => <span style={{ color: "var(--alc-code-fn)" }}>{s}</span>,
  t: (s) => <span style={{ color: "var(--alc-code-type)" }}>{s}</span>,
  c: (s) => <span style={{ color: "var(--alc-code-comment)", fontStyle: "italic" }}>{s}</span>,
  v: (s) => <span style={{ color: "var(--alc-code-var)" }}>{s}</span>,
  n: (s) => <span style={{ color: "var(--alc-code-literal)" }}>{s}</span>,
  err: (s) => <span style={{ color: "var(--alc-danger)", textDecoration: "underline wavy var(--alc-danger)", textUnderlineOffset: 4 }}>{s}</span>,
};

function Terminal({ title = "~/my-app", content }) {
  const parsed = parseTerm(content);
  return (
    <div style={{
      background: "var(--alc-bg-code)",
      border: "1px solid var(--alc-hairline)",
      borderRadius: 10, overflow: "hidden",
      boxShadow: "var(--alc-shadow-sm)",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "10px 14px",
        borderBottom: "1px solid rgba(232,220,192,0.08)",
        background: "rgba(255,255,255,0.02)",
      }}>
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--alc-danger)" }} />
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--alc-warn)" }} />
        <span style={{ width: 10, height: 10, borderRadius: "50%", background: "var(--alc-accent-bright)" }} />
        <span style={{ marginLeft: 10, fontFamily: "var(--alc-font-mono)", fontSize: 11, color: "var(--alc-code-comment)" }}>
          {title}
        </span>
      </div>
      <pre style={{
        margin: 0, padding: "16px 18px",
        fontFamily: "var(--alc-font-mono)", fontSize: 12.5, lineHeight: 1.75,
        color: "var(--alc-code-var)", whiteSpace: "pre-wrap",
      }}>{parsed}</pre>
    </div>
  );
}

function parseTerm(s) {
  const re = /\[(g|b|d|u|c|s2|a|w|r|y)\](.*?)\[\/\1\]|\[s2\]/g;
  const styles = {
    g: { color: "var(--alc-success)" },
    b: { color: "var(--alc-fg-invert)", fontWeight: 600 },
    d: { color: "var(--alc-code-comment)" },
    u: { textDecoration: "underline", color: "var(--alc-fg-invert)" },
    c: { color: "var(--alc-code-type)" },
    a: { color: "var(--alc-code-fn)" },
    w: { color: "var(--alc-warn)" },
    r: { color: "var(--alc-danger)" },
    y: { color: "var(--alc-code-string)" },
  };
  const out = [];
  let last = 0, m, i = 0;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[0] === "[s2]") out.push(<span key={i++}>{"  "}</span>);
    else out.push(<span key={i++} style={styles[m[1]]}>{m[2]}</span>);
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

// Section wrapper
function Section({ children, style, maxWidth = 1152, padding = "88px 32px" }) {
  return (
    <section style={{ padding, ...style }}>
      <div style={{ maxWidth, margin: "0 auto" }}>{children}</div>
    </section>
  );
}

// Sketch label (Caveat)
function SketchLabel({ children, style }) {
  return (
    <span style={{
      fontFamily: "var(--alc-font-hand)", fontSize: 28,
      color: "var(--alc-accent-deep)", fontWeight: 600,
      ...style,
    }}>{children}</span>
  );
}

// Tweaks panel — track switcher
function TweaksPanel({ currentTrack }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const onMsg = (e) => {
      if (!e.data) return;
      if (e.data.type === "__activate_edit_mode") setVisible(true);
      if (e.data.type === "__deactivate_edit_mode") setVisible(false);
    };
    window.addEventListener("message", onMsg);
    window.parent.postMessage({ type: "__edit_mode_available" }, "*");
    return () => window.removeEventListener("message", onMsg);
  }, []);
  if (!visible) return null;
  const tracks = [
    { key: "overview", label: "Overview (index)", file: "/landing" },
    { key: "effect",   label: "1. Effect community", file: "/effect" },
    { key: "iac",      label: "2. IaC comparison", file: "/iac" },
    { key: "cloud",    label: "3. Cloud-first", file: "/cloud" },
    { key: "ai",       label: "4. AI vibe-coders", file: "/ai" },
  ];
  return (
    <div style={{
      position: "fixed", bottom: 20, right: 20, zIndex: 999,
      width: 280,
      background: "var(--alc-bg-elev-1)",
      border: "1px solid var(--alc-hairline-2)",
      borderRadius: 10,
      boxShadow: "var(--alc-shadow-lg)",
      padding: 16,
      fontFamily: "var(--alc-font-sans)",
    }}>
      <div style={{
        fontFamily: "var(--alc-font-mono)", fontSize: 11,
        letterSpacing: "0.12em", textTransform: "uppercase",
        color: "var(--alc-fg-4)", marginBottom: 10,
      }}>Tweaks · Track</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {tracks.map(t => {
          const active = t.key === currentTrack;
          return (
            <a key={t.key} href={t.file} style={{
              display: "flex", alignItems: "center", gap: 10,
              padding: "8px 10px", borderRadius: 6,
              textDecoration: "none",
              fontSize: 13,
              background: active ? "var(--alc-accent-12)" : "transparent",
              border: active ? "1px solid var(--alc-accent-40)" : "1px solid transparent",
              color: active ? "var(--alc-accent-deep)" : "var(--alc-fg-2)",
              fontWeight: active ? 600 : 400,
            }}>
              <span style={{
                width: 8, height: 8, borderRadius: "50%",
                background: active ? "var(--alc-accent)" : "var(--alc-walnut-300)",
              }} />
              {t.label}
            </a>
          );
        })}
      </div>
      <div style={{
        marginTop: 12, paddingTop: 12,
        borderTop: "1px solid var(--alc-hairline)",
        fontSize: 11, color: "var(--alc-fg-4)", lineHeight: 1.4,
      }}>
        Each page is a full standalone landing exploring a different angle.
      </div>
    </div>
  );
}

Object.assign(window, {
  Button, Logo, Nav, AlphaBadge, Eyebrow, DiscordCallout, Footer,
  CodeBlock, T, Terminal, Section, SketchLabel, TweaksPanel,
});
