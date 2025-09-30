import assert from "node:assert";
import { once } from "node:events";
import { WebSocket } from "ws";

export async function test({ url }: { url: string | undefined }) {
  console.log("Running Durable Object WebSocket E2E test...");

  assert(url, "URL is not set");
  await pollUntilReady(new URL("/status", url));

  const ws = new WebSocket(new URL("/websocket", url));
  try {
    await once(ws, "open");

    const data = crypto.randomUUID();
    ws.send(data);
    const message = await new Promise<string>((resolve) => {
      ws.addEventListener("message", (event) => {
        resolve(event.data.toString());
      });
    });
    console.log("Received message", message);
    assert.equal(
      message,
      `Received message: ${data}`,
      "Received message is not correct",
    );
  } finally {
    console.log("Durable Object WebSocket E2E test passed");
    ws.close(1000);

    // TODO(sam): what the actual fuck, why does WebSocket keep the process alive?
    process.exit(0);
  }
}

async function pollUntilReady(url: URL) {
  let i = 0;
  while (true) {
    const res = await fetch(url);
    if (res.ok) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    i++;
    if (i > 120) {
      throw new Error(
        `Worker is not ready after 10 seconds (status: ${res.status}): ${url.toString()}`,
      );
    }
  }
}
