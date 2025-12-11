// biome-ignore lint/style/useImportType: UMD global
import React, { useEffect, useMemo, useRef, useState } from "react";

import { Box, Text } from "ink";
import type {
  ApplyEvent,
  ApplyStatus,
  StatusChangeEvent,
} from "../../event.ts";
import type { IPlan } from "../../plan.ts";

interface ProgressEventSource {
  subscribe(listener: (event: ApplyEvent) => void): () => void;
}

interface PlanTask
  extends Required<Pick<StatusChangeEvent, "id" | "type" | "status">> {
  message?: string;
  updatedAt: number;
}

interface PlanProgressProps {
  source: ProgressEventSource;
  plan: IPlan;
}

export function PlanProgress(props: PlanProgressProps): React.JSX.Element {
  const { source, plan } = props;
  const spinner = useGlobalSpinner();
  const [tasks, setTasks] = useState<Map<string, PlanTask>>(() => {
    // Initialize tasks from the plan with appropriate starting status
    const initialTasks = new Map<string, PlanTask>();
    const nodes = [
      ...Object.entries(plan.resources),
      ...Object.entries(plan.deletions),
    ];
    for (const [id, item] of nodes) {
      const planItem = item!;
      const status: ApplyStatus =
        planItem.action === "noop" ? "success" : "pending";
      initialTasks.set(id, {
        id,
        type: planItem.resource.type,
        status,
        updatedAt: Date.now(),
      });
    }
    return initialTasks;
  });

  const unsubscribeRef = useRef<null | (() => void)>(null);

  useEffect(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = source.subscribe((event) => {
      setTasks((prev) => {
        const next = new Map(prev);
        const current = next.get(event.id);

        if (event.kind === "status-change") {
          if (!event.bindingId) {
            // Only handle resource-level events, ignore binding events
            const updated: PlanTask = {
              id: event.id,
              type: event.type,
              status: event.status,
              message: event.message ?? current?.message,
              updatedAt: Date.now(),
            };
            next.set(event.id, updated);
          }
        } else if (event.kind === "annotate" && current) {
          next.set(event.id, {
            ...current,
            message: event.message,
            updatedAt: Date.now(),
          });
        }

        return next;
      });
    });
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [source]);

  // Reinitialize tasks when plan changes
  useEffect(() => {
    setTasks(() => {
      const initialTasks = new Map<string, PlanTask>();
      const nodes = [
        ...Object.entries(plan.resources),
        ...Object.entries(plan.deletions),
      ];
      for (const [id, item] of nodes) {
        const planItem = item!;
        const status: ApplyStatus =
          planItem.action === "noop" ? "success" : "pending";
        initialTasks.set(id, {
          id,
          type: planItem.resource.type,
          status,
          updatedAt: Date.now(),
        });
      }
      return initialTasks;
    });
  }, [plan]);

  const rows = useMemo(
    () =>
      Array.from(tasks.values()).sort((a, b) => {
        // First sort by status priority
        const priorityDiff =
          statusPriority(a.status) - statusPriority(b.status);
        if (priorityDiff !== 0) return priorityDiff;

        // Then sort by ID for consistent ordering within same priority
        return a.id.localeCompare(b.id);
      }),
    [tasks],
  );

  return (
    <Box flexDirection="column">
      {rows.map((task) => {
        const color = statusColor(task.status);
        const icon = statusIcon(task.status, spinner);

        return (
          <Box key={task.id} flexDirection="row">
            <Box width={2}>
              <Text color={color}>{icon} </Text>
            </Box>
            <Box width={12}>
              <Text bold>{task.id}</Text>
            </Box>
            <Box width={25}>
              <Text dimColor>({task.type})</Text>
            </Box>
            <Box width={12}>
              <Text color={color}>{task.status}</Text>
            </Box>
            <Box>
              {task.message ? <Text dimColor>• {task.message}</Text> : null}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function statusPriority(status: ApplyStatus): number {
  switch (status) {
    case "success":
    case "created":
    case "updated":
    case "deleted":
      return 0; // highest priority (success)
    case "fail":
      return 1;
    case "creating":
    case "updating":
    case "deleting":
      return 2; // in progress
    case "pending":
      return 3; // lowest priority (pending)
    default:
      return 4;
  }
}

function statusColor(status: ApplyStatus): Parameters<typeof Text>[0]["color"] {
  switch (status) {
    case "pending":
      return "gray";
    case "creating":
    case "created":
      return "green";
    case "updating":
    case "updated":
      return "yellow";
    case "deleting":
    case "deleted":
      return "red";
    case "success":
      return "green";
    case "fail":
      return "redBright";
    default:
      return undefined;
  }
}

function statusIcon(status: ApplyStatus, spinnerChar: string): string {
  if (isInProgress(status)) return spinnerChar;
  if (status === "fail") return "✗";
  return "✓"; // created/updated/deleted/success
}

function isInProgress(status: ApplyStatus): boolean {
  return (
    status === "pending" ||
    status === "creating" ||
    status === "updating" ||
    status === "deleting"
  );
}

const spinnerFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function useGlobalSpinner(intervalMs = 80): string {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => {
      setIndex((i) => (i + 1) % spinnerFrames.length);
    }, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return spinnerFrames[index];
}
