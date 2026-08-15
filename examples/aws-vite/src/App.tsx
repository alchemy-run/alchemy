import QueueCard from "./components/QueueCard.tsx";
import VisitsCard from "./components/VisitsCard.tsx";

export default function App() {
  return (
    <main className="mx-auto max-w-4xl px-6 py-24">
      <p className="text-sm uppercase tracking-[0.16em] text-primary">
        alchemy + vite on AWS
      </p>
      <h1 className="mt-3 text-4xl font-bold leading-tight sm:text-5xl">
        A Vite SPA with an effect-native backend.
      </h1>
      <p className="mt-4 text-lg leading-relaxed text-muted-foreground">
        The static build serves from S3 + CloudFront; <code>/api/*</code>{" "}
        routes to an effect Lambda declared in the same{" "}
        <code>src/backend.ts</code> — DynamoDB, SQS, and the queue consumer
        included. The browser talks through an <code>HttpApi</code> schema it
        shares with the server.
      </p>
      <div className="mt-12 grid gap-6 sm:grid-cols-2">
        <VisitsCard />
        <QueueCard />
      </div>
    </main>
  );
}
