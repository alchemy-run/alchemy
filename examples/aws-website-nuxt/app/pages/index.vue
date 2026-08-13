<script setup lang="ts">
// Browser side: TYPE-ONLY import + type-only form — zero backend bytes
// in the client bundle. Each call POSTs the wire protocol
// (`/api/__rpc/<method>`), dispatched by the alchemy server middleware.
import { createClient } from "alchemy/client";
import type Backend from "../backend";

const backend = createClient<typeof Backend>();

// SSR seam: `useAsyncData` runs the handler on the server during SSR —
// there the VALUE form dispatches the backend method in-process (no HTTP
// hop). The `import.meta.server` guard keeps the dynamic backend import
// out of the client bundle; on client-side navigation the handler takes
// the wire path through the same typed client.
const { data: message } = await useAsyncData("message", async () => {
  if (import.meta.server) {
    const { default: Backend } = await import("../backend");
    return createClient(Backend).get();
  }
  return backend.get();
});

const draft = ref("");

const save = async () => {
  message.value = await backend.save(draft.value);
  draft.value = "";
};
</script>

<template>
  <main class="mx-auto max-w-2xl p-8">
    <div class="rounded-xl border border-gray-200 bg-white p-8 shadow-sm">
      <h1 class="text-3xl font-bold">Nuxt on AWS</h1>
      <p class="mt-4">
        Server-rendered message (S3-backed, loaded in-process during SSR):
        <span class="font-semibold">{{ message ?? "(nothing saved yet)" }}</span>
      </p>
      <form class="mt-2 flex gap-2" @submit.prevent="save">
        <input
          v-model="draft"
          class="rounded border px-2 py-1"
          placeholder="say something"
        />
        <button class="rounded border px-3 py-1" type="submit">Save</button>
      </form>
      <NuxtLink class="mt-4 inline-block underline" to="/about"
        >about (prerendered)</NuxtLink
      >
    </div>
  </main>
</template>
