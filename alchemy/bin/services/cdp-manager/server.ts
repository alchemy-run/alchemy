import fs from "node:fs";
import { createServer, type Server } from "node:http";
import path from "pathe";
import { WebSocketServer, type WebSocket as WsWebSocket } from "ws";
import { findOpenPort } from "../../../src/util/find-open-port.ts";

export class CDPManager {
  public readonly server: Server;
  private logDirectory: string;
  private url?: string;
  private cdpServers: Map<string, CDPServer> = new Map();
  private port?: number;

  constructor() {
    this.logDirectory = path.join(process.cwd(), ".alchemy", "logs");

    if (fs.existsSync(this.logDirectory)) {
      fs.rmSync(this.logDirectory, { recursive: true, force: true });
    }
    fs.mkdirSync(this.logDirectory, { recursive: true });

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

  private handleRequest(req: any, res: any): void {
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

  public registerCDPServer(server: CDPServer) {
    this.cdpServers.set(server.name, server);
    console.log(
      `[CDP-Manager] CDP server ${server.name} registered. Available servers: ${Array.from(this.cdpServers.keys()).join(", ")}`,
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
  //todo(michael): support multiple clients
  private lastClient: WsWebSocket | null = null;

  constructor(options: {
    name: string;
    server: Server;
    logFile?: string;
    domains?: Set<string>;
  }) {
    this.domains = options.domains ?? new Set(["Log", "Debugger"]);
    this.logFile =
      options.logFile ??
      path.join(process.cwd(), ".alchemy", "logs", `${options.name}.log`);
    this.name = options.name;
    fs.writeFileSync(this.logFile, "");
    this.wss = new WebSocketServer({
      noServer: true,
    });

    this.wss.on("connection", async (clientWs) => {
      console.log("connected to cdp manager???");
      this.lastClient = clientWs;
      clientWs.on("message", async (data) => {
        await this.handleClientMessage(clientWs, data.toString());
      });

      clientWs.on("close", () => {});
    });
  }

  protected async handleInspectorMessage(data: string) {
    try {
      // console.log("<--", data);
      const message = JSON.parse(data);
      const messageDomain = message.method?.split(".")?.[0];
      if (messageDomain != null && !this.domains.has(messageDomain)) {
        return;
      }

      if (message.id == null) {
        await fs.promises.appendFile(this.logFile, `${data}\n`);
      }
      if (this.lastClient != null) {
        this.lastClient.send(data);
      }
    } catch (error) {
      console.error(
        `[${this.name}:Debug] Error handling inspector message:`,
        error,
      );
    }
  }

  abstract handleClientMessage(ws: WsWebSocket, data: string): Promise<void>;

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
