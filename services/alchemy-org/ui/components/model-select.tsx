/**
 * The MODEL SELECTOR — which model a session samples with, chosen
 * from the org's catalog (`GET /api/models`). One control for two
 * subjects: a thread (its pick reaches its engineers) and a lone
 * engineer session (its own pick). The choice lands as a method on
 * the session object (`PUT /api/chats/:id/model`) and takes effect at
 * the next sampling — nothing in flight is cut.
 */

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  fetchModels,
  getChatModel,
  setChatModel,
  type ModelCatalog,
  type SessionModel,
} from "@/lib/channel";
import { cn } from "@/lib/utils";
import { Cpu } from "lucide-react";
import { useEffect, useState } from "react";

/** The catalog is deploy-constant — fetched once per page, shared. */
let catalogPromise: Promise<ModelCatalog> | undefined;
const useModelCatalog = (): ModelCatalog | undefined => {
  const [catalog, setCatalog] = useState<ModelCatalog | undefined>(undefined);
  useEffect(() => {
    let live = true;
    catalogPromise ??= fetchModels().catch((error: unknown) => {
      // a failed read must not stick: the next mount retries
      catalogPromise = undefined;
      throw error;
    });
    catalogPromise.then(
      (value) => {
        if (live) setCatalog(value);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, []);
  return catalog;
};

/** The default's marker in the select — an id no catalog entry has. */
const DEFAULT_VALUE = "__default__";
/** "Not known yet" — keeps the select CONTROLLED (a string value from
 *  the first render) while the pick is still being read; never an item. */
const PENDING_VALUE = "__pending__";

/**
 * The control itself, given the current pick. `value === null` is the
 * default; `undefined` is "not known yet" (renders disabled).
 */
export const ModelSelect = ({
  value,
  onChange,
  busy,
  size = "sm",
  className,
  label,
}: {
  value: string | null | undefined;
  onChange: (model: string | null) => void;
  busy?: boolean;
  size?: "sm" | "default";
  className?: string;
  /** The accessible name — says whose model this is. */
  label: string;
}) => {
  const catalog = useModelCatalog();
  const fallback = catalog?.models.find((m) => m.id === catalog.default);
  const known =
    value === null || value === undefined
      ? undefined
      : catalog?.models.find((m) => m.id === value);
  return (
    <Select
      value={
        value === undefined
          ? PENDING_VALUE
          : value === null
            ? DEFAULT_VALUE
            : value
      }
      onValueChange={(next) => {
        if (next === PENDING_VALUE) return;
        onChange(next === DEFAULT_VALUE ? null : next);
      }}
      disabled={catalog === undefined || value === undefined || busy}
    >
      <SelectTrigger
        size={size}
        aria-label={label}
        aria-busy={busy || undefined}
        data-model={value === null ? "default" : value}
        title={`${label} — takes effect at its next sampling; nothing in flight is interrupted`}
        className={cn(
          "gap-1.5 border-border bg-card px-2 text-[11px] text-muted-foreground shadow-none hover:bg-accent hover:text-foreground data-[size=sm]:h-6",
          className,
        )}
      >
        <Cpu className="size-3" />
        <SelectValue placeholder="model…">
          {value === null
            ? `Default${fallback === undefined ? "" : ` · ${fallback.label}`}`
            : (known?.label ?? value)}
        </SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" align="end">
        <SelectItem value={DEFAULT_VALUE}>
          <span className="flex flex-col">
            <span>Default</span>
            {fallback !== undefined && (
              <span className="text-[10px] text-muted-foreground">
                {fallback.label} — the org's choice
              </span>
            )}
          </span>
        </SelectItem>
        {catalog?.models.map((entry) => (
          <SelectItem key={entry.id} value={entry.id}>
            <span className="flex flex-col">
              <span>{entry.label}</span>
              <span className="text-[10px] text-muted-foreground">
                {entry.provider} · {entry.id}
              </span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
};

/**
 * The selector bound to a SESSION: reads the pick over GET on mount
 * (unless `current` is already known — a thread's state carries it),
 * writes it over PUT. Hides itself for a session that has no model to
 * pick (404).
 */
export const SessionModelSelect = ({
  sessionId,
  current,
  label,
  size,
  className,
}: {
  sessionId: string;
  /** The pick when the caller already knows it (a thread's state);
   *  `null` = default. Omit to read it over GET. */
  current?: string | null;
  label: string;
  size?: "sm" | "default";
  className?: string;
}) => {
  const [read, setRead] = useState<string | null | undefined>(current);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  // a caller-known pick always wins; otherwise read once per session
  useEffect(() => {
    if (current !== undefined) {
      setRead(current);
      return;
    }
    let live = true;
    setRead(undefined);
    getChatModel(sessionId)
      .then(async (response) => {
        if (!live) return;
        if (response.status === 404) {
          setHidden(true);
          return;
        }
        const body = (await response.json()) as SessionModel;
        setRead(body.model);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [sessionId, current]);

  if (hidden) return null;
  return (
    <ModelSelect
      value={read}
      busy={busy}
      size={size}
      className={className}
      label={label}
      onChange={(model) => {
        const before = read;
        setRead(model);
        setBusy(true);
        setChatModel(sessionId, model)
          .then(async (response) => {
            if (!response.ok) {
              setRead(before);
              return;
            }
            const body = (await response.json()) as SessionModel;
            setRead(body.model);
          })
          .catch(() => setRead(before))
          .finally(() => setBusy(false));
      }}
    />
  );
};
