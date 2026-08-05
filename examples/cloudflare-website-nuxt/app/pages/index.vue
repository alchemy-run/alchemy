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
  <main>
    <h1>Nuxt on Cloudflare Workers</h1>
    <p>{{ greeting }}</p>
    <NuxtLink to="/about">about (prerendered)</NuxtLink>
  </main>
</template>
