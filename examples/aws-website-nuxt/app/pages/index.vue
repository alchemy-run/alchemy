<script setup lang="ts">
// SSR reads the Lambda environment through the plain Node contract:
// `process.env`. `useState` serializes the server-read value into the
// payload so the client render matches.
const greeting = useState("greeting", () => {
  if (import.meta.server) {
    return typeof process.env.GREETING === "string"
      ? process.env.GREETING
      : "Hello (no env)";
  }
  return "Hello (no env)";
});
</script>

<template>
  <main class="mx-auto max-w-2xl p-8">
    <h1 class="text-3xl font-bold">Nuxt on AWS</h1>
    <p class="mt-4 text-lg">{{ greeting }}</p>
    <NuxtLink class="mt-4 inline-block underline" to="/about"
      >about (prerendered)</NuxtLink
    >
  </main>
</template>
