import { getEnv } from "waku";
import { Counter } from "../components/Counter.tsx";
import { backend } from "../lib/backend.ts";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.tsx";

export default async function HomePage() {
  // `getEnv` reads the Worker env at request time — the portable way to
  // reach bindings and env values from RSC page modules. (A top-level
  // `import { env } from "cloudflare:workers"` would break waku's Node-side
  // SSG step.)
  const greeting = getEnv("GREETING") ?? "Hello";
  // The VALUE form of `createClient`: backend methods dispatch in-process
  // during SSR (no HTTP hop) — the KV-backed counts are already in the
  // server-rendered HTML.
  const [visits, processed] = await Promise.all([
    backend.visits(),
    backend.processed(),
  ]);
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{greeting}</h1>
        <p className="mt-2 text-muted-foreground">
          This page is rendered by the Worker on every request.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Effect backend</CardTitle>
          <CardDescription>
            Server-rendered through the value-form backend client — no HTTP
            hop.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-1">
          <p>
            Server-rendered visits:{" "}
            <span data-testid="count">{visits}</span>
          </p>
          <p>
            Queue-processed: <span data-testid="processed-count">{processed.count}</span>
            {processed.last !== null ? (
              <span data-testid="processed-last"> (last: {processed.last})</span>
            ) : null}
          </p>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Client island</CardTitle>
          <CardDescription>
            A "use client" component hydrated inside the server-rendered page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Counter />
        </CardContent>
      </Card>
    </div>
  );
}

// Dynamic: rendered by the Worker at request time.
export const getConfig = async () => ({ render: "dynamic" }) as const;
