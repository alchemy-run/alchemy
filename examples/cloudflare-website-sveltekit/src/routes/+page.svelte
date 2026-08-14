<script lang="ts">
  // The TYPE-ONLY form: zero backend bytes in the browser bundle — methods
  // POST to /api/__rpc/<method> on this same Worker. The SSR value comes
  // from +page.server.ts (the value form, direct in-process dispatch).
  import { createClient } from "alchemy/client";
  import type Backend from "../backend.ts";

  const backend = createClient<typeof Backend>();

  let { data } = $props();
  let bumped: number | null = $state(null);
  let processed: { count: number; last: string | null } = $state(
    data.processed,
  );
  let queueText = $state("");

  // The async leg: enqueue a message, then poll processed() so the
  // consumer's catch-up is visible (bounded — stop once count grows).
  async function sendToQueue() {
    const before = (await backend.processed()).count;
    await backend.enqueue(queueText || "hello queue");
    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const p = await backend.processed();
      processed = p;
      if (p.count > before) break;
    }
  }
</script>

<main class="mx-auto max-w-2xl p-8">
  <h1 class="text-3xl font-bold">SvelteKit on Cloudflare Workers</h1>
  <div
    class="mt-6 max-w-md rounded-xl border border-slate-300 bg-white p-6 shadow-sm"
  >
    <p class="m-0 text-sm text-gray-500">
      Server-rendered visits: <span data-testid="count">{data.visits}</span>
    </p>
    <button
      class="mt-4 cursor-pointer rounded-lg bg-slate-900 px-4 py-2 text-white"
      onclick={async () => {
        bumped = await backend.bump();
      }}
    >
      Bump visits
    </button>
    {#if bumped !== null}
      <p class="mt-4 text-sm" data-testid="bumped">Client bump → {bumped}</p>
    {/if}
  </div>
  <div
    class="mt-6 max-w-md rounded-xl border border-slate-300 bg-white p-6 shadow-sm"
  >
    <input
      class="w-full rounded-lg border border-slate-300 px-3 py-2"
      placeholder="hello queue"
      bind:value={queueText}
    />
    <button
      class="mt-4 cursor-pointer rounded-lg bg-slate-900 px-4 py-2 text-white"
      onclick={sendToQueue}
    >
      Send to queue
    </button>
    <p class="mt-4 text-sm text-gray-500" data-testid="processed">
      Queue-processed: <span data-testid="processed-count">{processed.count}</span>
      — last: <span data-testid="processed-last">{processed.last ?? "—"}</span>
    </p>
  </div>
  <a class="mt-6 inline-block underline" href="/about">about (prerendered)</a>
</main>
