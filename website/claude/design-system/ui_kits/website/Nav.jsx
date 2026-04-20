const { useState } = React;

function Button({ variant = "primary", icon, children, ...rest }) {
  const base = {
    fontFamily: "var(--alc-font-sans)",
    fontSize: 14,
    fontWeight: 500,
    padding: "9px 18px",
    borderRadius: 8,
    border: "1px solid transparent",
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    whiteSpace: "nowrap",
    cursor: "pointer",
    textDecoration: "none",
    transition: "background 120ms var(--alc-ease), border-color 120ms var(--alc-ease), color 120ms var(--alc-ease)",
  };
  const variants = {
    primary:   { background: "var(--alc-accent)", color: "var(--alc-fg-on-accent)" },
    secondary: { background: "transparent", borderColor: "var(--alc-hairline-3)", color: "var(--alc-fg-1)" },
    ghost:     { background: "transparent", color: "var(--alc-fg-2)" },
  };
  return (
    <a {...rest} style={{ ...base, ...variants[variant] }}>
      {children}
      {icon === "arrow" && <span style={{ fontSize: 14 }}>→</span>}
      {icon === "book" && <span style={{ fontSize: 14 }}>❏</span>}
    </a>
  );
}

function Nav() {
  return (
    <nav style={{
      position: "sticky", top: 0, zIndex: 10,
      height: 64, display: "flex", alignItems: "center",
      padding: "0 32px", gap: 32,
      background: "var(--alc-bg-nav)",
      borderBottom: "1px solid var(--alc-hairline)",
    }}>
      <a href="#" style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none" }}>
        <span style={{ width: 14, height: 14, borderRadius: "50%", background: "var(--alc-accent)" }} />
        <span style={{ fontFamily: "var(--alc-font-serif)", fontStyle: "italic", fontWeight: 500, fontSize: 22, color: "var(--alc-fg-1)", letterSpacing: "-0.01em" }}>alchemy</span>
      </a>
      <div style={{ display: "flex", gap: 24, fontSize: 14, color: "var(--alc-fg-3)" }}>
        <a href="#" style={linkStyle}>Docs</a>
        <a href="#" style={linkStyle}>Tutorial</a>
        <a href="#" style={linkStyle}>Guides</a>
        <a href="#" style={linkStyle}>Blog</a>
      </div>
      <div style={{ flex: 1 }} />
      <div style={searchStyle}>
        <span style={{ color: "var(--alc-fg-4)", marginRight: 8 }}>⌕</span>
        <span style={{ color: "var(--alc-fg-4)", fontSize: 13 }}>Search</span>
        <span style={{ flex: 1 }} />
        <span style={kbdStyle}>⌘</span>
        <span style={kbdStyle}>K</span>
      </div>
      <a href="#" style={{ ...linkStyle, display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 16 }}>☰</span> GitHub
      </a>
    </nav>
  );
}

const linkStyle = {
  color: "var(--alc-fg-3)", textDecoration: "none", fontSize: 14,
};
const searchStyle = {
  display: "flex", alignItems: "center",
  width: 280, height: 34, padding: "0 8px 0 12px",
  background: "var(--alc-bg)", border: "1px solid var(--alc-hairline-2)",
  borderRadius: 8, fontFamily: "var(--alc-font-sans)", fontSize: 13,
};
const kbdStyle = {
  fontFamily: "var(--alc-font-mono)", fontSize: 11,
  background: "var(--alc-bg-elev-1)",
  border: "1px solid var(--alc-hairline-2)",
  borderRadius: 4, padding: "1px 5px", color: "var(--alc-fg-2)",
  marginLeft: 3,
};

Object.assign(window, { Button, Nav });
