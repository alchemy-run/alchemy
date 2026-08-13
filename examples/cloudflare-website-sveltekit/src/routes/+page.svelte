<script>
  import { onMount } from "svelte";

  let { data } = $props();
  let visits = $state(null);

  onMount(async () => {
    // Calls the Effect API served by this same Worker — src/backend.ts owns
    // /api/* and backs it with a KV namespace.
    const res = await fetch("/api/visits");
    visits = (await res.json()).visits;
  });
</script>

<main class="mx-auto max-w-2xl p-8">
  <h1 class="text-3xl font-bold">SvelteKit on Cloudflare Workers</h1>
  <p class="mt-4 text-lg">{data.greeting}</p>
  <p class="mt-2 text-sm text-gray-500">
    {visits === null
      ? "Loading visits…"
      : `This page has been visited ${visits} times.`}
  </p>
  <a class="mt-4 inline-block underline" href="/about">about (prerendered)</a>
</main>
