<script setup lang="ts">
import Button from "~/components/ui/Button.vue";
import Card from "~/components/ui/Card.vue";
import CardContent from "~/components/ui/CardContent.vue";
import CardDescription from "~/components/ui/CardDescription.vue";
import CardHeader from "~/components/ui/CardHeader.vue";
import CardTitle from "~/components/ui/CardTitle.vue";
import Input from "~/components/ui/Input.vue";

// The nitro routes in server/api/ are the public API — they dispatch the
// backend in-process (createClient's value form). During SSR, useFetch
// runs the route handler inside the Lambda (no HTTP hop) and the value
// hydrates into the client without a second request.
const { data: visits } = await useFetch<{ count: number }>("/api/visits");
const { data: processed } = await useFetch<{
  count: number;
  last: string | null;
}>("/api/jobs");

// Optimistic bump: reflect the click immediately, then settle on the
// server's authoritative count.
const bumping = ref(false);
async function bump() {
  visits.value = { count: (visits.value?.count ?? 0) + 1 };
  bumping.value = true;
  try {
    visits.value = await $fetch<{ count: number }>("/api/visits", {
      method: "POST",
    });
  } finally {
    bumping.value = false;
  }
}

// The async leg: enqueue a message, then poll the consumer's state until
// the catch-up lands (bounded — stop once the count grows).
const queueText = ref("");
const sending = ref(false);
async function sendToQueue() {
  const before = processed.value?.count ?? 0;
  sending.value = true;
  try {
    await $fetch("/api/jobs", {
      method: "POST",
      body: { message: queueText.value || "hello queue" },
    });
    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const next = await $fetch<{ count: number; last: string | null }>(
        "/api/jobs",
      );
      processed.value = next;
      if (next.count > before) break;
    }
  } finally {
    sending.value = false;
  }
}
</script>

<template>
  <main class="mx-auto max-w-2xl space-y-6 p-8">
    <div>
      <h1 class="text-3xl font-bold tracking-tight">Nuxt on AWS</h1>
      <p class="mt-2 text-muted-foreground">
        One Lambda serves the app and the backend; a sibling consumes the queue.
      </p>
    </div>
    <Card>
      <CardHeader>
        <CardTitle>Visits</CardTitle>
        <CardDescription>
          Counted in DynamoDB, server-rendered, bumped optimistically from the
          browser.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <p class="text-sm text-muted-foreground">
          Server-rendered visits:
          <span class="font-semibold text-foreground" data-testid="count">{{
            visits?.count ?? 0
          }}</span>
        </p>
        <Button class="mt-4" :disabled="bumping" @click="bump">
          Bump visits
        </Button>
      </CardContent>
    </Card>
    <Card>
      <CardHeader>
        <CardTitle>Queue</CardTitle>
        <CardDescription>
          Messages land on an SQS queue consumed by the same backend class —
          watch it catch up.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div class="flex gap-2">
          <Input v-model="queueText" placeholder="hello queue" />
          <Button
            class="shrink-0"
            variant="outline"
            :disabled="sending"
            @click="sendToQueue"
          >
            {{ sending ? "Sending…" : "Send to queue" }}
          </Button>
        </div>
        <p class="mt-4 text-sm text-muted-foreground" data-testid="processed">
          Queue-processed:
          <span
            class="font-semibold text-foreground"
            data-testid="processed-count"
            >{{ processed?.count ?? 0 }}</span
          >
          — last:
          <span
            class="font-semibold text-foreground"
            data-testid="processed-last"
            >{{ processed?.last ?? "—" }}</span
          >
        </p>
      </CardContent>
    </Card>
    <NuxtLink
      class="inline-block text-sm underline underline-offset-4"
      to="/about"
    >
      about (prerendered)
    </NuxtLink>
  </main>
</template>
