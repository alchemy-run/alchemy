// Server Component — renders inside the OpenNext worker on Cloudflare
// when deployed via `bun run deploy`.
//
// Wrangler's dry-run bundle step prepares the OpenNext output for the
// Cloudflare runtime. Alchemy then uploads that generated worker with
// `bundle: false`, so it does not run a second rolldown pass.
export default function HomePage() {
  return (
    <main style={{ maxWidth: "48rem", margin: "0 auto" }}>
      <h1 style={{ fontSize: "2rem", marginBottom: "0.5rem" }}>
        alchemy + Next.js on Cloudflare
      </h1>
      <p style={{ color: "#a1a1aa", marginTop: 0 }}>
        Built with OpenNext, deployed by alchemy with{" "}
        <code
          style={{
            background: "#18181b",
            padding: "0.1rem 0.35rem",
            borderRadius: "0.25rem",
            color: "#fafafa",
          }}
        >
          bundle: false
        </code>
        .
      </p>
      <p>
        This page is rendered server-side inside a Cloudflare Worker. It only
        renders correctly because alchemy uploaded the Wrangler-produced
        OpenNext worker byte-for-byte instead of running it through rolldown a
        second time.
      </p>
      <p style={{ color: "#71717a", fontSize: "0.875rem" }}>
        Rendered at <time>{new Date().toISOString()}</time>
      </p>
    </main>
  );
}
