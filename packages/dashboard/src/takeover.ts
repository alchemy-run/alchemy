/**
 * Same-origin tab takeover: every `--ui` run opens the dashboard URL (the
 * OS focuses the browser natively), and the freshly opened tab supersedes
 * any older dashboard tab. The CLI cannot focus an existing tab without
 * OS-automation permissions, so the newest tab wins instead: older tabs
 * close themselves — or, when the browser refuses to script-close a
 * user-opened tab, drop to a stale screen so exactly one tab reads as
 * live.
 */
const CHANNEL_NAME = "alchemy-dashboard-takeover";

const tabId = `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

export const initTakeover = (onSuperseded: () => void): void => {
  if (typeof BroadcastChannel === "undefined") {
    return;
  }
  const channel = new BroadcastChannel(CHANNEL_NAME);
  channel.onmessage = (event: MessageEvent) => {
    const data = event.data as { type?: string; id?: string } | undefined;
    if (data?.type === "takeover" && data.id !== tabId) {
      window.close();
      // still alive after close() means the browser refused (a tab the
      // user opened with real history) — fall back to the stale screen
      setTimeout(onSuperseded, 200);
    }
  };
  channel.postMessage({ type: "takeover", id: tabId });
};
