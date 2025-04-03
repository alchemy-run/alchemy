import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { Secret } from "../secret";

/**
 * Model configuration for AI operations
 */
export interface ModelConfig {
  /**
   * Model ID to use
   * @default 'gpt-4o'
   */
  id?: string;

  /**
   * Model provider name
   * @default 'openai'
   */
  provider?: string;

  /**
   * Model-specific options
   */
  options?: Record<string, any>;
}

/**
 * Configuration for creating an OpenAI client
 */
export interface ClientConfig {
  /**
   * Base URL for the OpenAI API
   * @default 'https://api.openai.com/v1'
   */
  baseURL?: string;

  /**
   * OpenAI API key to use for generating content
   * If not provided, will use OPENAI_API_KEY environment variable
   */
  apiKey?: Secret;

  /**
   * Model configuration
   */
  model?: ModelConfig;
}

/**
 * Creates an OpenAI-compatible client with the given configuration
 */
export function createModel(config: ClientConfig) {
  if (config.model?.provider === "anthropic") {
    return anthropic(config.model?.id ?? "claude-3-7-sonnet-latest");
  } else {
    return openai(config.model?.id ?? "gpt-4o");
  }
}
