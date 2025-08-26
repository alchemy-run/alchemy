import fs from "node:fs";
import { createServer, type Server } from "node:http";
import path from "pathe";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";
import { findOpenPort } from "../../../src/util/find-open-port.ts";

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
    this.url = `http://localhost:${this.port}`;
    await new Promise<void>((resolve) => {
      this.server.listen(this.port, () => {
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

  private handleRequest(_req: any, res: any): void {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
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
  protected domains: Set<string>;
  public readonly name: string;
  private wss: WebSocketServer;
  private connectedClients: Set<WsWebSocket> = new Set();
  protected pendingMessages: Map<
    number,
    {
      msg: ClientCDPMessage;
      clientMsgId: number;
      clientWs: WsWebSocket;
    }
  > = new Map();
  protected internalMessageId: number;

  constructor(options: {
    name: string;
    server: Server;
    logFile?: string;
    domains?: Set<string>;
  }) {
    this.domains = options.domains ?? new Set(["Log", "Debugger"]);
    this.logFile =
      options.logFile ?? path.join(LOGS_DIRECTORY, `${options.name}.log`);
    this.name = options.name;
    fs.writeFileSync(this.logFile, "");
    this.wss = new WebSocketServer({
      noServer: true,
    });

    this.wss.on("connection", async (clientWs) => {
      this.connectedClients.add(clientWs);
      clientWs.on("message", async (data) => {
        const json = JSON.parse(data.toString()) as ClientCDPMessage;
        if (json.id != null) {
          const clientMsgId = json.id;
          json.id = ++this.internalMessageId;
          this.pendingMessages.set(json.id, {
            msg: json,
            clientMsgId,
            clientWs: clientWs,
          });
        }
        await this.handleClientMessage(clientWs, json);
      });

      clientWs.on("close", () => {});
    });
  }

  protected async handleInspectorMessage(data: ServerCDPMessage) {
    try {
      const messageDomain = data.method?.split(".")?.[0];

      if (data.id == null) {
        if (messageDomain != null && !this.domains.has(messageDomain)) {
          return;
        }
        await fs.promises.appendFile(this.logFile, `${data}\n`);
        for (const client of this.connectedClients) {
          client.send(JSON.stringify(data));
        }
      } else {
        const pendingMsg = this.pendingMessages.get(data.id);
        if (pendingMsg) {
          data.id = pendingMsg.clientMsgId;
          pendingMsg.clientWs.send(JSON.stringify(data));
          this.pendingMessages.delete(data.id);
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
    ws: WsWebSocket,
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
}

export type ClientCDPMessage = {
  id: number;
  method: string;
};

export type ServerCDPMessage = {
  id?: number;
  method: string;
};
