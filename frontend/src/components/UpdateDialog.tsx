import { Loader2, RefreshCw, ShieldAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useInstancesStore } from "@/store/instances";

/**
 * In-place update, in two phases. First pick the ref and fetch ("Check") — the
 * new bundle is only STAGED. Then the re-trust step: new code = new trust, so the
 * staged version is shown and applied only on an explicit "Trust & update"
 * (which stops the old container and rebuilds). Closing the dialog discards the
 * staging; the instance is untouched — unlike the import trust gate, decline is
 * not destructive, so this dialog stays dismissable.
 */
export const UpdateDialog = () => {
  const update = useInstancesStore((s) => s.update);
  const setUpdateRef = useInstancesStore((s) => s.setUpdateRef);
  const cancelUpdate = useInstancesStore((s) => s.cancelUpdate);
  const checkUpdate = useInstancesStore((s) => s.checkUpdate);
  const confirmUpdate = useInstancesStore((s) => s.confirmUpdate);

  const busy = update?.phase === "fetching" || update?.phase === "committing";
  const preview = update?.preview;

  return (
    <Dialog
      open={update !== undefined}
      onOpenChange={(open) => {
        if (!open) cancelUpdate();
      }}
    >
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Update instance</DialogTitle>
          <DialogDescription>
            {update && (
              <>
                Re-fetch <span className="font-mono">{update.row.source}</span> and replace this
                instance&apos;s code. Volumes, settings, and the instance ID are kept.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {update && (update.phase === "input" || update.phase === "fetching") && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void checkUpdate();
            }}
          >
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-muted-foreground">Git ref (branch / tag / commit)</span>
              <Input
                autoFocus
                value={update.ref}
                disabled={busy}
                placeholder="default branch"
                aria-label="Git ref"
                className="font-mono"
                onChange={(e) => setUpdateRef(e.target.value)}
              />
            </label>
            {update.error && <p className="text-sm text-destructive">{update.error}</p>}
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={cancelUpdate}
              >
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={busy}>
                {update.phase === "fetching" ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Fetching…
                  </>
                ) : (
                  <>
                    <RefreshCw />
                    Check
                  </>
                )}
              </Button>
            </DialogFooter>
          </form>
        )}

        {update && preview && (update.phase === "preview" || update.phase === "committing") && (
          <div className="flex flex-col gap-4">
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-sm">
              <div className="font-medium">{preview.newName}</div>
              <div className="text-muted-foreground">
                v{preview.currentVersion} → v{preview.newVersion}
              </div>
              <div className="font-mono text-xs break-all text-muted-foreground">
                {preview.source}
              </div>
            </div>
            <p className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" />
              <span>
                New code needs new trust — only continue if you trust this source. The instance is
                stopped if running, its image is rebuilt, and the fetched code replaces the current
                bundle. Data volumes and settings are kept.
              </span>
            </p>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={cancelUpdate}
              >
                Cancel
              </Button>
              <Button type="button" size="sm" disabled={busy} onClick={() => void confirmUpdate()}>
                {update.phase === "committing" ? (
                  <>
                    <Loader2 className="animate-spin" />
                    Updating…
                  </>
                ) : (
                  <>
                    <RefreshCw />
                    Trust &amp; update
                  </>
                )}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
