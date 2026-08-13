<script>

  // The effect fetch owns /api/* — /api/message is the S3-backed handler
  // declared in src/backend.ts, served by the same Lambda as this page.
  let message = $state("…");
  let draft = $state("");

  async function refresh() {
    const res = await fetch("/api/message");
    message = (await res.json()).message ?? "(nothing saved yet)";
  }

  async function save() {
    const res = await fetch(`/api/message?put=${encodeURIComponent(draft)}`);
    message = (await res.json()).message;
    draft = "";
  }

  $effect(() => {
    refresh();
  });
</script>

<main class="mx-auto max-w-2xl p-8">
  <h1 class="text-3xl font-bold">SvelteKit on AWS</h1>
  <p class="mt-4">
    Saved message (from <code>/api/message</code>, S3-backed): {message}
  </p>
  <form class="mt-2 flex gap-2" onsubmit={(e) => (e.preventDefault(), save())}>
    <input
      class="rounded border px-2 py-1"
      placeholder="say something"
      bind:value={draft}
    />
    <button class="rounded border px-3 py-1" type="submit">Save</button>
  </form>
  <a class="mt-4 inline-block underline" href="/about">about (prerendered)</a>
</main>
