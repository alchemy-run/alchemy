/** First-run screen: point the SPA at a deployed service + token. */
import { useState } from "react";
import { defaultUrl, listRepos, saveConnection } from "../api.ts";
import { Button, ErrorBox, Input, RepoIcon } from "../components.tsx";

export const ConnectPage = ({ onConnected }: { onConnected: () => void }) => {
  const [url, setUrl] = useState(defaultUrl());
  const [token, setToken] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const trimmed = url.trim().replace(/\/+$/, "");
      // Probe with the connection before persisting it.
      await listRepos({ url: trimmed, token: token.trim() }, { limit: 1 });
      saveConnection(trimmed, token.trim());
      onConnected();
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto mt-24 max-w-md px-4">
      <div className="mb-6 flex items-center justify-center gap-2 text-xl font-semibold">
        <RepoIcon className="size-6" />
        git service
      </div>
      <form
        className="space-y-4 rounded-lg border border-border-muted bg-canvas-subtle p-6"
        onSubmit={(event) => {
          event.preventDefault();
          void connect();
        }}
      >
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Service URL</span>
          <Input
            value={url}
            onChange={setUrl}
            placeholder="https://….workers.dev"
            mono
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Admin token</span>
          <Input
            value={token}
            onChange={setToken}
            type="password"
            placeholder="GIT_SERVICE_ADMIN_TOKEN"
            mono
          />
          <span className="block text-xs text-fg-muted">
            The deployer secret (<code>GIT_SERVICE_ADMIN_TOKEN</code>). Stored
            in this browser's localStorage only.
          </span>
        </label>
        {error != null && <ErrorBox error={error} />}
        <Button kind="primary" disabled={busy || !url || !token} type="submit">
          {busy ? "Connecting…" : "Connect"}
        </Button>
      </form>
    </div>
  );
};
