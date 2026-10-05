import * as Cloudflare from "alchemy/Cloudflare";

/** Click events, counted off the redirect's hot path. */
export const Clicks = Cloudflare.Queues.Queue("Clicks");

export interface ClickEvent {
  code: string;
  at: string;
}
