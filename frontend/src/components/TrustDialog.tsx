import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useInstancesStore } from "@/store/instances";

/**
 * The trust gate: a freshly-imported recipe is built only after an explicit choice.
 * Non-dismissable (`onOpenChange` ignored, so Esc / backdrop don't close it) — the
 * decision must be deliberate. "Trust & install" reveals the row and builds it; "Don't
 * install" removes the just-imported instance entirely (nothing was built).
 */
export const TrustDialog = () => {
  const trust = useInstancesStore((s) => s.trust);
  const trustInstall = useInstancesStore((s) => s.trustInstall);
  const trustReject = useInstancesStore((s) => s.trustReject);

  return (
    <AlertDialog open={trust !== undefined} onOpenChange={() => {}}>
      <AlertDialogContent>
        <AlertDialogTitle>Trust the source and install?</AlertDialogTitle>
        <AlertDialogDescription>
          {trust && (
            <>
              <span className="font-semibold text-foreground">{trust.view.name}</span>{" "}
              <span className="text-xs">v{trust.view.version}</span> ({trust.view.appId}) will be
              installed. Source: <span className="font-mono">{trust.source}</span>. Only install
              recipes you trust — the image is built or pulled from the source.
            </>
          )}
        </AlertDialogDescription>
        {trust && trust.bumps.length > 0 && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            A host port was already in use, so it was reassigned:{" "}
            {trust.bumps.map((b) => `${b.name} ${b.from}→${b.to}`).join(", ")}. You can change it in
            Settings.
          </p>
        )}
        <AlertDialogFooter>
          <Button variant="outline" size="sm" onClick={() => void trustReject()}>
            Don&apos;t install
          </Button>
          <Button size="sm" onClick={() => void trustInstall()}>
            Trust &amp; install
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
