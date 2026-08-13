import { getCloudflareContext } from "@opennextjs/cloudflare";

// Server-rendered in the Worker on every request.
export const dynamic = "force-dynamic";

export default function Home() {
  const { env } = getCloudflareContext();
  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-3xl font-bold">Next.js on Cloudflare Workers</h1>
      <p className="mt-4 text-lg">{env.GREETING ?? "no greeting bound"}</p>
      <p className="mt-2 text-sm text-gray-500">
        Rendered at {new Date().toISOString()}
      </p>
    </main>
  );
}
