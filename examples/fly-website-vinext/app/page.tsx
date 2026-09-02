import { Card } from "./components/Card.tsx";

export const dynamic = "force-dynamic";

export default function Home() {
  return (
    <main>
      <h1 className="text-3xl font-bold">
        {process.env.GREETING ?? "Hello from vinext!"}
      </h1>
      <Card
        title="Styled with Tailwind CSS"
        body="This card is a React component styled with Tailwind utilities."
      />
    </main>
  );
}
