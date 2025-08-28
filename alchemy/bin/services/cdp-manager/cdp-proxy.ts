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
  private enabledDomains: Set<string> = new Set();
  private debuggerId?: string;

  constructor(
    inspectorUrl: string,
    options: ConstructorParameters<typeof CDPServer>[0] & {
      connect?: boolean;
      hotDomains?: Array<string>;
    },
  ) {
    super(options);
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

    this.inspectorWs.onmessage = async (event) => {
      const json = JSON.parse(event.data.toString()) as ServerCDPMessage;
      if (json.id != null && json?.result?.debuggerId != null) {
        this.debuggerId = json?.result?.debuggerId;
      }
      await this.handleInspectorMessage(
        JSON.parse(event.data.toString()) as ServerCDPMessage,
      );
    };

    this.inspectorWs.onopen = async () => {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      for (const message of this.onStartMessageQueue) {
        this.handleClientMessage(undefined, message);
      }
    };

    this.inspectorWs.onclose = (ev) => {
      console.warn(`[${this.name}:Debug] Inspector closed`);
    };

    this.inspectorWs.onerror = (error) => {
      console.error(`[${this.name}:Debug] Inspector errored:`, error);
    };
  }

  async handleClientMessage(
    clientId: string | undefined,
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
      this.internalHandleClientMessage(clientId, data);
    }
  }

  private async internalHandleClientMessage(
    clientId: string | undefined,
    data: ClientCDPMessage,
  ): Promise<void> {
    const messageDomain = data.method?.split(".")?.[0];

    if (data.method?.endsWith(".enable") && messageDomain) {
      if (this.enabledDomains.has(messageDomain)) {
        if (clientId != null) {
          const client = this.getClientById(clientId);
          if (client != null) {
            //* handle some special cases where enabling isn't properly reported
            switch (data.method) {
              case "Runtime.enable": {
                client.send(
                  JSON.stringify({
                    id: data.id,
                    result: {},
                  }),
                );
                break;
              }
              case "Debugger.enable": {
                if (this.debuggerId != null) {
                  client.send(
                    JSON.stringify({
                      id: data.id,
                      result: {
                        debuggerId: this.debuggerId,
                      },
                    }),
                  );
                  break;
                }
              }
            }
          }
        }
        return;
      }
      this.enabledDomains.add(messageDomain);

      if (data.id != null) {
        data.id = ++this.internalMessageId;
      }
    }

    this.inspectorWs!.send(JSON.stringify(data));
  }
}
