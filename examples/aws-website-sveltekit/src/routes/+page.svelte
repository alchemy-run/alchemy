<script lang="ts">
  // Browser side: TYPE-ONLY import + type-only form — zero backend bytes
  // in the client bundle. Each call POSTs the wire protocol
  // (`/api/__rpc/bump`) to the same Lambda. The SSR value arrives via
  // +page.server.ts, which calls `visits()` in-process (value form).
  import { createClient } from "alchemy/client";
  import type Backend from "../backend.ts";

  const backend = createClient<typeof Backend>();

  let { data } = $props();
  let bumped = $state<number | null>(null);

  async function bump() {
    bumped = await backend.bump();
  }

  // The async leg: `enqueue` sends to SQS and returns immediately — the
  // sibling consumer Lambda catches up out of band. Poll `processed()`
  // (bounded) until the count moves so the catch-up is visible.
  let queueText = $state("");
  let processed = $state(data.processed);

  async function enqueue() {
    const before = processed.count;
    await backend.enqueue(queueText || "hello queue");
    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      processed = await backend.processed();
      if (processed.count > before) break;
    }
  }
</script>

<main class="mx-auto max-w-2xl p-8">
  <div class="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
    <h1 class="text-3xl font-bold">SvelteKit on AWS</h1>
    <p class="mt-4">
      Server-rendered visits: <span id="visits" class="font-semibold">{data.visits}</span>
    </p>
    <button
      class="mt-2 rounded border border-slate-300 px-3 py-1 hover:bg-slate-100"
      onclick={bump}
    >
      Bump visits
    </button>
    {#if bumped !== null}
      <p class="mt-2">Client bump → <span class="font-semibold">{bumped}</span></p>
    {/if}
    <div class="mt-6 border-t border-slate-200 pt-4">
      <div class="flex gap-2">
        <input
          class="rounded border border-slate-300 px-3 py-1"
          placeholder="hello queue"
          bind:value={queueText}
        />
        <button
          class="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100"
          onclick={enqueue}
        >
          Send to queue
        </button>
      </div>
      <p class="mt-2">
        Queue-processed: <span class="font-semibold">{processed.count}</span>
        — last: <span class="font-semibold">{processed.last ?? "—"}</span>
      </p>
    </div>
    <p class="mt-4">
      <a class="underline" href="/about">about (prerendered)</a>
    </p>
  </div>
</main>
