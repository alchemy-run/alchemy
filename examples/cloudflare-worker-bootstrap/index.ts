import alchemy from "alchemy";
import { Queue, R2Bucket, Worker } from "alchemy/cloudflare";
import { type } from "arktype";

const app = await alchemy("cloudflare-worker-bootstrap");

type Message = typeof Message.infer;
const Message = type({
  name: "string",
  email: "string",
});

const ReceiveRequest = type({
  email: "string",
});

const bucket = await R2Bucket("bucket", {
  name: `${app.name}-${app.stage}-bucket`,
  accessKey: await alchemy.secret.env.R2_ACCESS_KEY_ID,
  secretAccessKey: await alchemy.secret.env.R2_SECRET_ACCESS_KEY,
  adopt: true,
  empty: true,
});

const queue = await Queue<Message>("queue", {
  name: `${app.name}-${app.stage}-queue`,
  adopt: true,
});

const worker = Worker("queue-consumer", import.meta, {
  name: `${app.name}-${app.stage}-worker`,
  adopt: true,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/send") {
      const body = Message(await request.json());
      if (body instanceof type.errors) {
        return new Response("Invalid request body", { status: 400 });
      }
      await queue.send(body);
    } else if (url.pathname === "/receive") {
      const body = ReceiveRequest(await request.json());
      if (body instanceof type.errors) {
        return new Response("Invalid request body", { status: 400 });
      }
      const name = await bucket.get(`${body.email}.txt`);
      if (!name) {
        return new Response("Not found", { status: 404 });
      }
      return new Response();
    }
    return new Response();
  },
  eventSources: [queue],
  async queue(batch) {
    for (const message of batch.messages) {
      await bucket.put(`${message.body.email}.txt`, message.body.name);
    }
  },
});

export default worker;

await app.finalize();

if (!alchemy.isRuntime) {
  // end-to-end test
  const johnDoe = {
    name: "John Doe",
    email: `john.doe.${Date.now()}@example.com`,
  };

  const response = await worker.fetch("/send", {
    method: "POST",
    body: JSON.stringify(johnDoe),
  });

  if (!response.ok) {
    throw new Error("Failed to send message");
  }

  while (true) {
    const response = await worker.fetch("/receive", {
      method: "POST",
      body: JSON.stringify({ email: johnDoe.email }),
    });

    if (response.ok) {
      console.log("message traveled end to end");
      break;
    } else if (response.status === 404) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      continue;
    }
    throw new Error("Failed to receive message");
  }

  // exit because bun will hang serving http://localhost:3000
  process.exit(0);
}
