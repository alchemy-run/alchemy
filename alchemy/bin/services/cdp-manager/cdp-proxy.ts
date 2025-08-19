import type { WebSocket as WsWebSocket } from "ws";
import { CDPServer } from "./server.ts";

export class CDPProxy extends CDPServer {
  private inspectorUrl: string;
  private inspectorWs?: WebSocket;
  private onStartMessageQueue: Array<string>;

  constructor(
    inspectorUrl: string,
    options: ConstructorParameters<typeof CDPServer>[0] & {
      connect?: boolean;
    },
  ) {
    super(options);
    this.inspectorUrl = inspectorUrl;
    this.onStartMessageQueue = [];
    if (options.connect ?? true) {
      this.start();
    }
  }

  public async start(): Promise<void> {
    this.inspectorWs = new WebSocket(this.inspectorUrl);

    this.inspectorWs.addEventListener("open", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      for (const message of this.onStartMessageQueue) {
        this.internalHandleClientMessage(message);
      }
    });

    this.inspectorWs.onmessage = async (event) => {
      await this.handleInspectorMessage(event.data.toString());
    };

    this.inspectorWs.onclose = () => {
      console.warn(`[${this.name}:Debug] Inspector closed`);
    };

    this.inspectorWs.onerror = (error) => {
      console.error(`[${this.name}:Debug] Inspector errored:`, error);
    };
  }

  async handleClientMessage(_ws: WsWebSocket, data: string): Promise<void> {
    if (
      this.inspectorWs == null ||
      this.inspectorWs.readyState !== WebSocket.OPEN
    ) {
      if (this.onStartMessageQueue.length === 0) {
        await this.start();
      }
      this.onStartMessageQueue.push(data);
      return;
    } else {
      this.internalHandleClientMessage(data);
    }
  }

  private async internalHandleClientMessage(data: string): Promise<void> {
    const message = JSON.parse(data);
    const messageDomain = message.method?.split(".")?.[0];
    if (messageDomain != null && !this.domains.has(messageDomain)) {
      return;
    }
    this.inspectorWs!.send(data);
  }
}
