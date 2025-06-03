<script lang="ts">
  import type { PageData } from "./$types";

  export let data: PageData;
</script>

<main>
  <h1>🚀 SvelteKit + Cloudflare + Alchemy</h1>
  <p>
    This demo shows SvelteKit running on Cloudflare Workers with Alchemy-managed
    resources.
  </p>

  <section>
    <h2>🔧 Platform Status</h2>
    <ul>
      <li>
        KV Namespace: {data.platform.hasKV
          ? "✅ Connected"
          : "❌ Not available"}
      </li>
      <li>
        R2 Bucket: {data.platform.hasR2 ? "✅ Connected" : "❌ Not available"}
      </li>
      <li>
        Execution Context: {data.platform.hasContext
          ? "✅ Available"
          : "❌ Not available"}
      </li>
    </ul>
  </section>

  {#if data.kv}
    <section>
      <h2>📦 KV Store Demo</h2>
      <div class="code-block">
        <pre>{JSON.stringify(data.kv, null, 2)}</pre>
      </div>
    </section>
  {/if}

  {#if data.r2}
    <section>
      <h2>🗄️ R2 Storage Demo</h2>
      {#if data.r2.error}
        <p class="error">Error: {data.r2.error}</p>
      {:else}
        <p><strong>Bucket Status:</strong> {data.r2.bucketName}</p>
        <p><strong>Objects in bucket:</strong> {data.r2.objectCount}</p>

        {#if data.r2.objects && data.r2.objects.length > 0}
          <h3>Recent Objects:</h3>
          <div class="objects-list">
            {#each data.r2.objects as obj}
              <div class="object-item">
                <strong>{obj.key}</strong> - {obj.size} bytes
                <small
                  >(modified: {new Date(obj.modified).toLocaleString()})</small
                >
              </div>
            {/each}
          </div>
        {:else}
          <p><em>No objects in bucket yet</em></p>
        {/if}
      {/if}
    </section>
  {/if}

  <section>
    <h2>📚 Documentation</h2>
    <p>
      Visit <a href="https://svelte.dev/docs/kit">svelte.dev/docs/kit</a> to read
      the SvelteKit documentation
    </p>
    <p>
      Visit <a href="https://alchemy.run">alchemy.run</a> to learn more about Alchemy
    </p>
  </section>
</main>

<style>
  main {
    max-width: 800px;
    margin: 0 auto;
    padding: 2rem;
    font-family: system-ui, sans-serif;
  }

  h1 {
    color: #ff3e00;
    margin-bottom: 1rem;
  }

  section {
    margin: 2rem 0;
    padding: 1.5rem;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    background: #f9f9f9;
  }

  .code-block {
    background: #f4f4f4;
    border: 1px solid #ddd;
    border-radius: 4px;
    padding: 1rem;
    margin: 1rem 0;
    overflow-x: auto;
  }

  .objects-list {
    margin-top: 1rem;
  }

  .object-item {
    background: white;
    border: 1px solid #ddd;
    border-radius: 4px;
    padding: 0.75rem;
    margin: 0.5rem 0;
  }

  .object-item small {
    display: block;
    color: #666;
    margin-top: 0.25rem;
  }

  .error {
    color: #dc3545;
    font-weight: bold;
  }

  ul {
    list-style: none;
    padding: 0;
  }

  li {
    padding: 0.5rem 0;
    font-family: monospace;
  }

  a {
    color: #ff3e00;
    text-decoration: none;
  }

  a:hover {
    text-decoration: underline;
  }
</style>
