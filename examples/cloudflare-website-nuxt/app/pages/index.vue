<script setup lang="ts">
// SSR reads the Worker environment through nitro's cloudflare_module
// runtime contract: `event.context.cloudflare.env`. `useState` serializes
// the server-read value into the payload so the client render matches.
const greeting = useState("greeting", () => {
  if (import.meta.server) {
    const event = useRequestEvent();
    const env = event?.context.cloudflare?.env as
      | Record<string, unknown>
      | undefined;
    return typeof env?.GREETING === "string"
      ? env.GREETING
      : "Hello (no cloudflare env)";
  }
  return "Hello (no cloudflare env)";
});
</script>

<template>
  <main class="mx-auto max-w-2xl p-8">
    <h1 class="text-3xl font-bold">Nuxt on Cloudflare Workers</h1>
    <p class="mt-4 text-lg">{{ greeting }}</p>
    <NuxtLink class="mt-4 inline-block underline" to="/about"
      >about (prerendered)</NuxtLink
    >
  </main>
</template>
