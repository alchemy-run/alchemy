import { Failure } from "solid-yield";

export type Greeting = {
  message: string;
  platform: string;
};

/** The API call failed: a typed failure the view's `Errored` boundary handles. */
export class ApiError extends Failure("api-error") {}

const base = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");

export const fetchGreeting = async (): Promise<Greeting> => {
  const response = await fetch(`${base}/api/greeting`);
  if (!response.ok) {
    throw new Error(`GET /api/greeting failed: ${response.status}`);
  }
  return (await response.json()) as Greeting;
};
