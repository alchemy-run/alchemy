import { useState } from "react";

export function App() {
  const [count, setCount] = useState(0);
  return (
    <main className="mx-auto max-w-xl p-8">
      <h1 className="text-3xl font-bold">Hello from Azure Container Apps</h1>
      <p className="mt-2 text-slate-400">
        A Vite SPA deployed with <code>Azure.Website.Vite</code>.
      </p>
      <button
        type="button"
        className="mt-6 rounded bg-sky-600 px-4 py-2"
        onClick={() => setCount((n) => n + 1)}
      >
        Clicked {count} times
      </button>
    </main>
  );
}
