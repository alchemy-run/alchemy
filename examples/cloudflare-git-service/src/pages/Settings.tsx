/** The Settings tab: access tokens, storage stats, compaction, delete. */
import { useEffect, useState } from "react";
import {
  compactRepo,
  createToken,
  deleteRepo,
  listTokens,
  revokeToken,
  type CreatedToken,
  type TokenInfo,
  type TokenScope,
} from "../api.ts";
import {
  Badge,
  Button,
  CopyButton,
  ErrorBox,
  Input,
  Spinner,
} from "../components.tsx";
import { formatBytes, timeAgo } from "../format.ts";
import { useRouter } from "../router.tsx";
import type { RepoContext } from "./Repo.tsx";

const StorageCard = ({ context }: { context: RepoContext }) => {
  const { objects, lastPush } = context.repo;
  const [compacting, setCompacting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <section className="rounded-md border border-border-muted p-4">
      <h2 className="mb-3 font-semibold">Storage</h2>
      <dl className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-4">
        <dt className="text-fg-muted">Total</dt>
        <dd>{formatBytes(objects.bytes)}</dd>
        <dt className="text-fg-muted">Loose objects</dt>
        <dd>{objects.loose}</dd>
        <dt className="text-fg-muted">Packed (R2)</dt>
        <dd>{objects.packed}</dd>
        <dt className="text-fg-muted">Oversize (R2)</dt>
        <dd>{objects.r2}</dd>
      </dl>
      {lastPush !== null && (
        <p className="mt-3 text-xs text-fg-muted">
          Last push: {lastPush.objects} objects,{" "}
          {formatBytes(lastPush.bytes)} — server ingest {lastPush.ingestMs}ms
          (sql {lastPush.stageMs}ms), total {lastPush.totalMs}ms
        </p>
      )}
      <div className="mt-3">
        <Button
          disabled={compacting || objects.loose === 0}
          onClick={() => {
            setCompacting(true);
            setError(null);
            compactRepo(
              context.connection,
              context.repo.owner,
              context.repo.name,
            )
              .then(() => setCompacting(false))
              .catch((cause) => {
                setError(cause);
                setCompacting(false);
              });
          }}
        >
          {compacting ? "Compaction scheduled ✓" : "Compact loose objects"}
        </Button>
      </div>
      {error != null && <ErrorBox error={error} />}
    </section>
  );
};

const TokensCard = ({ context }: { context: RepoContext }) => {
  const [tokens, setTokens] = useState<TokenInfo[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<TokenScope>("write");
  const [minted, setMinted] = useState<CreatedToken | null>(null);
  const { connection, repo } = context;

  const load = () =>
    listTokens(connection, repo.owner, repo.name)
      .then((items) => setTokens(items))
      .catch(setError);

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo.repoId]);

  return (
    <section className="rounded-md border border-border-muted p-4">
      <h2 className="mb-3 font-semibold">Access tokens</h2>
      {minted !== null && (
        <div className="mb-3 space-y-2 rounded-md border border-success/40 bg-success/5 p-3 text-sm">
          <p className="font-medium text-success">
            Token “{minted.name}” created — shown exactly once:
          </p>
          <div className="flex items-center gap-2">
            <code className="grow overflow-x-auto rounded bg-canvas-subtle px-2 py-1 font-mono text-xs">
              {minted.token}
            </code>
            <CopyButton text={minted.token} />
          </div>
        </div>
      )}
      <form
        className="mb-4 flex flex-wrap items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          createToken(connection, repo.owner, repo.name, {
            name: name.trim(),
            scope,
          })
            .then((token) => {
              setMinted(token);
              setName("");
              void load();
            })
            .catch(setError);
        }}
      >
        <div className="w-48">
          <Input value={name} onChange={setName} placeholder="Token name" />
        </div>
        <select
          value={scope}
          onChange={(event) => setScope(event.target.value as TokenScope)}
          className="rounded-md border border-border-muted bg-canvas px-2 py-1.5 text-sm"
        >
          <option value="read">read</option>
          <option value="write">write</option>
          <option value="admin">admin</option>
        </select>
        <Button kind="primary" type="submit" disabled={name.trim().length === 0}>
          Generate token
        </Button>
      </form>
      {error != null && <ErrorBox error={error} />}
      {tokens === null ? (
        <Spinner />
      ) : tokens.length === 0 ? (
        <p className="text-sm text-fg-muted">No tokens.</p>
      ) : (
        <ul className="divide-y divide-border-muted">
          {tokens.map((token) => (
            <li
              key={token.id}
              className="flex items-center justify-between gap-4 py-2 text-sm"
            >
              <div className="flex items-center gap-2">
                <span className="font-medium">{token.name}</span>
                <Badge>{token.scope}</Badge>
                <span className="text-xs text-fg-muted">
                  created {timeAgo(token.createdAt)}
                  {token.lastUsedAt !== null &&
                    ` · used ${timeAgo(token.lastUsedAt)}`}
                </span>
              </div>
              <Button
                kind="danger"
                onClick={() => {
                  revokeToken(connection, repo.owner, repo.name, token.id)
                    .then(() => void load())
                    .catch(setError);
                }}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const DangerCard = ({ context }: { context: RepoContext }) => {
  const { navigate } = useRouter();
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const full = `${context.repo.owner}/${context.repo.name}`;
  return (
    <section className="rounded-md border border-danger/40 p-4">
      <h2 className="mb-2 font-semibold text-danger">Danger zone</h2>
      <p className="mb-3 text-sm text-fg-muted">
        Deleting a repository destroys its refs, objects, and tokens. Type{" "}
        <code className="font-mono">{full}</code> to confirm.
      </p>
      <div className="flex items-center gap-2">
        <div className="w-64">
          <Input value={confirm} onChange={setConfirm} placeholder={full} mono />
        </div>
        <Button
          kind="danger"
          disabled={confirm !== full || busy}
          onClick={() => {
            setBusy(true);
            deleteRepo(context.connection, context.repo.owner, context.repo.name)
              .then(() => navigate("/"))
              .catch((cause) => {
                setError(cause);
                setBusy(false);
              });
          }}
        >
          {busy ? "Deleting…" : "Delete this repository"}
        </Button>
      </div>
      {error != null && <ErrorBox error={error} />}
    </section>
  );
};

export const SettingsTab = ({ context }: { context: RepoContext }) => (
  <div className="space-y-4">
    <StorageCard context={context} />
    <TokensCard context={context} />
    <DangerCard context={context} />
  </div>
);
