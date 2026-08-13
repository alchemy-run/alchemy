<script lang="ts">
  // Browser side: TYPE-ONLY import + type-only form — zero backend bytes
  // in the client bundle. Each call POSTs the wire protocol
  // (`/api/__rpc/<method>`) to the same Lambda. The SSR value arrives via
  // +page.server.ts, which calls the SAME method in-process (value form).
  import { createClient } from "alchemy/client";
  import type Backend from "../backend.ts";

  const backend = createClient<typeof Backend>();

  let { data } = $props();
  let message = $state(data.message ?? "(nothing saved yet)");
  let draft = $state("");

  async function save() {
    message = await backend.save(draft);
    draft = "";
  }
</script>

<main class="mx-auto max-w-2xl p-8">
  <div class="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
    <h1 class="text-3xl font-bold">SvelteKit on AWS</h1>
    <p class="mt-4">
      Server-rendered message (S3-backed, loaded in-process by
      <code>+page.server.ts</code>): <span class="font-semibold">{message}</span>
    </p>
    <form
      class="mt-2 flex gap-2"
      onsubmit={(e) => (e.preventDefault(), save())}
    >
      <input
        class="rounded border px-2 py-1"
        placeholder="say something"
        bind:value={draft}
      />
      <button class="rounded border px-3 py-1" type="submit">Save</button>
    </form>
    <a class="mt-4 inline-block underline" href="/about">about (prerendered)</a>
  </div>
</main>
