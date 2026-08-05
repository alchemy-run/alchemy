import { getCloudflareContext } from "@opennextjs/cloudflare";

// Server-rendered in the Worker on every request.
export const dynamic = "force-dynamic";

export default function Home() {
  const { env } = getCloudflareContext();
  return (
    <main>
      <h1>Next.js on Cloudflare Workers</h1>
      <p>{env.GREETING ?? "no greeting bound"}</p>
      <p>Rendered at {new Date().toISOString()}</p>
    </main>
  );
}
