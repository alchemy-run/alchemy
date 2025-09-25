import { Box, render, Text } from "ink";
// biome-ignore lint/style/useImportType: UMD global
import React, { useEffect, useMemo, useRef, useState } from "react";

// -----------------------------
// Types
// -----------------------------

export type PlanStatus =
  | "pending"
  | "creating"
  | "created"
  | "updating"
  | "updated"
  | "deleting"
  | "deleted"
  | "success"
  | "fail";

export type PlanAction = "create" | "update" | "delete" | "noop";

export interface PlanBinding {
  // Single label including target, eg: "Lambda.InvokeFunction(api)"
  id: string;
  action: PlanAction;
}

export interface PlanEvent {
  id: string; // resource id (e.g. "messages", "api")
  type: string; // resource type (e.g. "AWS::Lambda::Function", "Cloudflare::Worker")
  status: PlanStatus;
  message?: string; // optional details
  bindingId?: string; // if this event is for a binding
}

export interface PlanItem {
  id: string;
  type: string;
  action: PlanAction;
  bindings?: PlanBinding[]; // optional bindings
}

export type PlanSummary = Map<string, PlanItem>;

interface PlanTask extends Required<Pick<PlanEvent, "id" | "type" | "status">> {
  message?: string;
  updatedAt: number;
}

// -----------------------------
// Minimal event source
// -----------------------------

export interface PlanEventSource {
  subscribe(listener: (event: PlanEvent) => void): () => void;
}

export function createPlanEmitter(): PlanEventSource & {
  emit: (event: PlanEvent) => void;
} {
  const listeners = new Set<(event: PlanEvent) => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
  };
}

// -----------------------------
// Spinner
// -----------------------------

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

// -----------------------------
// Presentation helpers
// -----------------------------

function isInProgress(status: PlanStatus): boolean {
  return (
    status === "pending" ||
    status === "creating" ||
    status === "updating" ||
    status === "deleting"
  );
}

