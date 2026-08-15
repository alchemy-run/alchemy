<script lang="ts">
  // Browser side: no backend import at all — the page talks to SvelteKit's
  // own transports (form actions + the /api/processed JSON route), which
  // call the backend server-side through the value form of createClient.
  import { enhance } from "$app/forms";
  import Button from "../lib/components/ui/button.svelte";
  import Card from "../lib/components/ui/card.svelte";
  import CardContent from "../lib/components/ui/card-content.svelte";
  import CardDescription from "../lib/components/ui/card-description.svelte";
  import CardHeader from "../lib/components/ui/card-header.svelte";
  import CardTitle from "../lib/components/ui/card-title.svelte";
  import Input from "../lib/components/ui/input.svelte";

  let { data } = $props();

  // Optimistic bump: reflect the click immediately; the reloaded
  // `data.visits` reconciles once the form action's round-trip lands.
  let optimistic: number | null = $state(null);
  let visits = $derived(optimistic ?? data.visits);

  // The async leg's client state — the freshest snapshot wins, whether it
  // came from the reloaded load data or the poll below.
  let polled: { count: number; last: string | null } | null = $state(null);
  let processed = $derived(polled ?? data.processed);
  let queueBusy = $state(false);

  // Poll the JSON route (bounded, once per second) until the sibling
  // consumer Lambda's writes are visible.
  async function pollProcessed(before: number) {
    for (let i = 0; i < 15; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const next = (await (await fetch("/api/processed")).json()) as {
        count: number;
        last: string | null;
      };
      polled = next;
      if (next.count > before) break;
    }
  }
</script>

<main class="mx-auto flex max-w-2xl flex-col gap-6 p-8">
  <h1 class="text-3xl font-bold">SvelteKit on AWS</h1>
  <Card>
    <CardHeader>
      <CardTitle>Visits</CardTitle>
      <CardDescription>
        Server-rendered visits: <span data-testid="count">{visits}</span>
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form
        method="POST"
        action="?/bump"
        use:enhance={() => {
          optimistic = visits + 1;
          return async ({ update }) => {
            await update();
            optimistic = null;
          };
        }}
      >
        <Button type="submit" data-testid="bump">Bump visits</Button>
      </form>
    </CardContent>
  </Card>
  <Card>
    <CardHeader>
      <CardTitle>Queue</CardTitle>
      <CardDescription>
        Enqueue a message; the sibling consumer Lambda catches up
        asynchronously.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <form
        method="POST"
        action="?/enqueue"
        class="flex gap-2"
        use:enhance={() => {
          queueBusy = true;
          const before = processed.count;
          return async ({ update }) => {
            await update();
            await pollProcessed(before);
            queueBusy = false;
          };
        }}
      >
        <Input name="message" placeholder="hello queue" />
        <Button type="submit" variant="outline" disabled={queueBusy}>
          {queueBusy ? "Waiting…" : "Send to queue"}
        </Button>
      </form>
      <p class="text-sm text-muted-foreground" data-testid="processed">
        Queue-processed:
        <span data-testid="processed-count">{processed.count}</span>
        — last:
        <span data-testid="processed-last">{processed.last ?? "—"}</span>
      </p>
    </CardContent>
  </Card>
  <a class="underline" href="/about">about (prerendered)</a>
</main>
