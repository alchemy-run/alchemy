import { exec } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import pkg from "../../../package.json" with { type: "json" };
import type { Phase } from "../../alchemy.ts";
import { Scope } from "../../scope.ts";
import { logger } from "../logger.ts";
import { memoize } from "../memoize.ts";
import {
  CONFIG_DIR,
  SUPPRESS_TELEMETRY_ERRORS,
  TELEMETRY_API_URL,
  TELEMETRY_DISABLED,
} from "./constants.ts";

async function getOrCreateUserId() {
  const path = join(CONFIG_DIR, "id");

  try {
    return (await readFile(path, "utf-8")).trim();
  } catch {}

  try {
    await mkdir(CONFIG_DIR, { recursive: true });
  } catch {}

  const id = crypto.randomUUID();
  try {
    await writeFile(path, id);
    console.warn(
      [
        "Attention: To help improve Alchemy, we now collect anonymous usage, performance, and error data.",
        "You can opt out by setting the ALCHEMY_TELEMETRY_DISABLED or DO_NOT_TRACK environment variable to a truthy value.",
      ].join("\n"),
    );
  } catch {
    return null;
  }

  return id;
}

async function getRootCommitHash() {
  return new Promise<string | null>((resolve) => {
    exec("git rev-list --max-parents=0 HEAD", (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function getGitOriginUrl() {
  return new Promise<string | null>((resolve) => {
    exec("git config --get remote.origin.url", (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

async function getBranchName() {
  return new Promise<string | null>((resolve) => {
    exec("git rev-parse --abbrev-ref HEAD", (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      resolve(stdout.trim());
    });
  });
}

const RUNTIMES = [
  {
    name: "bun",
    detect: () => !!globalThis.Bun,
    version: () => globalThis.Bun?.version,
  },
  {
    name: "deno",
    //@ts-expect-error
    detect: () => !!globalThis.Deno,
    //@ts-expect-error
    version: () => globalThis.Deno?.version?.deno,
  },
  {
    name: "workerd",
    //@ts-expect-error
    detect: () => !!globalThis.EdgeRuntime,
    version: () => null,
  },
  {
    name: "node",
    detect: () => !!globalThis.process?.versions?.node,
    version: () => process.versions.node,
  },
] as const;

function getRuntime() {
  for (const runtime of RUNTIMES) {
    if (runtime.detect()) {
      return {
        name: runtime.name,
        version: runtime.version() ?? null,
      };
    }
  }
  return {
    name: null,
    version: null,
  };
}

const PROVIDERS = [
  { env: "GITHUB_ACTIONS", provider: "GitHub Actions", isCI: true },
  { env: "GITLAB_CI", provider: "GitLab CI", isCI: true },
  { env: "CIRCLECI", provider: "CircleCI", isCI: true },
  { env: "JENKINS_URL", provider: "Jenkins", isCI: true },
  { env: "TRAVIS", provider: "Travis CI", isCI: true },
  { env: "NOW_BUILDER", provider: "Vercel", isCI: true },
  { env: "VERCEL", provider: "Vercel", isCI: false },
];

function getEnvironment() {
  for (const provider of PROVIDERS) {
    if (process.env[provider.env]) {
      return {
        provider: provider.provider,
        isCI: provider.isCI,
      };
    }
  }
  return {
    provider: null,
    isCI: !!process.env.CI,
  };
}

let cachedTelemetryData: GenericTelemetryData | null = null;

export const collectData = memoize(async (): Promise<GenericTelemetryData> => {
  if (cachedTelemetryData) {
    return cachedTelemetryData;
  }
  const [
    userId,
    rootCommitHash,
    gitOriginUrl,
    branchHash,
    runtime,
    environment,
  ] = await Promise.all([
    getOrCreateUserId(),
    getRootCommitHash(),
    getGitOriginUrl(),
    getBranchName().then(hashString),
    getRuntime(),
    getEnvironment(),
  ]);
  cachedTelemetryData = {
    userId: userId ?? "",
    sessionId: crypto.randomUUID(),
    platform: os.platform(),
    osVersion: os.release(),
    arch: os.arch(),
    cpus: os.cpus().length,
    memory: Math.round(os.totalmem() / 1024 / 1024),
    rootCommitHash: rootCommitHash ?? "",
    gitOriginUrl: gitOriginUrl ?? "",
    gitBranchHash: branchHash ?? "",
    runtime: runtime.name ?? "",
    runtimeVersion: runtime.version ?? "",
    ciProvider: environment.provider ?? "",
    isCI: environment.isCI,
    alchemyVersion: pkg.version,
  };
  return cachedTelemetryData;
});

export type GenericTelemetryData = {
  userId: string;
  sessionId: string;
  platform: string;
  osVersion: string;
  arch: string;
  cpus: number;
  memory: number;
  rootCommitHash: string;
  gitOriginUrl: string;
  gitBranchHash: string;
  runtime: string;
  runtimeVersion: string;
  ciProvider: string;
  isCI: boolean;
  alchemyVersion: string;
};

export type ErrorData = {
  errorTag: string;
  errorMessage: string;
  errorStack: string;
};

export type CliTelemetryData = {
  command: string;
  event: "cli.start" | "cli.success" | "cli.error";
};

export type ResourceTelemetryData = {
  phase: Phase;
  event:
    | "resource.start"
    | "resource.success"
    | "resource.error"
    | "resource.skip"
    | "resource.read";
  resource: string;
  status:
    | "creating"
    | "created"
    | "updating"
    | "updated"
    | "deleting"
    | "deleted"
    | "unknown";
  duration: number;
  replaced: boolean;
};

export type StateStoreTelemetryData = {
  event:
    | "statestore.init"
    | "statestore.deinit"
    | "statestore.list"
    | "statestore.count"
    | "statestore.get"
    | "statestore.getBatch"
    | "statestore.all"
    | "statestore.set"
    | "statestore.delete";
  stateStore: string;
  duration: number;
};

export type AlchemyTelemetryData = {
  event: "alchemy.start" | "alchemy.success" | "alchemy.error";
  duration: number;
};

export async function createEventData(
  data:
    | CliTelemetryData
    | ResourceTelemetryData
    | StateStoreTelemetryData
    | AlchemyTelemetryData,
  error?: Error,
) {
  return {
    ...data,
    ...("duration" in data
      ? { duration: Math.round(data.duration * 1000) }
      : {}),
    ...(await collectData()),
    ...serializeError(error),
  };
}

export async function sendEvent(
  data: (
    | CliTelemetryData
    | ResourceTelemetryData
    | StateStoreTelemetryData
    | AlchemyTelemetryData
  ) &
    ErrorData &
    GenericTelemetryData,
) {
  if (!TELEMETRY_DISABLED) {
    return fetch(TELEMETRY_API_URL, {
      method: "POST",
      body: JSON.stringify(data),
    });
  }
}

export async function createAndSendEvent(
  data:
    | CliTelemetryData
    | ResourceTelemetryData
    | StateStoreTelemetryData
    | AlchemyTelemetryData,
  error?: Error,
) {
  try {
    if (Scope.current.noTrack) {
      return;
    }
  } catch (error) {}
  try {
    const eventData = await createEventData(data, error);
    await sendEvent(eventData);
  } catch (error) {
    if (!SUPPRESS_TELEMETRY_ERRORS) {
      logger.warn("Failed to send telemetry event:", error);
    }
  }
}

async function hashString(input: string | null): Promise<string | null> {
  if (input == null) {
    return null;
  }
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function serializeError(error: Error | undefined) {
  if (error instanceof Error) {
    return {
      errorTag: error.name ?? "",
      errorMessage: error.message?.replaceAll(os.homedir(), "~") ?? "", // redact home directory
      errorStack: error.stack?.replaceAll(os.homedir(), "~") ?? "",
    };
  }
  return {
    errorTag: "",
    errorMessage: "",
    errorStack: "",
  };
}
