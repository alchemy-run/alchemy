<script setup lang="ts">
// The TYPE-ONLY form for the browser: zero backend bytes in the client
// bundle — methods POST to /api/__rpc/<method> on this same Worker.
import { createClient } from "alchemy/client";
import type Backend from "~~/server/backend";

const backend = createClient<typeof Backend>();

// SSR seam: during server rendering the VALUE form dispatches the backend
// method in-process (no HTTP). The `import.meta.server` branch (and the
// dynamic backend import inside it) is compiled out of the client bundle,
// where the type-only client above serves client-side navigations instead.
const { data: visits } = await useAsyncData("visits", async () => {
  if (import.meta.server) {
    const { default: Backend } = await import("~~/server/backend");
    return createClient(Backend).visits();
  }
  return backend.visits();
});

// The queue leg's SSR-rendered initial value — same isomorphic split as
// `visits` above.
const { data: processed } = await useAsyncData("processed", async () => {
  if (import.meta.server) {
    const { default: Backend } = await import("~~/server/backend");
    return createClient(Backend).processed();
  }
  return backend.processed();
});

// KNOWN GAP (Cloudflare deploys): nuxt's vite-builder resolves the
// value-form graph node-flavored in the vue SERVER build, so the SSR
// branches above currently error inside workerd ("r.once is not a
// function") and `visits`/`processed` arrive null. Until the entry's
// prebundled effect module is shared with the vue server graph, catch up
// client-side through the type-only form so the page is fully functional.
onMounted(async () => {
  if (visits.value == null) {
    visits.value = await backend.visits();
  }
  if (processed.value == null) {
    processed.value = await backend.processed();
  }
});

const bumped = ref<number | null>(null);

async function bump() {
  bumped.value = await backend.bump();
}

const queueText = ref("");

// The async leg: enqueue a message, then poll processed() so the
// consumer's catch-up is visible (bounded — stop once count grows).
async function sendToQueue() {
  const before = (await backend.processed()).count;
  await backend.enqueue(queueText.value || "hello queue");
  for (let i = 0; i < 15; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const p = await backend.processed();
    processed.value = p;
    if (p.count > before) break;
  }
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
    <div
      class="mt-6 max-w-md rounded-xl border border-slate-300 bg-white p-6 shadow-sm"
    >
      <input
        v-model="queueText"
        placeholder="hello queue"
        class="w-full rounded-lg border border-slate-300 px-3 py-2"
      />
      <button
        class="mt-4 cursor-pointer rounded-lg bg-slate-900 px-4 py-2 text-white"
        @click="sendToQueue"
      >
        Send to queue
      </button>
      <p class="mt-4 text-sm text-gray-500" data-testid="processed">
        Queue-processed:
        <span data-testid="processed-count">{{ processed?.count ?? 0 }}</span>
        — last:
        <span data-testid="processed-last">{{ processed?.last ?? "—" }}</span>
      </p>
    </div>
    <NuxtLink class="mt-6 inline-block underline" to="/about"
      >about (prerendered)</NuxtLink
    >
  </main>
</template>
