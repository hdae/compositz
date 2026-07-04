import { Loader2, Pencil } from "lucide-react";
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
 * Rename an instance: edit its per-instance display name. Clearing the field
 * resets the row to the recipe's own name (the backend stores no override then,
 * so the display keeps tracking the recipe after updates).
 */
export const RenameDialog = () => {
  const rename = useInstancesStore((s) => s.rename);
  const setRenameName = useInstancesStore((s) => s.setRenameName);
  const cancelRename = useInstancesStore((s) => s.cancelRename);
  const submitRename = useInstancesStore((s) => s.submitRename);

  const saving = rename?.saving ?? false;

  return (
    <Dialog
      open={rename !== undefined}
      onOpenChange={(open) => {
        if (!open) cancelRename();
      }}
    >
      <DialogContent showCloseButton={!saving}>
        <DialogHeader>
          <DialogTitle>Rename instance</DialogTitle>
          <DialogDescription>
            Shown in the list instead of the recipe name. Leave empty to use the recipe name.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submitRename();
          }}
        >
          <Input
            autoFocus
            value={rename?.name ?? ""}
            disabled={saving}
            placeholder="Display name"
            aria-label="Instance display name"
            onChange={(e) => setRenameName(e.target.value)}
          />
          {rename?.error && <p className="text-sm text-destructive">{rename.error}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={saving}
              onClick={cancelRename}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? (
                <>
                  <Loader2 className="animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <Pencil />
                  Rename
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
