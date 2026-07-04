import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { useInstancesStore } from "@/store/instances";

/**
 * Delete confirmation. The container + built image always go; data volumes are deleted
 * by DEFAULT (opt-out) and host-browsable bind data only on opt-in. Options reset to
 * these defaults each time the dialog opens for a new instance.
 */
export const DeleteDialog = () => {
  const target = useInstancesStore((s) => s.deleteTarget);
  const cancelDelete = useInstancesStore((s) => s.cancelDelete);
  const remove = useInstancesStore((s) => s.remove);

  const [volumes, setVolumes] = useState(true);
  const [bindData, setBindData] = useState(false);

  const id = target?.instanceId;
  useEffect(() => {
    if (id !== undefined) {
      setVolumes(true);
      setBindData(false);
    }
  }, [id]);

  const confirm = () => {
    if (target) {
      void remove(target.instanceId, { volumes, bindData });
      cancelDelete();
    }
  };

  return (
    <AlertDialog
      open={target !== undefined}
      onOpenChange={(open) => {
        if (!open) cancelDelete();
      }}
    >
      <AlertDialogContent>
        <AlertDialogTitle>Delete this instance?</AlertDialogTitle>
        <AlertDialogDescription>
          <span className="font-mono">{target?.instanceId}</span> — the container and its image are
          removed. Need a copy of the data? Export it from the Settings tab first.
        </AlertDialogDescription>
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-2">
            <Checkbox
              id="delete-volumes"
              checked={volumes}
              onCheckedChange={(checked) => setVolumes(checked === true)}
            />
            <Label htmlFor="delete-volumes" className="font-normal">
              Delete data volumes{" "}
              <span className="text-xs text-muted-foreground">(irreversible)</span>
            </Label>
          </div>
          <div className="flex items-start gap-2">
            <Checkbox
              id="delete-bind"
              checked={bindData}
              onCheckedChange={(checked) => setBindData(checked === true)}
            />
            <Label htmlFor="delete-bind" className="font-normal">
              Also delete host-browsable data{" "}
              <span className="text-xs text-muted-foreground">
                (bind mounts under the data folder)
              </span>
            </Label>
          </div>
        </div>
        <AlertDialogFooter>
          <Button variant="outline" size="sm" onClick={cancelDelete}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={confirm}>
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
