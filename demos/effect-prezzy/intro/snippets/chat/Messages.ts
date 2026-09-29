import * as Cloudflare from "alchemy/Cloudflare";

// #region show
export const Messages = Cloudflare.Queues.Queue("Messages");

export type Message = { room: string; text: string };
// #endregion show
