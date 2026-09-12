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

/** "Not known yet" — keeps the select CONTROLLED (a string value from
 *  the first render) while the pick is still being read; never an item. */
const PENDING_VALUE = "__pending__";

/**
 * The control itself, given the current pick. There is no "default"
 * entry: a session that never chose (`value === null`) simply reads
 * as the org's default model, and picking any entry — that one
 * included — makes the choice explicit on the session. `undefined`
 * is "not known yet" (renders disabled).
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
  onChange: (model: string) => void;
  busy?: boolean;
  size?: "sm" | "default";
  className?: string;
  /** The accessible name — says whose model this is. */
  label: string;
}) => {
  const catalog = useModelCatalog();
  // what the session actually samples with: its pick, else the org's
  // default
  const effective =
    value === null || value === undefined ? catalog?.default : value;
  const known =
    effective === undefined
      ? undefined
      : catalog?.models.find((m) => m.id === effective);
  return (
    <Select
      value={effective ?? PENDING_VALUE}
      onValueChange={(next) => {
        // "" is Radix echoing a FORM RESET (a composer resets after
        // every send, and React can reset a form on mount) — never a
        // user's pick; the controlled value keeps rendering the truth
        if (next !== PENDING_VALUE && next !== "") onChange(next);
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
          // a CONTROL-sized chip (the composer's buttons are 32px):
          // the whole box is the target, not just the label inside it
          "gap-1.5 border-border bg-card px-3 text-[11px] text-muted-foreground shadow-none hover:bg-accent hover:text-foreground data-[size=sm]:h-8",
          className,
        )}
      >
        <Cpu className="size-3" />
        <SelectValue placeholder="model…">
          {known?.label ?? effective}
        </SelectValue>
      </SelectTrigger>
      <SelectContent position="popper" align="end">
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
 * The selector bound to a SESSION: reads the pick over GET on mount,
 * writes it over PUT. Hides itself for a session that has no model to
 * pick (404).
 */
export const SessionModelSelect = ({
  sessionId,
  label,
  size,
  className,
}: {
  sessionId: string;
  label: string;
  size?: "sm" | "default";
  className?: string;
}) => {
  const [read, setRead] = useState<string | null | undefined>(undefined);
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
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
  }, [sessionId]);

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
