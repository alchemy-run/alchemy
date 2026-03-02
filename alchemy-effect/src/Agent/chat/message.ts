import * as S from "effect/Schema";
import { TaskId } from "../process/task.ts";

export type Message = (typeof Message)["Type"];
export const Message = S.Union(
  S.suspend((): S.Schema<TextMessage> => TextMessage),
  S.suspend((): S.Schema<TaskMessage> => TaskMessage),
);

export type MessageId = string;

export const MessageId = S.String.annotations({
  description: "The ID of the message",
});

export class TextMessage extends S.Class<TextMessage>("TextMessage")({
  messageId: MessageId,
  content: S.String.annotations({
    description: "The content of the message",
  }),
  sender: S.String.annotations({
    description: "The sender of the message",
  }),
  timestamp: S.Number.annotations({
    description: "The timestamp of the message",
  }),
}) {}

export class TaskMessage extends S.Class<TaskMessage>("TaskMessage")({
  messageId: MessageId,
  taskId: TaskId,
  taskDescription: S.String.annotations({
    description: "The description of the task",
  }),
}) {}
