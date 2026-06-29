import { useEffect, useRef, useState } from "preact/hooks";
import {
  Download,
  ExternalLink,
  LoaderCircle,
  Play,
  Square,
  Trash2,
  Upload,
} from "../lib/icons.ts";
import {
  type ContainerStatus,
  type InstanceRow,
  type InstanceView,
  toInstanceRows,
  withOptimisticAction,
} from "../lib/dashboard.ts";
import { Button, buttonVariants } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
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
          {importing ? <LoaderCircle class="size-4 animate-spin" /> : <Upload class="size-4" />}
          {importing ? "Importing…" : "Import recipe"}
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
        ? (
          <p class="mb-3 rounded bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {actionError}
          </p>
        )
        : null}

      {rows.length === 0
        ? (
          <p class="mt-10 text-muted-foreground">
            No instances yet — drop a recipe bundle anywhere, or use Import.
          </p>
        )
        : (
          <ul class="space-y-3">
            {rows.map((r) => (
              <li key={r.instanceId}>
                <Card class="gap-3 p-4">
                  <div class="flex items-center gap-2">
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-2">
                        <span class="font-semibold">{r.name}</span>
                        <span class="text-xs text-muted-foreground">{r.version}</span>
                        <span class="text-xs text-muted-foreground/70 font-mono truncate">
                          {r.instanceId}
                        </span>
                      </div>
                      <p class="text-sm text-muted-foreground truncate">{r.description}</p>
                    </div>
                    <StatusPill installed={r.installed} running={r.running} />
                    {r.web && r.running
                      ? (
                        <a
                          href={r.web}
                          target="_blank"
                          rel="noopener noreferrer"
                          class={buttonVariants({ variant: "ghost", size: "icon" })}
                          aria-label="Open UI"
                          title="Open UI"
                        >
                          <ExternalLink class="size-4" />
                        </a>
                      )
                      : null}
                    <ActionButton
                      row={r}
                      busy={!!pending[r.instanceId] || !!installing[r.instanceId]}
                      busyLabel={installing[r.instanceId]
                        ? "Installing…"
                        : r.running
                        ? "Stopping…"
                        : "Starting…"}
                      disabled={!engineOnline}
                      onUp={() => act(r.instanceId, "up")}
                      onDown={() => act(r.instanceId, "down")}
                      onInstall={() => install(r.instanceId)}
                    />
                    <Button
                      variant="ghost"
                      size="icon"
                      class="text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setDeleting(r)}
                      aria-label="Delete"
                      title="Delete"
                    >
                      <Trash2 class="size-4" />
                    </Button>
                  </div>
                  {logs[r.instanceId]?.length ? <InstallLog lines={logs[r.instanceId]} /> : null}
                </Card>
              </li>
            ))}
          </ul>
        )}

      {/* whole-window drop overlay */}
      {dragging
        ? (
          <div class="fixed inset-0 z-30 flex items-center justify-center bg-blue-600/10 backdrop-blur-sm pointer-events-none">
            <div class="rounded-xl border-2 border-dashed border-blue-500 bg-background/90 px-10 py-8 text-lg font-medium text-blue-700 dark:border-blue-400 dark:text-blue-300">
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
  if (online) {
    return <span class="text-sm text-green-600 dark:text-green-400">● engine online</span>;
  }
  return (
    <span class="text-sm text-amber-600 dark:text-amber-400" title={error ?? undefined}>
      ● engine offline
    </span>
  );
}

function StatusPill({ installed, running }: { installed: boolean | null; running: boolean }) {
  if (running) return <Pill tone="green">running</Pill>;
  if (installed === null) return <Pill tone="gray">unknown</Pill>;
  if (installed) return <Pill tone="blue">installed</Pill>;
  return <Pill tone="gray">not installed</Pill>;
}

function Pill({ tone, children }: { tone: "green" | "blue" | "gray"; children: string }) {
  const tones = {
    green: "bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-400",
    blue: "bg-blue-100 text-blue-800 dark:bg-blue-500/15 dark:text-blue-400",
    gray: "bg-muted text-muted-foreground",
  };
  return (
    <span class={`rounded-full px-2.5 py-0.5 text-xs font-medium ${tones[tone]}`}>{children}</span>
  );
}

function ActionButton(
  { row, busy, busyLabel, disabled, onUp, onDown, onInstall }: {
    row: InstanceRow;
    busy: boolean;
    busyLabel: string;
    disabled: boolean;
    onUp: () => void;
    onDown: () => void;
    onInstall: () => void;
  },
) {
  if (busy) {
    return (
      <Button size="icon" variant="ghost" disabled aria-label={busyLabel} title={busyLabel}>
        <LoaderCircle class="size-4 animate-spin" />
      </Button>
    );
  }
  if (row.running) {
    return (
      <Button
        size="icon"
        variant="ghost"
        disabled={disabled}
        onClick={onDown}
        aria-label="Stop"
        title="Stop"
      >
        <Square class="size-4" />
      </Button>
    );
  }
  if (row.installed === false) {
    return (
      <Button
        size="icon"
        variant="ghost"
        disabled={disabled}
        onClick={onInstall}
        aria-label="Install"
        title="Install"
      >
        <Download class="size-4" />
      </Button>
    );
  }
  return (
    <Button
      size="icon"
      variant="ghost"
      disabled={disabled}
      onClick={onUp}
      aria-label="Start"
      title="Start"
    >
      <Play class="size-4" />
    </Button>
  );
}

function InstallLog({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);
  return (
    <pre
      ref={ref}
      class="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-gray-900 p-3 text-xs text-gray-100"
    >{lines.join("")}</pre>
  );
}
