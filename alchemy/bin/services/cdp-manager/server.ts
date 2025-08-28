import fs, { createReadStream } from "node:fs";
import { createServer, type Server } from "node:http";
import { createInterface } from "node:readline";
import path from "pathe";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";
import { findOpenPort } from "../../../src/util/find-open-port.ts";
import { CDPProxy } from "./cdp-proxy.ts";

export const LOGS_DIRECTORY = path.join(process.cwd(), ".alchemy", "logs");
const DEBUGGER_URLS_FILE = path.join(
  process.cwd(),
  ".alchemy",
  ".debugger-urls",
);

export class CDPManager {
  public readonly server: Server;
  private url?: string;
  private cdpServers: Map<string, CDPServer> = new Map();
  private port?: number;

  constructor() {
    if (fs.existsSync(LOGS_DIRECTORY)) {
      fs.rmSync(LOGS_DIRECTORY, { recursive: true, force: true });
    }
    fs.mkdirSync(LOGS_DIRECTORY, { recursive: true });

    fs.writeFileSync(DEBUGGER_URLS_FILE, "");

    this.server = createServer((req, res) => {
      this.handleRequest(req, res);
    });

    this.server.on("upgrade", (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
  }

  public async startServer(): Promise<void> {
    this.port = await findOpenPort(1336, 65535);
    this.url = `http://0.0.0.0:${this.port}`;
    await new Promise<void>((resolve) => {
      this.server.listen(this.port, "0.0.0.0", () => {
        console.log(`[CDP-Manager] Debug server started at ${this.url}`);
        resolve();
      });
    });
  }

  public getUrl(): string {
    if (this.url == null) {
      throw new Error("CDP manager not started");
    }
    return this.url;
  }

  private async handleRequest(req: any, res: any): Promise<void> {
    const url = new URL(req.url, this.url);
    if (url.pathname.match(/^\/servers$/) && req.method === "POST") {
      let rawBody = "";
      req.on("data", (chunk) => {
        rawBody += chunk.toString(); // Accumulate data chunks
      });

      req.on("end", async () => {
        const body = JSON.parse(rawBody);
        if (body.type == null || body.payload == null) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid server type" }));
          return;
        }
        switch (body.type) {
          case "proxy": {
            await this.registerCDPServer(
              new CDPProxy(body.payload.inspectorUrl, {
                ...body.payload.options,
                server: this.server,
              }),
            );
            break;
          }
          default: {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid server type" }));
            return;
          }
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ success: true }));
      });
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    }
  }

  private handleUpgrade(request: any, socket: any, head: any): void {
    try {
      const url = new URL(request.url, this.url);

      const match = url.pathname.match(/^\/servers\/(.+)$/);
      if (match) {
        const serverName = match[1];

        const cdpServer = this.cdpServers.get(serverName);

        if (cdpServer) {
          cdpServer.handleUpgrade(request, socket, head);
        } else {
          console.log(
            `[CDP-Manager] CDP server ${serverName} not found, destroying socket. Available servers: ${Array.from(this.cdpServers.keys()).join(", ")}`,
          );
          socket.destroy();
        }
      } else {
        socket.destroy();
      }
    } catch (error) {
      console.log(`[CDP-Manager] Error handling upgrade: ${error}`);
      socket.destroy();
    }
  }

  public async registerCDPServer(server: CDPServer) {
    this.cdpServers.set(server.name, server);
    console.log(
      `[CDP-Manager] CDP server ${server.name} registered. Available servers: ${Array.from(this.cdpServers.keys()).join(", ")}`,
    );
    await fs.promises.appendFile(
      DEBUGGER_URLS_FILE,
      `${server.name}=ws://localhost:${this.port}/servers/${server.name}\n`,
    );
  }

  public close(): void {
    this.server.close();
  }
}

export abstract class CDPServer {
  protected logFile: string;
  public readonly name: string;
  private wss: WebSocketServer;
  private connectedClients: Map<
    string,
    {
      id: string;
      ws: WsWebSocket;
      allowedDomains: Set<string>;
    }
  > = new Map();
  private clientCounter = 0;
  protected pendingMessages: Map<
    number,
    {
      msg: ClientCDPMessage;
      clientMsgId: number;
      clientId: string;
    }
  > = new Map();
  protected internalMessageId: number;

