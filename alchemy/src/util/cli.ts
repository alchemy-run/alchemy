import { intro, outro, log, spinner } from "@clack/prompts";
import kleur from "kleur";
import { format } from "node:util";
import packageJson from "../../package.json" with { type: "json" };
import type { Phase } from "../alchemy.ts";
import { dedent } from "./dedent.ts";

export type Color =
  | "blue"
  | "green"
  | "red"
  | "yellow"
  | "gray"
  | "magenta"
  | "white"
  | "cyanBright"
  | "yellowBright"
  | "greenBright";

export type Task = {
  prefix?: string;
  prefixColor?: Color;
  resource?: string;
  message: string;
  status?: "pending" | "success" | "failure";
};

export type LogMessage = {
  id: number;
  text: string;
};

export type LoggerApi = {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  task: (id: string, data: Task) => void;
  exit: () => void;
};

type AlchemyInfo = {
  phase: Phase;
  stage: string;
  appName: string;
};

class ClackLogger implements LoggerApi {
  private tasks = new Map<string, { spinner: any; data: Task }>();

  constructor(private alchemyInfo: AlchemyInfo) {
    intro(kleur.green(`Alchemy (v${packageJson.version})`));

    log.message(`${kleur.gray("App:")} ${kleur.magenta(alchemyInfo.appName)}`);
    log.message(`${kleur.gray("Phase:")} ${kleur.magenta(alchemyInfo.phase)}`);
    log.message(`${kleur.gray("Stage:")} ${kleur.magenta(alchemyInfo.stage)}`);
    log.message("");
  }

  log(...args: unknown[]) {
    log.message(kleur.gray(format(...args)));
  }

  warn(...args: unknown[]) {
    log.warn(format(...args));
  }

  error(...args: unknown[]) {
    log.error(format(...args));
  }

  task(id: string, data: Task) {
    const existing = this.tasks.get(id);

    if (existing) {
      existing.spinner.stop();
    }

    const colorMap = {
      blue: kleur.blue,
      green: kleur.green,
      red: kleur.red,
      yellow: kleur.yellow,
      gray: kleur.gray,
      magenta: kleur.magenta,
      white: (text: string) => text,
      cyanBright: (text: string) => kleur.bold(kleur.cyan(text)),
      yellowBright: (text: string) => kleur.bold(kleur.yellow(text)),
      greenBright: (text: string) => kleur.bold(kleur.green(text)),
    };

    let message = "";

    if (data.prefix) {
      const color = colorMap[data.prefixColor || "white"];
      message += `${color(data.prefix.padStart(9))} `;
    }

    if (data.resource) {
      message += `${kleur.gray(`[${data.resource}]`)} `;
    }

    message += data.message;

    if (!data.status || data.status === "pending") {
      const s = spinner();
      s.start(message);
      this.tasks.set(id, { spinner: s, data });
    } else if (data.status === "success") {
      if (existing) {
        existing.spinner.stop(message);
      }
      log.success(message);
      this.tasks.delete(id);
    } else if (data.status === "failure") {
      if (existing) {
        existing.spinner.stop(message);
      }
      log.error(message);
      this.tasks.delete(id);
    }
  }

  exit() {
    for (const [, { spinner }] of this.tasks) {
      spinner.stop();
    }
    outro("Goodbye!");
    process.exit(0);
  }
}

let loggerApi: LoggerApi | null = null;
export const createLoggerInstance = (alchemyInfo: AlchemyInfo) => {
  if (loggerApi) return loggerApi;

  if (
    process.env.CI ||
    process.env.USE_FALLBACK_LOGGER ||
    !process.stdin.isTTY
  ) {
    loggerApi = createFallbackLogger(alchemyInfo);
    return loggerApi;
  }

  loggerApi = new ClackLogger(alchemyInfo);

  process.on("SIGINT", () => {
    loggerApi?.exit();
    process.exit(0);
  });

  return loggerApi;
};

export const createDummyLogger = (): LoggerApi => {
  return {
    log: () => {},
    error: () => {},
    warn: () => {},
    task: () => {},
    exit: () => {},
  };
};

export const createFallbackLogger = (alchemyInfo: AlchemyInfo): LoggerApi => {
  console.log(dedent`
    Alchemy (v${packageJson.version})
    App: ${alchemyInfo.appName}
    Phase: ${alchemyInfo.phase}
    Stage: ${alchemyInfo.stage}
    
  `);

  return {
    log: console.log,
    error: console.error,
    warn: console.warn,
    task: (_id: string, data: Task) => {
      const prefix = data.prefix ? `${data.prefix.padStart(9)} ` : "";
      const resource = data.resource ? `[${data.resource}] ` : "";
      const status =
        data.status === "success"
          ? "✓ "
          : data.status === "failure"
            ? "✗ "
            : "⋯ ";
      console.log(`${status}${prefix}${resource}${data.message}`);
    },
    exit: () => process.exit(0),
  };
};

export const formatFQN = (fqn: string) => fqn.split("/").slice(2).join(" > ");
