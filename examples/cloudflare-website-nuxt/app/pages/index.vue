<script setup lang="ts">
// Calls the Effect API served by this same Worker — src/backend.ts owns /api/*
// and backs it with a KV namespace. Client-only (`server: false`): during
// SSR nitro's internal fetch bypasses the Worker entry where the Effect
// routes are mounted.
const { data: api } = useFetch<{ visits: number }>("/api/visits", {
  server: false,
});
</script>

<template>
  <main class="mx-auto max-w-2xl p-8">
    <h1 class="text-3xl font-bold">Nuxt on Cloudflare Workers</h1>
    <p class="mt-2 text-sm text-gray-500">
      {{
        api ? `This page has been visited ${api.visits} times.`
            : "Loading visits…"
      }}
    </p>
    <NuxtLink class="mt-4 inline-block underline" to="/about"
      >about (prerendered)</NuxtLink
    >
  </main>
</template>