function statusPriority(status: PlanStatus): number {
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

function statusColor(status: PlanStatus): Parameters<typeof Text>[0]["color"] {
  switch (status) {
    case "pending":
      return "gray";
    case "creating":
    case "created":
      return "cyan";
    case "updating":
    case "updated":
      return "yellow";
    case "deleting":
    case "deleted":
      return "magenta";
    case "success":
      return "green";
    case "fail":
      return "red";
    default:
      return undefined;
  }
}

function statusIcon(status: PlanStatus, spinnerChar: string): string {
  if (isInProgress(status)) return spinnerChar;
  if (status === "fail") return "✗";
  return "✓"; // created/updated/deleted/success
}

function actionColor(action: PlanAction): Parameters<typeof Text>[0]["color"] {
  switch (action) {
    case "create":
      return "green";
    case "update":
      return "yellow";
    case "delete":
      return "red";
    case "noop":
      return "gray";
    default:
      return undefined;
  }
}

function actionIcon(action: PlanAction): string {
  switch (action) {
    case "create":
      return "+";
    case "update":
      return "~";
    case "delete":
      return "-";
    case "noop":
      return "•";
    default:
      return "?";
  }
}

// -----------------------------
// Plan Summary View
// -----------------------------

export interface PlanSummaryViewProps {
  plan: PlanSummary;
}

export function PlanSummaryView(
  props: PlanSummaryViewProps,
): React.JSX.Element {
  const { plan } = props;

  const items = useMemo(
    () => Array.from(plan.values()).sort((a, b) => a.id.localeCompare(b.id)),
    [plan],
  );

  if (items.length === 0) {
    return <Text color="gray">No changes planned</Text>;
  }

  const counts = items.reduce(
    (acc, item) => {
      acc[item.action]++;
      // Count bindings too
      if (item.bindings) {
        for (const binding of item.bindings) {
          acc[binding.action]++;
        }
      }
      return acc;
    },
    { create: 0, update: 0, delete: 0, noop: 0 },
  );

  return (
    <Box flexDirection="column">
      <Text bold>Plan Summary:</Text>
      <Box marginTop={1} flexDirection="column">
        {items.map((item) => {
          const color = actionColor(item.action);
          const icon = actionIcon(item.action);
          const hasBindings = item.bindings && item.bindings.length > 0;

          return (
            <Box key={item.id} flexDirection="column">
              <Box flexDirection="row">
                <Box width={2}>
                  <Text color={color}>{icon} </Text>
                </Box>
                <Box width={12}>
                  <Text bold>{item.id}</Text>
                </Box>
                <Box width={25}>
                  <Text dimColor>({item.type})</Text>
                </Box>
                <Box width={12}>
                  <Text color={color}>{item.action}</Text>
                </Box>
                {hasBindings && (
                  <Box>
                    <Text dimColor>({item.bindings!.length} bindings)</Text>
                  </Box>
                )}
              </Box>

              {/* Show bindings as sub-items */}
              {hasBindings &&
                item.bindings!.map((binding) => {
                  const bindingColor = actionColor(binding.action);
                  const bindingIcon = actionIcon(binding.action);
                  return (
                    <Box key={binding.id} flexDirection="row">
                      <Box width={4}>
                        <Text color={bindingColor}> {bindingIcon}</Text>
                      </Box>
                      <Box width={40}>
                        <Text color="cyan">{binding.id}</Text>
                      </Box>
                    </Box>
                  );
                })}
            </Box>
          );
        })}
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          Plan: {counts.create} to create, {counts.update} to update,{" "}
          {counts.delete} to delete
        </Text>
      </Box>
    </Box>
  );
}

// -----------------------------
// Plan View
// -----------------------------

export interface PlanViewProps {
  source: PlanEventSource;
  planSummary?: PlanSummary;
}

export function PlanView(props: PlanViewProps): React.JSX.Element {
  const { source } = props;
  const spinner = useGlobalSpinner();
  const [tasks, setTasks] = useState<Map<string, PlanTask>>(new Map());

  const unsubscribeRef = useRef<null | (() => void)>(null);

  useEffect(() => {
    unsubscribeRef.current?.();
    unsubscribeRef.current = source.subscribe((event) => {
      setTasks((prev) => {
        const next = new Map(prev);
        const current = next.get(event.id);

        // Only handle resource-level events, ignore binding events
        if (!event.bindingId) {
          const updated: PlanTask = {
            id: event.id,
            type: event.type,
            status: event.status,
            message: event.message ?? current?.message,
            updatedAt: Date.now(),
          };
          next.set(event.id, updated);
        }

        return next;
      });
    });
    return () => {
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, [source]);

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

  if (rows.length === 0) {
    return <Text color="gray">Waiting for plan events…</Text>;
  }

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

export function renderPlan(source: PlanEventSource, planSummary?: PlanSummary) {
  return render(<PlanView source={source} planSummary={planSummary} />);
}

// -----------------------------
// Plan Approval Workflow
// -----------------------------

export interface PlanApprovalOptions {
  plan: PlanSummary;
  onApprove: () => void;
  onDeny: () => void;
}

export function PlanApprovalView(
  props: PlanApprovalOptions,
): React.JSX.Element {
  const { plan } = props;

  return (
    <Box flexDirection="column">
      <PlanSummaryView plan={plan} />
      <Box marginTop={1}>
        <Text>Do you want to perform these actions?</Text>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Use arrow keys to select, Enter to confirm.</Text>
      </Box>
    </Box>
  );
}

export async function showPlanApproval(_plan: PlanSummary): Promise<boolean> {
  const { isCancel, select } = await import("@clack/prompts");

  const result = await select({
    message: "Do you want to perform these actions?",
    options: [
      { value: true, label: "Yes", hint: "Apply the plan" },
      { value: false, label: "No", hint: "Cancel the plan" },
    ],
    initialValue: true, // Default to "Yes"
  });

  if (isCancel(result)) {
    return false;
  }

  return result;
}

export interface PlanWorkflowOptions {
  plan: PlanSummary;
  onExecute: (
    emitter: PlanEventSource & { emit: (event: PlanEvent) => void },
  ) => Promise<void>;
}

export async function runPlanWorkflow(
  options: PlanWorkflowOptions,
): Promise<void> {
  const { plan, onExecute } = options;

  // Show plan summary
  const summaryRender = render(<PlanSummaryView plan={plan} />);

  try {
    // Ask for approval
    const approved = await showPlanApproval(plan);

    // Clean up plan summary display
    summaryRender.unmount();

    if (!approved) {
      console.log("Plan cancelled.");
      return;
    }

    // Execute the plan with live updates
    const emitter = createPlanEmitter();
    renderPlan(emitter, plan);

    await onExecute(emitter);
  } catch (error) {
    summaryRender.unmount();
    throw error;
  }
}

// -----------------------------
// Demo (lightweight, safe to remove)
// -----------------------------

if (import.meta.main) {
  // Demo plan summary
  const planSummary: PlanSummary = new Map([
    ["cache", { id: "cache", type: "Cloudflare::KV", action: "create" }],
    [
      "api",
      {
        id: "api",
        type: "Cloudflare::Worker",
        action: "update",
        bindings: [
          { id: "Lambda.InvokeFunction(api)", action: "create" },
          { id: "Queue.SendMessage(queue)", action: "update" },
          { id: "KV.Read(cache)", action: "create" },
        ],
      },
    ],
    ["assets", { id: "assets", type: "Cloudflare::R2", action: "create" }],
    [
      "database",
      {
        id: "database",
        type: "AWS::RDS::Instance",
        action: "delete",
        bindings: [{ id: "Database.Connect(database)", action: "delete" }],
      },
    ],
    [
      "old-worker",
      { id: "old-worker", type: "Cloudflare::Worker", action: "delete" },
    ],
  ]);

  // Helper to initialize tasks with bindings from plan
  function initializeTasksFromPlan(
    emitter: ReturnType<typeof createPlanEmitter>,
  ) {
    for (const item of planSummary.values()) {
      // Initialize the main resource
      emitter.emit({
        id: item.id,
        type: item.type,
        status: "pending",
      });

      // Initialize bindings if they exist
      if (item.bindings) {
        for (const binding of item.bindings) {
          emitter.emit({
            id: item.id,
            type: item.type,
            status: "pending",
            bindingId: binding.id,
          });
        }
      }
    }
  }

  async function executeDemo(emitter: ReturnType<typeof createPlanEmitter>) {
    const resources = Array.from(planSummary.values());

    // Initialize all tasks and bindings first
    initializeTasksFromPlan(emitter);

    function simulate(item: PlanItem, shouldFail = false) {
      // Generate varied, informative messages for different resources
      const getMessages = (id: string) => {
        const messages: Record<string, Record<string, string | undefined>> = {
          cache: {
            pending: "waiting for region selection",
            creating: "allocating storage in us-east-1",
            created: "100GB allocated, ready for writes",
          },
          api: {
            pending: "dependency check in progress",
            updating: "deploying v2.1.3 (15.2MB bundle)",
            updated: "deployed to 3 edge locations",
          },
          assets: {
            pending: undefined, // No extra info needed
            creating: "provisioning CDN endpoints",
            created: "configured with 90d TTL",
          },
          database: {
            pending: "checking capacity requirements",
            deleting: "backing up 2.3GB of data first",
          },
          "old-worker": {
            pending: undefined,
            deleting: "draining 4 active connections",
          },
        };

        return messages[id] || {};
      };

      const msgs = getMessages(item.id);

      const steps: { status: PlanStatus; delay: number; message?: string }[] =
        shouldFail
          ? [
              { status: "pending", delay: 1000, message: msgs.pending },
              {
                status: item.action === "delete" ? "deleting" : "creating",
                delay: 1000,
                message:
                  item.action === "delete" ? msgs.deleting : msgs.creating,
              },
              {
                status: "fail",
                delay: 1500,
                message: "Connection timeout after 30s",
              },
            ]
          : [
              { status: "pending", delay: 1000, message: msgs.pending },
              {
                status:
                  item.action === "delete"
                    ? "deleting"
                    : item.action === "update"
                      ? "updating"
                      : "creating",
                delay: 1000,
                message:
                  item.action === "delete"
                    ? msgs.deleting
                    : item.action === "update"
                      ? msgs.updating
                      : msgs.creating,
              },
              {
                status:
                  item.action === "delete"
                    ? "deleted"
                    : item.action === "update"
                      ? "updated"
                      : "created",
                delay: 1500,
                message:
                  item.action === "delete"
                    ? msgs.deleted
                    : item.action === "update"
                      ? msgs.updated
                      : msgs.created,
              },
              { status: "success", delay: 500 }, // No message for success
            ];
      let total = 0;
      for (const step of steps) {
        total += step.delay;
        setTimeout(
          () =>
            emitter.emit({
              id: item.id,
              type: item.type,
              status: step.status,
              message: step.message,
            }),
          total,
        );
      }
    }

    resources.forEach((item, i) => {
      // Make the database fail for demo purposes
      const shouldFail = item.id === "database";
      setTimeout(() => simulate(item, shouldFail), i * 800);
    });
  }

  // Run the approval workflow
  runPlanWorkflow({
    plan: planSummary,
    onExecute: executeDemo,
  }).catch(console.error);
}
