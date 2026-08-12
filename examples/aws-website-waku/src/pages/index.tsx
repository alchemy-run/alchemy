import { getEnv } from "waku";
import { Counter } from "../components/Counter.tsx";

export default async function HomePage() {
  // `getEnv` reads the server environment at request time — the portable
  // way to reach env values from RSC page modules. On AWS it is backed by
  // the Lambda's `process.env`.
  const greeting = getEnv("GREETING") ?? "Hello";
  return (
    <div>
      <h1 className="text-3xl font-bold">{greeting}</h1>
      <p className="mt-2 text-gray-600">
        This page is rendered by the server on every request.
      </p>
      <Counter />
    </div>
  );
}

// Dynamic: rendered by the Lambda at request time.
export const getConfig = async () => ({ render: "dynamic" }) as const;
