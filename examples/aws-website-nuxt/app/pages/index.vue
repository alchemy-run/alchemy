<script setup lang="ts">
// Browser side: TYPE-ONLY import + type-only form — zero backend bytes
// in the client bundle. Each call POSTs the wire protocol
// (`/api/__rpc/bump`), dispatched by the alchemy server middleware.
import { createClient } from "alchemy/client";
import type Backend from "../../server/backend";

const backend = createClient<typeof Backend>();

// SSR seam: `useAsyncData` runs the handler on the server during SSR —
// there the VALUE form dispatches the backend method in-process (no HTTP
// hop). The `import.meta.server` guard keeps the dynamic backend import
// out of the client bundle; on client-side navigation the handler takes
// the wire path through the same typed client.
const { data: visits } = await useAsyncData("visits", async () => {
  if (import.meta.server) {
    const { default: Backend } = await import("../../server/backend");
    return createClient(Backend).visits();
  }
  return backend.visits();
});

const bumped = ref<number | null>(null);

const bump = async () => {
  bumped.value = await backend.bump();
};
</script>

<template>
  <main class="mx-auto max-w-2xl p-8">
    <div class="rounded-xl border border-slate-200 bg-white p-8 shadow-sm">
      <h1 class="text-3xl font-bold">Nuxt on AWS</h1>
      <p class="mt-4">
        Server-rendered visits:
        <span id="visits" class="font-semibold">{{ visits }}</span>
      </p>
      <button
        class="mt-2 rounded border border-slate-300 px-3 py-1 hover:bg-slate-100"
        @click="bump"
      >
        Bump visits
      </button>
      <p v-if="bumped !== null" class="mt-2">
        Client bump → <span class="font-semibold">{{ bumped }}</span>
      </p>
      <p class="mt-4">
        <NuxtLink class="underline" to="/about">about (prerendered)</NuxtLink>
      </p>
    </div>
  </main>
</template>
