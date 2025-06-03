import type { Agent } from "undici";

export async function safeFetch(
  url: string | URL | Request,
  options: RequestInit = {},
  retries = 3,
) {
  let latestErr: any;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, {
        ...options,
        // Type assertion to work around Cloudflare Workers type definitions
        dispatcher: await dispatcher(),
      } as RequestInit);
    } catch (err: any) {
      latestErr = err;
      const shouldRetry =
        err?.code === "UND_ERR_SOCKET" ||
        err?.code === "ECONNRESET" ||
        err?.name === "FetchError";

      if (!shouldRetry || attempt === retries) {
        throw err;
      }

      console.warn(`Retry ${attempt}/${retries} for ${url}: ${err.code}`);
      await new Promise((r) => setTimeout(r, 250 * attempt)); // exponential backoff
    }
  }
  throw latestErr;
}

let agent:
  | {
      value: Agent | undefined;
    }
  | undefined;

async function dispatcher() {
  if (agent) {
    return agent.value;
  }
  try {
    // undici not available in all runtimes
    const { Agent } = await import("undici");

    if (!agent) {
      // Configure agent with connection limits to avoid socket errors
      agent = {
        value: new Agent({
          pipelining: 0, // Disable pipelining to avoid connection issues
          // connections: 5, // Limit concurrent connections per host
        }),
      };
    }
  } catch {
    agent = { value: undefined };
  }
  return agent.value;
}
