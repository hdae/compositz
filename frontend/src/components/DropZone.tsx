import { useEffect, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { hasTauriBackend } from "@/ipc/client";
import { useInstancesStore } from "@/store/instances";

/**
 * Whole-window drop target for importing a recipe bundle. Under real Tauri the webview
 * intercepts native drag-drop and delivers file PATHS via `onDragDropEvent`; under plain
 * `vp dev` the browser can't expose a path, so a synthetic one is handed to the dev mock.
 * A drop routes through the same import→trust flow as the file picker.
 */
export const DropZone = () => {
  const [dragging, setDragging] = useState(false);
  const importFromPath = useInstancesStore((s) => s.importFromPath);

  useEffect(() => {
    if (hasTauriBackend()) {
      let cancelled = false;
      let unlisten: (() => void) | undefined;
      void getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          if (p.type === "enter" || p.type === "over") setDragging(true);
          else if (p.type === "leave") setDragging(false);
          else if (p.type === "drop") {
            setDragging(false);
            const path = p.paths[0];
            if (path !== undefined) void importFromPath(path);
          }
        })
        .then((stop) => {
          if (cancelled) stop();
          else unlisten = stop;
        });
      return () => {
        cancelled = true;
        unlisten?.();
      };
    }

    // Browser dev: HTML drag-drop. `dragover` fires continuously; a short watchdog clears
    // the overlay once it stops (robust against ESC-cancel / leaving the window where a
    // balancing `dragleave` never fires).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hasFiles = (e: DragEvent) => (e.dataTransfer?.types ?? []).includes("Files");
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // allow drop
      setDragging(true);
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => setDragging(false), 160);
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (timer !== undefined) clearTimeout(timer);
      setDragging(false);
      void importFromPath("mock://dropped.tar");
    };
    window.addEventListener("dragover", onOver);
    window.addEventListener("drop", onDrop);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [importFromPath]);

  if (!dragging) return null;
  return (
    <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center bg-blue-600/10 backdrop-blur-sm">
      <div className="rounded-xl border-2 border-dashed border-blue-500 bg-background/90 px-10 py-8 text-lg font-medium text-blue-700 dark:border-blue-400 dark:text-blue-300">
        Drop recipe bundle to import (.tar / .tar.gz)
      </div>
    </div>
  );
};
