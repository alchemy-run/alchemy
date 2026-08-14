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

// The async leg: SSR renders the initial `processed()` value (the value
// form during SSR, the wire path on client-side navigation).
const { data: processed } = await useAsyncData("processed", async () => {
  if (import.meta.server) {
    const { default: Backend } = await import("../../server/backend");
    return createClient(Backend).processed();
  }
  return backend.processed();
});

// `enqueue` sends to SQS and returns immediately — the sibling consumer
// Lambda catches up out of band. Poll `processed()` (bounded) until the
// count moves so the catch-up is visible.
const queueText = ref("");

const enqueue = async () => {
  const before = processed.value?.count ?? 0;
  await backend.enqueue(queueText.value || "hello queue");
  for (let i = 0; i < 15; i++) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const next = await backend.processed();
    processed.value = next;
    if (next.count > before) break;
  }
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
      <div class="mt-6 border-t border-slate-200 pt-4">
        <div class="flex gap-2">
          <input
            v-model="queueText"
            class="rounded border border-slate-300 px-3 py-1"
            placeholder="hello queue"
          />
          <button
            class="rounded border border-slate-300 px-3 py-1 hover:bg-slate-100"
            @click="enqueue"
          >
            Send to queue
          </button>
        </div>
        <p class="mt-2">
          Queue-processed:
          <span class="font-semibold">{{ processed?.count ?? 0 }}</span>
          — last:
          <span class="font-semibold">{{ processed?.last ?? "—" }}</span>
        </p>
      </div>
      <p class="mt-4">
        <NuxtLink class="underline" to="/about">about (prerendered)</NuxtLink>
      </p>
    </div>
  </main>
</template>
