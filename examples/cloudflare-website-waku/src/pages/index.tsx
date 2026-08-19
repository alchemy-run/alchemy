import { getEnv } from "waku";
import { Counter } from "../components/Counter.tsx";

export default async function HomePage() {
  // `getEnv` reads the Worker env at request time — the portable way to
  // reach bindings and env values from RSC page modules. (A top-level
  // `import { env } from "cloudflare:workers"` would break waku's Node-side
  // SSG step.)
  const greeting = getEnv("GREETING") ?? "Hello";
  return (
    <div>
      <h1 className="text-3xl font-bold">{greeting}</h1>
      <p className="mt-2 text-gray-600">
        This page is rendered by the Worker on every request.
      </p>
      <Counter />
    </div>
  );
}

// Dynamic: rendered by the Worker at request time.
export const getConfig = async () => ({ render: "dynamic" }) as const;
