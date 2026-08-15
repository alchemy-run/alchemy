import { getEnv } from "waku";
import { Counter } from "../components/Counter.tsx";
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
