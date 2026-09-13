/**
 * The app's CONFIRM — an in-app dialog, never `window.confirm`. The
 * native dialog is host-dependent: an embedded browser can answer it
 * `false` without rendering anything, and a destructive flow gated on
 * it silently does nothing there. Asking in-page renders everywhere
 * the app does.
 *
 * `confirm(message)` resolves the operator's answer; `<Confirmer />`
 * (mounted ONCE, in the App shell) renders the question with Cancel /
 * Delete. A question that arrives while one is up answers the earlier
 * one `false` — the operator faces one at a time.
 */

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useEffect, useState } from "react";

interface Ask {
  readonly message: string;
  readonly resolve: (ok: boolean) => void;
}

let pending: Ask | undefined;
let notify: (() => void) | undefined;

/** Ask the operator; resolves `true` on Delete, `false` on Cancel
 *  (or the dialog dismissed, or no `Confirmer` mounted to ask). */
export const confirm = (message: string): Promise<boolean> => {
  if (notify === undefined) return Promise.resolve(false);
  return new Promise((resolve) => {
    pending?.resolve(false);
    pending = { message, resolve };
    notify?.();
  });
};

export const Confirmer = () => {
  const [ask, setAsk] = useState<Ask | undefined>(undefined);
  useEffect(() => {
    notify = () => setAsk(pending);
    return () => {
      notify = undefined;
    };
  }, []);
  const answer = (ok: boolean) => {
    ask?.resolve(ok);
    if (pending === ask) pending = undefined;
    setAsk(undefined);
  };
  return (
    <Dialog
      open={ask !== undefined}
      onOpenChange={(open) => {
        if (!open) answer(false);
      }}
    >
      <DialogContent data-confirm="" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Are you sure?</DialogTitle>
          <DialogDescription>{ask?.message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => answer(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => answer(true)}>
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
