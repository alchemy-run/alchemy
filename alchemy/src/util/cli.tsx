import { Box, render, Static, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { format } from "node:util";
import { useCallback, useEffect, useRef, useState } from "react";
import { version } from "../../package.json";
import type { Phase } from "../alchemy.ts";

type Color = Parameters<typeof Text>[0]["color"];
type Task = {
  prefix?: string;
  prefixColor?: Color;
  resource?: string;
  message: string;
  status?: "pending" | "success" | "failure";
};

type LogMessage = {
  id: number;
  text: string;
};

type LoggerApi = {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  task: (id: string, data: Task) => void;
  exit: () => void;
};

type AlchemyInfo = {
  phase: Phase;
  stage: string;
  appName: string;
};

type LoggerCLIProps = {
  alchemyInfo: AlchemyInfo;
  setLogger: (logger: LoggerApi) => void;
};

export function LoggerCLI({ alchemyInfo, setLogger }: LoggerCLIProps) {
  const [logs, setLogs] = useState<LogMessage[]>([{ id: 0, text: "#heading" }]);
  const [tasks, setTasks] = useState<Map<string, Task>>(new Map());
  const { exit } = useApp();
  let nextId = useRef(1);

  const log = useCallback(
    (...args: unknown[]) =>
      setLogs((prev) => [
        ...prev,
        { id: nextId.current++, text: format(...args) },
      ]),
    [],
  );

  const task = useCallback((id: string, data: Task) => {
    setTasks((prev) => {
      prev.set(id, data);
      return prev;
    });
  }, []);

  useEffect(() => {
    setLogger({
      log: log,
      error: log,
      warn: log,
      info: log,
      debug: log,
      task: task,
      exit: () => exit(),
    });

    return () => {
      setTasks(new Map());
      setLogs([]);
    };
  }, [exit, log, setLogger, task]);

  return (
    <>
      <Static items={logs}>
        {(log) => {
          if (log.id === 0) {
            return (
              <Box flexDirection="column" key={log.text}>
                <Box flexDirection="column" borderStyle="round" padding={1}>
                  <Text color="green" bold>
                    Alchemy (v{version})
                  </Text>
                  <Text color="gray" bold>
                    App:{" "}
                    <Text color="magenta" bold={false}>
                      {alchemyInfo.appName}
                    </Text>
                  </Text>
                  <Text color="gray" bold>
                    Phase:{" "}
                    <Text color="magenta" bold={false}>
                      {alchemyInfo.phase}
                    </Text>
                  </Text>
                  <Text color="gray" bold>
                    Stage:{" "}
                    <Text color="magenta" bold={false}>
                      {alchemyInfo.stage}
                    </Text>
                  </Text>
                </Box>
                <Text color="green" bold>
                  Logs
                </Text>
              </Box>
            );
          }

          return (
            <Text color="gray" key={log.id}>
              {log.text}
            </Text>
          );
        }}
      </Static>

      <Box flexDirection="column" marginTop={1}>
        <Text color="green" bold>
          Tasks
        </Text>
        <Box flexDirection="column" paddingLeft={1}>
          {Array.from(tasks.entries()).map(([id, task]) => (
            <Box key={id} flexDirection="row" gap={1}>
              {!task.status || task.status === "pending" ? (
                <Spinner />
              ) : task.status === "success" ? (
                <Text color="green">✓</Text>
              ) : (
                <Text color="red">✗</Text>
              )}

              {task.prefix && (
                <Text color={task.prefixColor ?? "white"} bold>
                  {task.prefix.padStart(9)}
                </Text>
              )}

              {task.resource && (
                <Text color="gray" bold>
                  [{task.resource}]
                </Text>
              )}

              <Text bold>{task.message}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    </>
  );
}

const createLoggerInstance = (alchemyInfo: AlchemyInfo) => {
  let loggerApi: LoggerApi;
  const app = render(
    <LoggerCLI
      alchemyInfo={alchemyInfo}
      setLogger={(logger) => {
        loggerApi = logger;
      }}
    />,
    {
      exitOnCtrlC: true,
    },
  );

  process.on("SIGINT", () => {
    loggerApi?.exit();
    app.waitUntilExit();
    process.exit(0);
  });

  return loggerApi!;
};

export const patchConsole = (alchemyInfo: AlchemyInfo) => {
  const oldConsole = globalThis.console;
  const newConsole = createLoggerInstance(alchemyInfo);

  globalThis.console = {
    ...oldConsole,
    ...newConsole,
  };
};

declare global {
  interface Console extends LoggerApi {}
}

export const formatFQN = (fqn: string) => fqn.split("/").slice(2).join(" > ");
