import { GitBranch, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useInstancesStore } from "@/store/instances";

/** The create-actions toolbar: import a recipe bundle from a file, or from GitHub. */
export const ImportBar = () => {
  const importing = useInstancesStore((s) => s.importing);
  const beginImportFile = useInstancesStore((s) => s.beginImportFile);
  const openGithub = useInstancesStore((s) => s.openGithub);

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        disabled={importing}
        onClick={() => void beginImportFile()}
      >
        {importing ? <Loader2 className="animate-spin" /> : <Upload />}
        {importing ? "Importing…" : "Import recipe"}
      </Button>
      <Button variant="outline" size="sm" disabled={importing} onClick={openGithub}>
        <GitBranch />
        From GitHub
      </Button>
    </div>
  );
};
