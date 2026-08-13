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
    <p class="mt-4">
      <a class="underline" href="/about">about (prerendered)</a>
    </p>
  </div>
</main>
