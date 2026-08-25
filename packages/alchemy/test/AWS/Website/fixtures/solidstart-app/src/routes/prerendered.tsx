/**
 * Prerendered at build time by nitro (the test passes
 * `nitro: { prerender: { routes: ["/prerendered"] } }`), so it lands in
 * `.output/public` and is served from S3 by exact match at the edge.
 */
export default function Prerendered() {
  return (
    <main>
      <h1>SOLIDSTART_AWS_PRERENDERED_MARKER</h1>
    </main>
  );
}