  constructor(options: { name: string; server: Server; logFile?: string }) {
    this.name = options.name.replace(/[\\/:.]/g, "-");
    this.logFile =
      options.logFile ?? path.join(LOGS_DIRECTORY, `${this.name}.log`);
    fs.writeFileSync(this.logFile, "");
    this.wss = new WebSocketServer({
      noServer: true,
    });
    this.internalMessageId = 0;

    this.wss.on("connection", async (clientWs) => {
      const clientId = `client-${++this.clientCounter}`;
      const client = {
        id: clientId,
        ws: clientWs,
        allowedDomains: new Set<string>(),
      };

      this.connectedClients.set(clientId, client);

      clientWs.on("message", async (data) => {
        const json = JSON.parse(data.toString()) as ClientCDPMessage;
        const isEnableMessage = json?.method?.endsWith(".enable");

        if (isEnableMessage) {
          const domain = json.method.split(".")[0];
          const isNewDomain = !client.allowedDomains.has(domain);
          client.allowedDomains.add(domain);
          const enableId = json.id;

          if (isNewDomain) {
            let enableFound = false;
            for await (const historicMessage of this.readHistoricServerMessages(
              domain,
            )) {
              if (!enableFound) {
                historicMessage.startsWith(`{"id":`);
                const json = JSON.parse(historicMessage);
                json.id = enableId;
                client.ws.send(JSON.stringify(json));
              } else {
                client.ws.send(historicMessage);
              }
            }
          }
        } else if (json.id != null) {
          const clientMsgId = json.id;
          json.id = ++this.internalMessageId;
          this.pendingMessages.set(json.id, {
            msg: json,
            clientMsgId,
            clientId: clientId,
          });
        }
        await this.handleClientMessage(clientId, json);
      });

      clientWs.on("close", () => {
        this.removeClient(clientId);
      });
    });
  }

  async *readHistoricServerMessages(domain: string) {
    const fileStream = createReadStream(this.logFile);
    const rl = createInterface({ input: fileStream });

    for await (const line of rl) {
      //* Matches CDP messages starting with {"method":"domain. or {"id": number, "method":"domain.
      const regex = new RegExp(
        `^\\{"(?:id":\\s*\\d+,\\s*)?method":"${domain}\\.`,
      );
      if (regex.test(line)) {
        yield line;
      }
    }
  }

  private removeClient(clientId: string): void {
    const client = this.connectedClients.get(clientId);
    if (client) {
      this.connectedClients.delete(clientId);
    }

    for (const [id, pendingMsg] of this.pendingMessages.entries()) {
      if (pendingMsg.clientId === clientId) {
        this.pendingMessages.delete(id);
      }
    }
  }

  protected async handleInspectorMessage(data: ServerCDPMessage) {
    try {
      const messageDomain = data.method?.split(".")?.[0];
      const isEnableResponse = data.method?.endsWith(".enable");

      if (data.id == null || isEnableResponse) {
        await fs.promises.appendFile(this.logFile, `${JSON.stringify(data)}\n`);

        for (const [_clientId, client] of this.connectedClients) {
          if (messageDomain && client.allowedDomains.has(messageDomain)) {
            client.ws.send(JSON.stringify(data));
          }
        }
      } else {
        const pendingMsg = this.pendingMessages.get(data.id);
        if (pendingMsg) {
          const client = this.connectedClients.get(pendingMsg.clientId);
          if (client) {
            data.id = pendingMsg.clientMsgId;
            client.ws.send(JSON.stringify(data));
            this.pendingMessages.delete(data.id);
          }
        }
      }
    } catch (error) {
      console.error(
        `[${this.name}:Debug] Error handling inspector message:`,
        error,
      );
    }
  }

  abstract handleClientMessage(
    clientId: string,
    data: ClientCDPMessage,
  ): Promise<void>;

  public handleUpgrade(request: any, socket: any, head: any): void {
    try {
      this.wss.handleUpgrade(request, socket, head, (ws) =>
        this.wss.emit("connection", ws, request),
      );
    } catch (error) {
      console.error(
        `[${this.name}:Debug] Error during WebSocket upgrade:`,
        error,
      );
      socket.destroy();
    }
  }

  protected getConnectedClientsInfo(): string {
    const clientInfo = Array.from(this.connectedClients.entries())
      .map(
        ([id, client]) =>
          `${id}:[${Array.from(client.allowedDomains).join(",")}]`,
      )
      .join(", ");
    return `${this.connectedClients.size} clients: ${clientInfo}`;
  }

  protected getClientById(clientId: string) {
    return this.connectedClients.get(clientId)?.ws;
  }
}

export type ClientCDPMessage = {
  id: number;
  method: string;
  params?: Record<string, any>;
};

export type ServerCDPMessage = {
  id?: number;
  result?: Record<string, any>;
  method?: string;
};
