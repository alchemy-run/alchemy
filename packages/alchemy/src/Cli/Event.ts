export type ApplyStatus =
  | "attaching"
  | "post-attach"
  | "pending"
  | "pre-creating"
  | "creating"
  | "creating replacement"
  | "created"
  | "updating"
  | "updated"
  | "deleting"
  | "deleted"
  | "replacing"
  | "replaced"
  // Action lifecycle (see {@link Action})
  | "running"
  | "ran"
  | "skipped"
  | "fail";

export type ApplyEvent = AnnotateEvent | StatusChangeEvent | LogEvent;

export interface AnnotateEvent {
  kind: "annotate";
  id: string;
  message: string;
}

/**
 * A log line (`Effect.log*`) captured during a resource's lifecycle
 * operation, attributed to the resource being applied. Emitted by the
 * per-resource logger `apply()` injects around each lifecycle call —
 * renderers that don't care (LoggingCli, TUI) ignore these; the dashboard
 * shows them per-resource.
 */
export interface LogEvent {
  kind: "log";
  id: string;
  level: string;
  message: string;
}

export interface StatusChangeEvent {
  kind: "status-change";
  id: string; // resource id (e.g. "messages", "api")
  type: string; // resource type (e.g. "AWS::Lambda::Function", "Cloudflare::Worker")
  status: ApplyStatus;
  message?: string; // optional details
  bindingId?: string; // if this event is for a binding
}
