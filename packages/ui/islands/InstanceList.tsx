import { useEffect, useRef, useState } from "preact/hooks";
import {
  type ContainerStatus,
  type InstanceRow,
  type InstanceView,
  toInstanceRows,
  withOptimisticAction,
} from "../lib/dashboard.ts";
import { Button } from "../components/ui/button.tsx";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "../components/ui/alert-dialog.tsx";

// CLIENT island. It imports ONLY types + pure helpers from lib/dashboard.ts and the
// presentational components — never `@compositz/core` (that would pull node:net into
// the browser bundle and fail the build). Engine I/O happens server-side; this talks
// to it over SSE (/api/events) and fetch POST (/api/instances/:id/:action, import).

type Initial = {
  containers: ContainerStatus[];
  installedTags: string[];
  engineOnline: boolean;
  engineError: string | null;
};

export default function InstanceList(
  { views, initial }: { views: InstanceView[]; initial: Initial },
) {
  const [containers, setContainers] = useState<ContainerStatus[]>(initial.containers);
  const [installedTags, setInstalledTags] = useState<string[]>(initial.installedTags);
  const [engineOnline, setEngineOnline] = useState<boolean>(initial.engineOnline);
  const [engineError, setEngineError] = useState<string | null>(initial.engineError);
  const [pending, setPending] = useState<Record<string, boolean>>({}); // up/down in flight
  const [installing, setInstalling] = useState<Record<string, boolean>>({});
  const [logs, setLogs] = useState<Record<string, string[]>>({}); // install build log per instance
  const [actionError, setActionError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [deleting, setDeleting] = useState<InstanceRow | null>(null); // delete-confirm target
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const es = new EventSource("/api/events");
    es.addEventListener("snapshot", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { containers: ContainerStatus[] };
      setContainers(data.containers);
      setEngineOnline(true);
      setEngineError(null);
    });
    es.addEventListener("offline", (ev) => {
      const data = JSON.parse((ev as MessageEvent).data) as { error: string };
      setEngineOnline(false);
      setEngineError(data.error);
    });
    return () => es.close();
  }, []);

  // Whole-window dropzone: show the overlay while a file is dragged over the page.
  // Driven by `dragover` (which fires continuously during a drag) plus a short
  // watchdog that clears the overlay once dragover stops — robust against the abort
  // paths (ESC-cancel, leaving the window) where a balancing `dragleave` never fires
  // and a depth counter would get stuck.
  useEffect(() => {
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
      const file = e.dataTransfer?.files?.[0];
      if (file) importFile(file);
    };
    globalThis.addEventListener("dragover", onOver);
    globalThis.addEventListener("drop", onDrop);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      globalThis.removeEventListener("dragover", onOver);
      globalThis.removeEventListener("drop", onDrop);
    };
  }, []);

  const rows = toInstanceRows(views, engineOnline ? { containers, installedTags } : null);

  const appendLog = (id: string, line: string) =>
    setLogs((l) => ({ ...l, [id]: [...(l[id] ?? []), line] }));

  // Import a recipe bundle (drop or file-picker) → server streams it to the store →
  // reload to show the new instance (the list is server-rendered).
  async function importFile(file: File) {
    setImporting(true);
    setActionError(null);
    try {
      const res = await fetch("/api/instances/import", { method: "POST", body: file });
      const body = await res.json().catch(() => ({})) as { ok?: boolean; error?: string };
      if (res.ok && body.ok) location.reload();
      else setActionError(`import failed: ${body.error ?? `HTTP ${res.status}`}`);
    } catch (e) {
      setActionError(`import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
    }
  }

  async function act(id: string, action: "up" | "down") {
    setPending((p) => ({ ...p, [id]: true }));
    setActionError(null);
    try {
      const res = await fetch(`/api/instances/${id}/${action}`, { method: "POST" });
      if (res.ok) {
        setContainers((cs) => withOptimisticAction(cs, id, action));
      } else {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setActionError(`${action} ${id} failed: ${body.error ?? `HTTP ${res.status}`}`);
      }
    } catch (e) {
      setActionError(`${action} ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPending((p) => ({ ...p, [id]: false }));
    }
  }

  async function confirmDelete(id: string) {
    setDeleting(null);
    setActionError(null);
    try {
      const res = await fetch(`/api/instances/${id}/delete`, { method: "POST" });
      if (res.ok) location.reload();
      else {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setActionError(`delete ${id} failed: ${body.error ?? `HTTP ${res.status}`}`);
      }
    } catch (e) {
      setActionError(`delete ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function install(id: string) {
    setInstalling((s) => ({ ...s, [id]: true }));
    setLogs((l) => ({ ...l, [id]: [] }));
    try {
      const res = await fetch(`/api/instances/${id}/install`, { method: "POST" });
      if (!res.ok || !res.body) {
        appendLog(id, `ERROR: HTTP ${res.status}`);
        return;
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const raw of lines) {
          if (!raw.trim()) continue;
          const msg = JSON.parse(raw) as {
            type: string;
            line?: string;
            tag?: string;
            error?: string;
          };
          if (msg.type === "log" && msg.line) appendLog(id, msg.line);
          else if (msg.type === "done" && msg.tag) {
            setInstalledTags((t) => (t.includes(msg.tag!) ? t : [...t, msg.tag!]));
          } else if (msg.type === "error") appendLog(id, `\nERROR: ${msg.error}`);
        }
      }
    } catch (e) {
      appendLog(id, `\nERROR: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setInstalling((s) => ({ ...s, [id]: false }));
    }
  }

  return (
    <div>
      {/* menu / action bar */}
      <div class="flex items-center justify-between mb-3">
        <Button
          variant="outline"
          size="sm"
          disabled={importing}
          onClick={() => fileInput.current?.click()}
        >
          {importing ? "Importing…" : "Import recipe…"}
        </Button>
        <EngineBadge online={engineOnline} error={engineError} />
        <input
          ref={fileInput}
          type="file"
          accept=".tar,.gz,.tgz"
          class="hidden"
          onChange={(e) => {
            const file = (e.currentTarget as HTMLInputElement).files?.[0];
            if (file) importFile(file);
            (e.currentTarget as HTMLInputElement).value = "";
          }}
        />
      </div>

      {actionError
        ? <p class="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-700">{actionError}</p>
        : null}

      {rows.length === 0
        ? (
          <p class="mt-10 text-gray-500">
            No instances yet — drop a recipe bundle anywhere, or use Import.
          </p>
        )
        : (
          <ul class="divide-y divide-gray-200">
            {rows.map((r) => (
              <li key={r.instanceId} class="py-4">
                <div class="flex items-center gap-4">
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="font-semibold">{r.name}</span>
                      <span class="text-xs text-gray-400">{r.version}</span>
                      <span class="text-xs text-gray-300 font-mono truncate">{r.instanceId}</span>
                    </div>
                    <p class="text-sm text-gray-500 truncate">{r.description}</p>
                  </div>
                  <StatusPill installed={r.installed} running={r.running} />
                  {r.web && r.running
                    ? (
                      <a
                        href={r.web}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="text-sm text-blue-600 hover:underline whitespace-nowrap"
                      >
                        Open UI
                      </a>
                    )
                    : null}
                  <ActionButton
                    row={r}
                    busy={!!pending[r.instanceId] || !!installing[r.instanceId]}
                    disabled={!engineOnline}
                    onUp={() => act(r.instanceId, "up")}
                    onDown={() => act(r.instanceId, "down")}
                    onInstall={() => install(r.instanceId)}
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    class="text-red-600 hover:bg-red-50 hover:text-red-700"
                    onClick={() => setDeleting(r)}
                  >
                    Delete
                  </Button>
                </div>
                {logs[r.instanceId]?.length ? <InstallLog lines={logs[r.instanceId]} /> : null}
              </li>
            ))}
          </ul>
        )}

      {/* whole-window drop overlay */}
      {dragging
        ? (
          <div class="fixed inset-0 z-30 flex items-center justify-center bg-blue-600/10 backdrop-blur-sm pointer-events-none">
            <div class="rounded-xl border-2 border-dashed border-blue-500 bg-white/90 px-10 py-8 text-lg font-medium text-blue-700">
              Drop recipe bundle to import (.tar / .tar.gz)
            </div>
          </div>
        )
        : null}

      {/* delete confirmation */}
      <AlertDialog
        open={deleting !== null}
        onOpenChange={(open: boolean) => {
          if (!open) setDeleting(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>Delete this instance?</AlertDialogTitle>
          <AlertDialogDescription>
            <span class="font-mono">{deleting?.instanceId}</span>{" "}
            — the container and its definition are removed. Persisted data (named volumes) is kept.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" size="sm">Cancel</Button>} />
            <Button
              variant="destructive"
              size="sm"
              onClick={() => deleting && confirmDelete(deleting.instanceId)}
            >
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function EngineBadge({ online, error }: { online: boolean; error: string | null }) {
  if (online) return <span class="text-sm text-green-600">● engine online</span>;
  return <span class="text-sm text-amber-600" title={error ?? undefined}>● engine offline</span>;
}

function StatusPill({ installed, running }: { installed: boolean | null; running: boolean }) {
  if (running) return <Pill tone="green">running</Pill>;
  if (installed === null) return <Pill tone="gray">unknown</Pill>;
  if (installed) return <Pill tone="blue">installed</Pill>;
  return <Pill tone="gray">not installed</Pill>;
}

function Pill({ tone, children }: { tone: "green" | "blue" | "gray"; children: string }) {
  const tones = {
    green: "bg-green-100 text-green-800",
    blue: "bg-blue-100 text-blue-800",
    gray: "bg-gray-100 text-gray-600",
  };
  return (
    <span class={`rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>
  );
}

function ActionButton(
  { row, busy, disabled, onUp, onDown, onInstall }: {
    row: InstanceRow;
    busy: boolean;
    disabled: boolean;
    onUp: () => void;
    onDown: () => void;
    onInstall: () => void;
  },
) {
  if (busy) return <Button size="sm" variant="secondary" disabled class="w-20">…</Button>;
  if (row.running) {
    return (
      <Button size="sm" variant="destructive" class="w-20" disabled={disabled} onClick={onDown}>
        Stop
      </Button>
    );
  }
  if (row.installed === false) {
    return <Button size="sm" class="w-20" disabled={disabled} onClick={onInstall}>Install</Button>;
  }
  return <Button size="sm" class="w-20" disabled={disabled} onClick={onUp}>Start</Button>;
}

function InstallLog({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);
  return (
    <pre
      ref={ref}
      class="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-gray-900 p-3 text-xs text-gray-100"
    >{lines.join("")}</pre>
  );
}
