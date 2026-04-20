// Terminal — recreation of the site's <Terminal content="..." /> widget.
// Accepts plain text with inline [g]…[/g] [b]…[/b] [d]…[/d] [u]…[/u] [c]…[/c] [s2] tokens.

function Terminal({ content }) {
  const parsed = parseTerm(content);
  return (
    <div style={{
      background: "var(--alc-bg-code)",
      border: "1px solid var(--alc-hairline)",
      borderRadius: 8, overflow: "hidden",
    }}>
      <div style={{
        display: "flex", alignItems: "center", gap: 6,
        padding: "10px 14px",
        borderBottom: "1px solid var(--alc-hairline)",
      }}>
        <span style={dot("var(--alc-danger)")} />
        <span style={dot("var(--alc-warn)")} />
        <span style={dot("var(--alc-accent-bright)")} />
        <span style={{ fontFamily: "var(--alc-font-mono)", fontSize: 11, color: "var(--alc-code-comment)", marginLeft: 10 }}>
          ~/my-app
        </span>
      </div>
      <pre style={{
        margin: 0, padding: "14px 18px",
        fontFamily: "var(--alc-font-mono)", fontSize: 13, lineHeight: 1.7,
        color: "var(--alc-code-var)", whiteSpace: "pre-wrap",
      }}>{parsed}</pre>
    </div>
  );
}

function dot(c) {
  return { width: 10, height: 10, borderRadius: "50%", background: c, display: "inline-block" };
}

function parseTerm(s) {
  // very simple bracket tag parser, good enough for mock content
  const re = /\[(g|b|d|u|c|s2)\](.*?)\[\/\1\]|\[s2\]/g;
  const styles = {
    g: { color: "var(--alc-code-string)" },
    b: { color: "var(--alc-fg-invert)", fontWeight: 600 },
    d: { color: "var(--alc-code-comment)" },
    u: { textDecoration: "underline", color: "var(--alc-fg-invert)" },
    c: { color: "var(--alc-code-type)" },
  };
  const out = [];
  let last = 0, m, i = 0;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push(s.slice(last, m.index));
    if (m[0] === "[s2]") {
      out.push(<span key={i++}>{"  "}</span>);
    } else {
      out.push(<span key={i++} style={styles[m[1]]}>{m[2]}</span>);
    }
    last = re.lastIndex;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}

Object.assign(window, { Terminal });
