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

// The effect fetch is mounted as nitro server middleware — /api/message
// is the S3-backed handler declared in src/backend.ts, served by the same
// Lambda as this page (client-only so SSR stays snappy).
const message = ref("…");
const draft = ref("");

const refresh = async () => {
  const body = await $fetch<{ message: string | null }>("/api/message");
  message.value = body.message ?? "(nothing saved yet)";
};

const save = async () => {
  const body = await $fetch<{ message: string | null }>(
    `/api/message?put=${encodeURIComponent(draft.value)}`,
  );
  message.value = body.message ?? "";
  draft.value = "";
};

onMounted(refresh);
</script>

<template>
  <main class="mx-auto max-w-2xl p-8">
    <h1 class="text-3xl font-bold">Nuxt on AWS</h1>
    <p class="mt-4 text-lg">{{ greeting }}</p>
    <p class="mt-4">
      Saved message (from <code>/api/message</code>, S3-backed):
      {{ message }}
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
  </main>
</template>
