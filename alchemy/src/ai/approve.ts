import type { CoreMessage } from "ai";
import { type } from "arktype";
import { Data } from "./data";

/**
 * Properties for approving or denying content
 */
export interface ApproveProps {
  /**
   * Content to be reviewed
   * Use alchemy template literals to include file context:
   * @example
   * content: await alchemy`
   *   Review this code:
   *   ${alchemy.file("src/api.ts")}
   * `
   *
   * Required unless messages are provided
   */
  content?: string;

  /**
   * Prompt for the approval decision
   * This should include specific criteria for approval or denial
   * @example
   * prompt: "Approve this code if it follows security best practices and has proper error handling."
   *
   * Required unless messages are provided
   */
  prompt?: string;

  /**
   * System prompt for the model
   * This is used to provide instructions to the model about how to make the decision
   */
  system?: string;

  /**
   * Message history for the conversation
   * If provided, this will be used instead of the prompt and content
   */
  messages?: CoreMessage[];

  /**
   * Temperature for controlling randomness in generation.
   * Higher values (e.g., 0.8) make output more random,
   * lower values (e.g., 0.2) make it more deterministic.
   * @default 0.2 (lower for more consistent decisions)
   */
  temperature?: number;
}

/**
 * Result of the approval process
 */
export interface ApprovalResult {
  /**
   * Whether the content was approved
   */
  approved: boolean;

  /**
   * Explanation for the decision
   */
  explanation: string;

  /**
   * Suggestions for improvement if denied
   */
  suggestions?: string[];

  /**
   * Updated message history with the approval response appended
   */
  messages: CoreMessage[];
}

export type Approve = ApprovalResult;

/**
 * Default system prompt for approval decisions
 */
const DEFAULT_APPROVE_SYSTEM_PROMPT = `You are an expert content reviewer tasked with approving or denying content based on specific criteria.

Your role is to:
1. Carefully evaluate the content against the provided criteria
2. Make a clear decision to approve or deny the content
3. Provide a detailed explanation for your decision
4. If denying, offer specific suggestions for improvement

Be objective, thorough, and fair in your assessment.`;

/**
 * Approves or denies content based on a prompt or message history
 *
 * @example
 * // Approve or deny a code file
 * const result = await Approve("code-approval", {
 *   content: await alchemy`
 *     Review this API implementation:
 *     ${alchemy.file("src/api.ts")}
 *   `,
 *   prompt: "Approve this code if it follows security best practices and has proper error handling."
 * });
 *
 * if (result.approved) {
 *   console.log("Content approved:", result.explanation);
 * } else {
 *   console.log("Content denied:", result.explanation);
 *   console.log("Suggestions:", result.suggestions);
 * }
 *
 * @example
 * // Approve or deny using message history
 * const result = await Approve("doc-approval-with-history", {
 *   content: "This is the content to review",
 *   prompt: "Approve this documentation if it is clear and accurate",
 *   messages: [
 *     { role: "user", content: "Can you review this documentation?" },
 *     { role: "assistant", content: "Yes, I'd be happy to review it." },
 *     { role: "user", content: "Please check for clarity and accuracy." }
 *   ]
 * });
 */
export async function Approve(
  id: string,
  props: ApproveProps
): Promise<ApprovalResult> {
  // Create messages array if not provided
  const messages =
    props.messages ||
    (props.content && props.prompt
      ? [
          {
            role: "user" as const,
            content: `${props.content}\n\n${props.prompt}`,
          },
        ]
      : []);

  if (messages.length === 0) {
    throw new Error(
      "Either messages or both content and prompt must be provided"
    );
  }

  const data = await Data(id, {
    schema: type({
      approved: "boolean",
      explanation: "string",
      suggestions: "string[]?",
    }),
    messages,
    system: props.system || DEFAULT_APPROVE_SYSTEM_PROMPT,
    temperature: props.temperature ?? 0.2,
  });

  // Return the result with updated messages from Data
  return {
    ...data.object,
    messages: data.messages,
  };
}
