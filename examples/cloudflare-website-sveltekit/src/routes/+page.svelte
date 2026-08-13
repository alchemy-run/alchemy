<script lang="ts">
  // The TYPE-ONLY form: zero backend bytes in the browser bundle — methods
  // POST to /api/__rpc/<method> on this same Worker. The SSR value comes
  // from +page.server.ts (the value form, direct in-process dispatch).
  import { createClient } from "alchemy/client";
  import type Backend from "../backend.ts";

  const backend = createClient<typeof Backend>();

  let { data } = $props();
  let visits = $state(data.visits);
</script>

<main class="mx-auto max-w-2xl p-8">
  <h1 class="text-3xl font-bold">SvelteKit on Cloudflare Workers</h1>
  <div
    class="mt-6 max-w-md rounded-xl border border-slate-300 bg-white p-6 shadow-sm"
  >
    <p class="m-0 text-sm text-gray-500">
      Visits (rendered on the server via the backend client):
    </p>
    <p class="mt-2 text-4xl font-bold" data-testid="count">{visits}</p>
    <button
      class="mt-4 cursor-pointer rounded-lg bg-slate-900 px-4 py-2 text-white"
      onclick={async () => {
        visits = await backend.visit();
      }}
    >
      Visit again
    </button>
  </div>
  <a class="mt-6 inline-block underline" href="/about">about (prerendered)</a>
</main>
