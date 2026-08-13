<script setup lang="ts">
// The TYPE-ONLY form for the browser: zero backend bytes in the client
// bundle — methods POST to /api/__rpc/<method> on this same Worker.
import { createClient } from "alchemy/client";
import type Backend from "../backend";

const backend = createClient<typeof Backend>();

// SSR seam: during server rendering the VALUE form dispatches the backend
// method in-process (no HTTP). The `import.meta.server` branch (and the
// dynamic backend import inside it) is compiled out of the client bundle,
// where the type-only client above serves client-side navigations instead.
const { data: visits } = await useAsyncData("visits", async () => {
  if (import.meta.server) {
    const { default: Backend } = await import("../backend");
    return createClient(Backend).visits();
  }
  return backend.visits();
});

const bumped = ref<number | null>(null);

async function bump() {
  bumped.value = await backend.bump();
}
</script>

<template>
  <main class="mx-auto max-w-2xl p-8">
    <h1 class="text-3xl font-bold">Nuxt on Cloudflare Workers</h1>
    <div
      class="mt-6 max-w-md rounded-xl border border-slate-300 bg-white p-6 shadow-sm"
    >
      <p class="m-0 text-sm text-gray-500">
        Server-rendered visits: <span data-testid="count">{{ visits }}</span>
      </p>
      <button
        class="mt-4 cursor-pointer rounded-lg bg-slate-900 px-4 py-2 text-white"
        @click="bump"
      >
        Bump visits
      </button>
      <p v-if="bumped !== null" class="mt-4 text-sm" data-testid="bumped">
        Client bump → {{ bumped }}
      </p>
    </div>
    <NuxtLink class="mt-6 inline-block underline" to="/about"
      >about (prerendered)</NuxtLink
    >
  </main>
</template>
