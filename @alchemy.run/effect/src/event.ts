export type ApplyStatus =
  | "pending"
  | "creating"
  | "created"
  | "updating"
  | "updated"
  | "deleting"
  | "deleted"
  | "success"
  | "fail";

export type ApplyEvent = AnnotateEvent | StatusChangeEvent;

export interface AnnotateEvent {
  kind: "annotate";
  id: string;
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
