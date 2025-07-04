import kleur from "kleur";
import { WebSocket } from "ws";
import { logger } from "../../util/logger.ts";
import type { CloudflareApi } from "../api.ts";
import type { CloudflareApiResponse } from "../types.ts";

interface TailEvent {
  wallTime: number;
  cpuTime: number;
  truncated: boolean;
  executionModel: "stateless" | "durableObject";
  outcome: "ok" | "exception";
  scriptTags: string[];
  scriptVersion: { id: string };
  scriptName: string;
  diagnosticsChannelEvents: unknown[];
  exceptions: {
    name: string;
    message: string;
    stack: string;
    timestamp: string;
  }[];
  logs: {
    message: string[];
    level: string;
    timestamp: string;
  }[];
  event: {
    request: Pick<Request, "method" | "url" | "headers" | "body">;
    response?: { status: number };
  };
}

export const tail = async (
  api: CloudflareApi,
  id: string,
  scriptName: string,
) => {
  const res = await api.post(
    `/accounts/${api.accountId}/workers/scripts/${scriptName}/tails`,
    {},
  );
  const json = (await res.json()) as CloudflareApiResponse<{
    id: string;
    url: string;
    expires_at: string; // TODO: renew before expiry
  }>;
  if (!json.success) {
    throw new Error(
      `Failed to create tail for ${scriptName} (${res.status}): ${json.errors.map((e) => `${e.code} - ${e.message}`).join("\n")}`,
    );
  }
  let clean = false;

  const ws = new WebSocket(json.result.url, {
    headers: {
      "Sec-WebSocket-Protocol": "trace-v1",
    },
  });

  ws.addEventListener("open", () => {
    logger.log(`connected to tail for "${scriptName}"`);
  });

  ws.addEventListener("close", () => {
    if (!clean) {
      logger.log(`closed tail for "${scriptName}"`);
    }
  });

  ws.addEventListener("error", (event) => {
    logger.error(`error on tail for "${scriptName}": ${event}`);
  });

  ws.addEventListener("message", (event) => {
    const data: TailEvent = JSON.parse(event.data.toString());
    const url = new URL(data.event.request.url);
    const status = data.event.response?.status ?? 500;
    const prefix = kleur.blue(`[${id}]`).padEnd(12);
    // TODO: make this look nicer
    logger.log(
      `${prefix} ${kleur.gray(data.event.request.method)} ${url.pathname} ${kleur.dim(">")} ${status >= 200 && status < 300 ? kleur.green(status) : kleur.red(status)} ${kleur.gray(`(cpu: ${Math.round(data.cpuTime)}ms, wall: ${Math.round(data.wallTime)}ms)`)}`,
    );
    for (const log of data.logs) {
      logger.log(`${prefix} ${kleur.gray(log.level)} ${log.message.join(" ")}`);
    }
    for (const exception of data.exceptions) {
      const start = `${prefix} ${kleur.red(exception.name)}`;
      logger.log(
        `${start} ${exception.message}\n${kleur.gray(exception.stack)}`,
      );
    }
  });

  return async () => {
    clean = true;
    const res = await api.delete(
      `/accounts/${api.accountId}/workers/scripts/${scriptName}/tails/${json.result.id}`,
    );
    logger.log(`deleted tail for "${scriptName}": ${res.status}`);
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  };
};
