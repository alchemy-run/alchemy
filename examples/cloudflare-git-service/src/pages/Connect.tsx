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
      const secret = token.trim() === "" ? undefined : token.trim();
      // Probe with the connection before persisting it — anonymous works
      // too (the service lists public repos to tokenless callers).
      await listRepos({ url: trimmed, token: secret }, { limit: 1 });
      saveConnection(trimmed, secret);
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
          <span className="text-sm font-medium">
            Token <span className="font-normal text-fg-muted">(optional)</span>
          </span>
          <Input
            value={token}
            onChange={setToken}
            type="password"
            placeholder="GIT_SERVICE_ADMIN_TOKEN"
            mono
          />
          <span className="block text-xs text-fg-muted">
            Leave empty to browse public repos anonymously. The admin key
            (<code>GIT_SERVICE_ADMIN_TOKEN</code>) or a repo token unlocks
            private repos and writes. Stored in this browser's localStorage
            only.
          </span>
        </label>
        {error != null && <ErrorBox error={error} />}
        <Button kind="primary" disabled={busy || !url} type="submit">
          {busy ? "Connecting…" : "Connect"}
        </Button>
      </form>
    </div>
  );
};
