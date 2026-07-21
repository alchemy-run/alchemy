<script>
  let { data } = $props();
</script>

<h1>SvelteKit on Cloudflare Workers</h1>
<p>{data.greeting}</p>
<a href="/about">about (prerendered)</a>
