import crypto from "node:crypto";
import type { RmDirOptions } from "node:fs";
import fs from "node:fs/promises";
import path from "pathe";
import type { DurableObjectNamespace } from "../durable-object-namespace";
import type { Workflow } from "../workflow";
import { DEFAULT_PERSIST_PATH } from "./paths";

const PERSIST_ROOT = path.resolve(DEFAULT_PERSIST_PATH);
const BINDING_TYPE_KEY = {
  d1: "miniflare-D1DatabaseObject",
  kv: "miniflare-KVNamespaceObject",
  r2: "miniflare-R2BucketObject",
} as const;

type BindingType = keyof typeof BINDING_TYPE_KEY;

/**
 * Delete a binding from the miniflare directory.
 */
export async function deleteMiniflareBinding(type: BindingType, id: string) {
  const bindingPath = path.join(PERSIST_ROOT, type, BINDING_TYPE_KEY[type]);

  // delete durable object/sqlite files
  const namespaceId = durableObjectNamespaceIdFromName(
    BINDING_TYPE_KEY[type],
    id,
  );
  const files = await fs
    .readdir(bindingPath)
    .then((files) => files.filter((file) => file.startsWith(namespaceId)))
    .catch(() => []);
  await Promise.all(files.map((file) => fs.rm(path.join(bindingPath, file))));

  // delete data directory, if present
  await removeDirectory(path.join(PERSIST_ROOT, type, id), {
    recursive: true,
  });

  // delete the miniflare directory if it is empty
  await cleanMiniflareDirectory();
}

/**
 * Delete local durable object and workflow data for a given Worker script.
 */
export async function deleteMiniflareWorkerData(
  scriptName: string,
  input: {
    durableObjects: DurableObjectNamespace[];
    workflows: Workflow[];
  },
) {
  await Promise.all(
    input.durableObjects.map((durableObject) =>
      removeDirectory(
        path.join(
          PERSIST_ROOT,
          "do",
          `${scriptName}-${durableObject.className}`,
        ),
        {
          recursive: true,
        },
      ),
    ),
  );
  await Promise.all(
    input.workflows.map((workflow) =>
      removeDirectory(
        path.join(
          PERSIST_ROOT,
          "workflows",
          `miniflare-workflows-${workflow.workflowName}`,
        ),
        {
          recursive: true,
        },
      ),
    ),
  );
  await cleanMiniflareDirectory();
}

/**
 * Delete the miniflare directory iff it is empty.
 */
async function cleanMiniflareDirectory() {
  const directory = path.resolve(".alchemy/miniflare");
  const files = await fs
    .readdir(directory, {
      recursive: true,
      withFileTypes: true,
    })
    .catch((error) => {
      if (!isENOENT(error)) {
        throw error;
      }
      return [];
    });
  if (!files.some((file) => !file.isDirectory())) {
    await removeDirectory(directory, { recursive: true });
  }
}

const removeDirectory = async (path: string, options?: RmDirOptions) => {
  try {
    await fs.rmdir(path, options);
  } catch (error) {
    if (!isENOENT(error)) {
      throw error;
    }
  }
};

const isENOENT = (error: unknown): error is { code: "ENOENT" } =>
  !!error &&
  typeof error === "object" &&
  "code" in error &&
  error.code === "ENOENT";

// copied from https://github.com/cloudflare/workers-sdk/blob/a5892915e173ca8666c04fb394e70711e87b46d8/packages/miniflare/src/plugins/shared/index.ts#L236
const durableObjectNamespaceIdFromName = (uniqueKey: string, name: string) => {
  const key = crypto.createHash("sha256").update(uniqueKey).digest();
  const nameHmac = crypto
    .createHmac("sha256", key)
    .update(name)
    .digest()
    .subarray(0, 16);
  const hmac = crypto
    .createHmac("sha256", key)
    .update(nameHmac)
    .digest()
    .subarray(0, 16);
  return Buffer.concat([nameHmac, hmac]).toString("hex");
};
