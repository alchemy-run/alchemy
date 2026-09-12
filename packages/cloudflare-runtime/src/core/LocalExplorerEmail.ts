import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  Service,
  ServiceDesignator,
  Worker_Binding,
} from "./workerd/Config.ts";

// Reuse the pinned Miniflare email simulator and capture store. Each worker
// owns its store; Explorer's native peer protocol aggregates them by source ID.
export function prepareExplorerEmail(
  workerName: string,
  storage: Service,
  bindings: ReadonlyArray<Worker_Binding>,
  loopback: ServiceDesignator,
  storeSource: string,
  sendSource: string,
) {
  const services: Service[] = [
    {
      name: "email:store",
      worker: {
        compatibilityDate: "2026-01-01",
        compatibilityFlags: ["nodejs_compat"],
        modules: [{ name: "email-store.js", esModule: storeSource }],
        durableObjectNamespaces: [
          {
            className: "EmailStore",
            uniqueKey: `alchemy:explorer:email:${encodeURIComponent(workerName)}`,
            enableSql: true,
          },
        ],
        durableObjectStorage: { localDisk: storage.name },
        bindings: [
          {
            name: "EMAIL_STORE_DO",
            durableObjectNamespace: { className: "EmailStore" },
          },
        ],
      },
    },
  ];
  const sendEmail: { bindingName: string }[] = [];
  const userBindings = bindings.map((binding) => {
    if (
      !binding.name ||
      !("service" in binding) ||
      binding.service?.name !== "send-email" ||
      binding.service.entrypoint !== "SendEmailBinding"
    )
      return binding;
    const name = `local-explorer:send-email:${sendEmail.length}`;
    sendEmail.push({ bindingName: binding.name });
    // Address restrictions still come from the original service props.
    services.push({
      name,
      worker: {
        compatibilityDate: "2026-01-01",
        compatibilityFlags: ["nodejs_compat"],
        modules: [
          {
            name: "entry.js",
            esModule: `import { SendEmailBinding } from "./send.js";
export default class extends SendEmailBinding {
  constructor(ctx, env) { super(ctx, { ...env, ...ctx.props }); }
}`,
          },
          { name: "send.js", esModule: sendSource },
        ],
        bindings: [
          { name: "MINIFLARE_LOOPBACK", service: loopback },
          { name: "MINIFLARE_EMAIL_STORE", service: { name: "email:store" } },
          { name: "SEND_EMAIL_OWNER_WORKER", text: workerName },
        ],
      },
    });
    return {
      name: binding.name,
      service: { name, props: binding.service.props },
    };
  });
  return { services, userBindings, sendEmail };
}

// These endpoints are behind the authenticated, scoped Alchemy loopback.
export async function handleExplorerEmailLoopback(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storagePath: string,
  workerName: string,
): Promise<boolean> {
  if (request.method !== "POST") return false;
  if (url.pathname === "/core/log") {
    let message = "";
    for await (const chunk of request) {
      if (message.length < 65536)
        message += String(chunk).slice(0, 65536 - message.length);
    }
    console.log(`[${workerName}] ${message}`);
    response.writeHead(204).end();
    return true;
  }
  if (url.pathname !== "/core/store-temp-file") return false;
  const prefix = url.searchParams.get("prefix") ?? "";
  const extension = url.searchParams.get("extension") ?? "";
  const id = url.searchParams.get("id") ?? crypto.randomUUID();
  if (
    !/^email\/(email|text|html|attachment|reply)$/.test(prefix) ||
    !/^[a-zA-Z0-9]{1,16}$/.test(extension) ||
    !/^[a-zA-Z0-9@._+-]{1,240}$/.test(id) ||
    id === "." ||
    id === ".."
  ) {
    response.writeHead(400).end("Invalid email file path");
    return true;
  }
  const kind = prefix.slice("email/".length);
  const directory = path.join(
    storagePath,
    "email",
    ...(kind === "email" ? [] : [kind]),
  );
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${id}.${extension}`);
  await pipeline(request, createWriteStream(file));
  response.writeHead(200, { "content-type": "text/plain" }).end(file);
  return true;
}
