<script>
  let { data } = $props();
</script>

<main class="mx-auto max-w-2xl p-8">
  <h1 class="text-3xl font-bold">SvelteKit on AWS</h1>
  <p class="mt-4 text-lg">{data.greeting}</p>
  <a class="mt-4 inline-block underline" href="/about">about (prerendered)</a>
</main>
