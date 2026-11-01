import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { ConvexProvider, ConvexReactClient, useMutation, useQuery } from "convex/react";
import { anyApi } from "convex/server";
import { useEffect, useState } from "react";

// The URL is only known after deploy, so the server hands it to the page.
const getConvexUrl = createServerFn({ method: "GET" }).handler(() => process.env.CONVEX_URL!);

export const Route = createFileRoute("/")({
  loader: () => getConvexUrl(),
  component: Home,
});

function Home() {
  const url = Route.useLoaderData();
  const [client, setClient] = useState<ConvexReactClient>();

  // Convex holds a websocket, so it connects in the browser, not during SSR.
  useEffect(() => {
    const created = new ConvexReactClient(url);
    setClient(created);
    return () => void created.close();
  }, [url]);

  return (
    <main>
      <h1>Convex on AWS</h1>
      {client ? (
        <ConvexProvider client={client}>
          <Messages />
        </ConvexProvider>
      ) : (
        <p>Connecting...</p>
      )}
    </main>
  );
}

function Messages() {
  const messages = useQuery(anyApi.messages!.list!);
  const add = useMutation(anyApi.messages!.add!);
  return (
    <>
      <button type="button" onClick={() => void add({ text: "Hello from Convex" })}>
        Add a message
      </button>
      <ul>
        {messages?.map((message: { _id: string; text: string }) => (
          <li key={message._id}>{message.text}</li>
        ))}
      </ul>
    </>
  );
}
