import { logger } from "../../util/logger.ts";
import { handleApiError } from "../api-error.ts";
import type { CloudflareApi } from "../api.ts";
import type { WorkerBindingSpec } from "../bindings.ts";
import {
  deleteQueueConsumer,
  listQueueConsumersForWorker,
} from "../queue-consumer.ts";
import type { WorkerScriptMetadata } from "../worker-metadata.ts";

export class WorkerAPI {
  constructor(
    private readonly api: CloudflareApi,
    private scriptName: string,
  ) {}

  async workerExists() {
    const res = await this.api.get(
      `/accounts/${this.api.accountId}/workers/scripts/${this.scriptName}`,
    );
    return res.status === 200;
  }

  async assertWorkerDoesNotExist() {
    const response = await this.api.get(
      `/accounts/${this.api.accountId}/workers/scripts/${this.scriptName}`,
    );
    if (response.status === 404) {
      return true;
    }
    if (response.status === 200) {
      const metadata = await this.getScriptMetadata();

      if (!metadata) {
        throw new Error(
          `Worker exists but failed to fetch metadata: ${response.status} ${response.statusText}`,
        );
      }

      throw new Error(
        `Worker with name '${this.scriptName}' already exists. Please use a unique name.`,
      );
    }
    throw new Error(
      `Error checking if worker exists: ${response.status} ${response.statusText} ${await response.text()}`,
    );
  }

  async getScriptMetadata(): Promise<WorkerScriptMetadata | undefined> {
    const res = await this.api.get(
      `/accounts/${this.api.accountId}/workers/scripts/${this.scriptName}`,
    );
    if (res.status === 404) {
      return;
    }
    if (!res.ok) {
      throw new Error(
        `Error getting worker script metadata: ${res.status} ${res.statusText}`,
      );
    }
    const json = (await res.json()) as { result: WorkerScriptMetadata };
    return json.result;
  }

  async putCrons(crons: string[]) {
    await this.api.put(
      `/accounts/${this.api.accountId}/workers/scripts/${this.scriptName}/schedules`,
      crons.map((cron) => ({ cron })),
    );
  }

  async getVersionMetadata(deploymentId: string) {
    const response = await this.api.get(
      `/accounts/${this.api.accountId}/workers/scripts/${this.scriptName}/versions/${deploymentId}`,
    );
    const result = (await response.json()) as {
      result: {
        resources: {
          bindings: WorkerBindingSpec[];
        };
      };
    };
    return result.result;
  }

  async delete(props: { dispatchNamespace?: string; url?: boolean }) {
    const consumers = await listQueueConsumersForWorker(
      this.api,
      this.scriptName,
    );

    await Promise.all(
      consumers.map(async (consumer) => {
        await deleteQueueConsumer(
          this.api,
          consumer.queueId,
          consumer.consumerId,
        );
      }),
    );

    const deleteResponse = await this.api.delete(
      props.dispatchNamespace
        ? `/accounts/${this.api.accountId}/workers/dispatch/namespaces/${props.dispatchNamespace}/scripts/${this.scriptName}?force=true`
        : `/accounts/${this.api.accountId}/workers/scripts/${this.scriptName}?force=true`,
    );

    if (!deleteResponse.ok && deleteResponse.status !== 404) {
      await handleApiError(deleteResponse, "delete", "worker", this.scriptName);
    }

    if (props.url) {
      try {
        await this.api.post(
          `/accounts/${this.api.accountId}/workers/scripts/${this.scriptName}/subdomain`,
          JSON.stringify({ enabled: false }),
          {
            headers: { "Content-Type": "application/json" },
          },
        );
      } catch (error) {
        logger.warn("Failed to disable worker URL during deletion:", error);
      }
    }
  }
}
