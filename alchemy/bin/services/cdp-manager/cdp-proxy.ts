import { WebSocket } from "ws";
import {
  CDPServer,
  type ClientCDPMessage,
  type ServerCDPMessage,
} from "./server.ts";

export class CDPProxy extends CDPServer {
  private inspectorUrl: string;
  private inspectorWs?: WebSocket;
  private onStartMessageQueue: Array<ClientCDPMessage>;

  constructor(
    inspectorUrl: string,
    options: ConstructorParameters<typeof CDPServer>[0] & {
      connect?: boolean;
      hotDomains?: Array<string>;
    },
  ) {
    super({ ...options, domains: options.domains ?? options.hotDomains });
    this.inspectorUrl = inspectorUrl;
    this.onStartMessageQueue = [];
    for (const domain of options.hotDomains ?? []) {
      this.onStartMessageQueue.push({
        id: ++this.internalMessageId,
        method: `${domain}.enable`,
        params: {},
      });
    }
    if (options.connect ?? true) {
      this.start();
    }
  }

  public async start(): Promise<void> {
    if (this.inspectorWs != null) {
      this.inspectorWs.close();
    }
    this.inspectorWs = new WebSocket(this.inspectorUrl, {
      headers: {
        Origin: "http://localhost",
      },
    });

    this.inspectorWs.onopen = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      for (const message of this.onStartMessageQueue) {
        this.internalHandleClientMessage(message);
      }
    };

    this.inspectorWs.onmessage = async (event) => {
      await this.handleInspectorMessage(
        JSON.parse(event.data.toString()) as ServerCDPMessage,
      );
    };

    this.inspectorWs.onclose = (ev) => {
      console.warn(`[${this.name}:Debug] Inspector closed`);
    };

    this.inspectorWs.onerror = (error) => {
      console.error(`[${this.name}:Debug] Inspector errored:`, error);
    };
  }

  async handleClientMessage(
    _ws: WebSocket,
    data: ClientCDPMessage,
  ): Promise<void> {
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

  private async internalHandleClientMessage(
    data: ClientCDPMessage,
  ): Promise<void> {
    const messageDomain = data.method?.split(".")?.[0];
    if (messageDomain != null && !this.domains.includes(messageDomain)) {
      return;
    }
    console.log("==>", JSON.stringify(data));
    this.inspectorWs!.send(JSON.stringify(data));
  }
}
