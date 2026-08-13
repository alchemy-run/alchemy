// SSR seam: VALUE import + `createClient(Backend)` — the backend method
// dispatches directly in-process (no HTTP hop) inside the async server
// component, in the deployed Lambda and under `next dev` alike.
import { createClient } from "alchemy/client";
import Backend from "./backend.ts";
import MessageForm from "./message-form.tsx";

// Server-rendered in the Lambda on every request — a prerendered page
// must not call the backend server-side.
export const dynamic = "force-dynamic";

const backend = createClient(Backend);

export default async function Home() {
  const message = await backend.get();
  return (
    <main className="mx-auto max-w-2xl p-8">
      <div className="rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
        <h1 className="text-3xl font-bold">Next.js on AWS</h1>
        <p className="mt-2 text-sm text-gray-500">
          Rendered at {new Date().toISOString()}
        </p>
        <p className="mt-4">
          Server-rendered message (S3-backed, loaded in-process by this server
          component): <span className="font-semibold">{message ?? "(nothing saved yet)"}</span>
        </p>
        <MessageForm initial={message} />
      </div>
    </main>
  );
}
