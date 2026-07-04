import { Download, Loader2 } from "lucide-react";
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
 * Import from GitHub: enter a public-repo spec → the backend downloads + ingests the
 * codeload tarball → the trust gate opens (server-confirmed, same as a file import).
 * Dismissable, but not while a fetch is in flight; on failure it stays open with the
 * error so the spec can be corrected and retried.
 */
export const GithubImportDialog = () => {
  const github = useInstancesStore((s) => s.github);
  const setGithubSpec = useInstancesStore((s) => s.setGithubSpec);
  const closeGithub = useInstancesStore((s) => s.closeGithub);
  const submitGithub = useInstancesStore((s) => s.submitGithub);

  const submitting = github?.submitting ?? false;
  const spec = github?.spec ?? "";

  return (
    <Dialog
      open={github !== undefined}
      onOpenChange={(open) => {
        if (!open) closeGithub();
      }}
    >
      <DialogContent showCloseButton={!submitting}>
        <DialogHeader>
          <DialogTitle>Import from GitHub</DialogTitle>
          <DialogDescription>
            Enter a public repo as <span className="font-mono">owner/repo[/subdir][@ref]</span>. The
            default branch is used when <span className="font-mono">@ref</span> is omitted.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submitGithub();
          }}
        >
          <Input
            autoFocus
            value={spec}
            disabled={submitting}
            placeholder="comfyanonymous/ComfyUI"
            aria-label="GitHub repository spec"
            className="font-mono"
            onChange={(e) => setGithubSpec(e.target.value)}
          />
          {github?.error && <p className="text-sm text-destructive">{github.error}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={submitting}
              onClick={closeGithub}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={submitting || spec.trim() === ""}>
              {submitting ? (
                <>
                  <Loader2 className="animate-spin" />
                  Fetching…
                </>
              ) : (
                <>
                  <Download />
                  Import
                </>
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
