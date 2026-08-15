/** @jsxImportSource react */
import type { ReactNode } from "react";
import { useSyncExternalStore } from "react";
import { useGlyphs } from "./Environment.tsx";
import { Gutter, Stack } from "./Layout.tsx";
import { Text } from "./Typography.tsx";

export interface TranscriptEntry {
  readonly key: number;
  readonly depth: number;
  readonly view: ReactNode;
}

export class TranscriptStore {
  private entries: ReadonlyArray<TranscriptEntry> = [];
  private readonly listeners = new Set<() => void>();
  private nextKey = 0;

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  readonly snapshot = () => this.entries;
  private commit(entries: ReadonlyArray<TranscriptEntry>) {
    this.entries = entries;
    for (const listener of this.listeners) listener();
  }
  readonly append = (view: ReactNode, depth = 0) => {
    this.commit([...this.entries, { key: this.nextKey++, depth, view }]);
  };
  readonly clear = () => this.commit([]);
}

export const Transcript = ({
  store,
  maxRows,
}: {
  readonly store: TranscriptStore;
  readonly maxRows?: number;
}) => {
  const all = useSyncExternalStore(store.subscribe, store.snapshot);
  const hidden = Math.max(0, all.length - (maxRows ?? all.length));
  const entries = hidden === 0 ? all : all.slice(hidden);
  return (
    <Stack>
      {hidden === 0 ? null : <Text tone="muted">… {hidden} earlier lines</Text>}
      {entries.map((entry) => (
        <Gutter key={entry.key} depth={entry.depth}>
          {entry.view}
        </Gutter>
      ))}
    </Stack>
  );
};

export const AnsweredPrompt = ({
  message,
  answer,
  below = false,
}: {
  readonly message: string;
  readonly answer: string;
  readonly below?: boolean;
}) => {
  const glyphs = useGlyphs();
  return below ? (
    <Stack>
      <Text>
        <Text tone="success">{glyphs.success}</Text> {message}
      </Text>
      <Text tone="muted"> {answer}</Text>
    </Stack>
  ) : (
    <Text>
      <Text tone="success">{glyphs.success}</Text> {message}{" "}
      <Text tone="muted">{answer}</Text>
    </Text>
  );
};

export const CancelledPrompt = ({ message }: { readonly message: string }) => {
  const glyphs = useGlyphs();
  return (
    <Text tone="muted">
      <Text tone="danger">{glyphs.error}</Text> {message} cancelled
    </Text>
  );
};
