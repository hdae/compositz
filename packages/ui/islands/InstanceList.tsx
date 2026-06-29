import { useEffect, useRef, useState } from "preact/hooks";
import type { VNode } from "preact";
import {
  ChevronDown,
  Download,
  ExternalLink,
  Globe,
  Hammer,
  LoaderCircle,
  Play,
  ScrollText,
  Square,
  Trash2,
  Upload,
} from "../lib/icons.ts";
import {
  type ContainerStatus,
  type InstanceRow,
  type InstanceView,
  type Service,
  toInstanceRows,
  withOptimisticAction,
} from "../lib/dashboard.ts";
import { Button, buttonVariants } from "../components/ui/button.tsx";
import { Card } from "../components/ui/card.tsx";
import { cn } from "../lib/utils.ts";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../components/ui/tooltip.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.tsx";
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
// to it over SSE (/api/events, /api/instances/:id/logs) and fetch POST
// (/api/instances/:id/:action, import).

type Initial = {
  containers: ContainerStatus[];
  installedTags: string[];
  engineOnline: boolean;
  engineError: string | null;
};

type TabKey = "build" | "logs" | "services";

/** A freshly-imported instance awaiting the trust ("install?") decision. */
type TrustPrompt = { view: InstanceView; source: string };

export default function InstanceList(
  { views: initialViews, initial }: { views: InstanceView[]; initial: Initial },
) {
  // `views` is stateful so an import can add a row and a delete can drop one without a
  // full page reload (the list is otherwise server-rendered).
  const [views, setViews] = useState<InstanceView[]>(initialViews);
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
  const [trust, setTrust] = useState<TrustPrompt | null>(null); // import → trust gate
  const [expanded, setExpanded] = useState<Record<string, boolean>>({}); // detail panel open
  const [tabByInstance, setTabByInstance] = useState<Record<string, TabKey>>({});
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

  // Import a recipe bundle (drop or file-picker) → server ingests it to the store and
  // returns the new view + source → open the trust gate (the instance exists on disk
  // but isn't shown until the user chooses to install it).
  async function importFile(file: File) {
    setImporting(true);
    setActionError(null);
    try {
      const res = await fetch(`/api/instances/import?filename=${encodeURIComponent(file.name)}`, {
        method: "POST",
        body: file,
      });
      const body = await res.json().catch(() => ({})) as {
        ok?: boolean;
        view?: InstanceView;
        source?: string;
        error?: string;
      };
      if (res.ok && body.ok && body.view) {
        setTrust({ view: body.view, source: body.source ?? "upload" });
      } else {
        setActionError(`import failed: ${body.error ?? `HTTP ${res.status}`}`);
      }
    } catch (e) {
      setActionError(`import failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setImporting(false);
    }
  }

  // Open a native file picker. Prefer the File System Access API so a single combined
  // filter ("Recipe bundle" = .tar/.tar.gz/.tgz) is the default — the plain <input
  // accept> splits into per-extension filters and defaults to ".tar" on Windows. Falls
  // back to the hidden <input> where the API is unavailable.
  async function pickFile() {
    const picker = (globalThis as unknown as {
      showOpenFilePicker?: (opts: unknown) => Promise<Array<{ getFile: () => Promise<File> }>>;
    }).showOpenFilePicker;
    if (!picker) {
      fileInput.current?.click();
      return;
    }
    try {
      const [handle] = await picker({
        types: [{
          description: "Recipe bundle (.tar, .tar.gz, .tgz)",
          accept: { "application/octet-stream": [".tar", ".tar.gz", ".tgz"] },
        }],
        excludeAcceptAllOption: false,
        multiple: false,
      });
      if (handle) importFile(await handle.getFile());
    } catch (e) {
      // AbortError = the user cancelled; any other error → fall back to the input.
      if ((e as Error)?.name !== "AbortError") fileInput.current?.click();
    }
  }

  // Trust = Yes: add the row and build it now (the build log streams into its panel).
  function trustInstall(view: InstanceView) {
    setTrust(null);
    setViews((vs) => vs.some((v) => v.instanceId === view.instanceId) ? vs : [...vs, view]);
    install(view.instanceId);
  }

  // Trust = No: the just-imported instance is removed entirely (nothing was built).
  async function trustReject(id: string) {
    setTrust(null);
    await removeInstance(id);
  }

  /** Delete an instance server-side (container + per-instance image + dir) and drop its row. */
  async function removeInstance(id: string) {
    setActionError(null);
    try {
      const res = await fetch(`/api/instances/${id}/delete`, { method: "POST" });
      if (res.ok) {
        setViews((vs) => vs.filter((v) => v.instanceId !== id));
        // Drop this instance's per-id UI state so the maps don't accumulate stale keys.
        setLogs((m) => omit(m, id));
        setExpanded((m) => omit(m, id));
        setTabByInstance((m) => omit(m, id));
        setInstalling((m) => omit(m, id));
        setPending((m) => omit(m, id));
      } else {
        const body = await res.json().catch(() => ({})) as { error?: string };
        setActionError(`delete ${id} failed: ${body.error ?? `HTTP ${res.status}`}`);
      }
    } catch (e) {
      setActionError(`delete ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
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

  // Build the instance image, streaming the build log into the (auto-opened) Build tab.
  // On failure the row is KEPT with the build log + an Install (retry) button (Q2).
  async function install(id: string) {
    setExpanded((e) => ({ ...e, [id]: true }));
    setTabByInstance((t) => ({ ...t, [id]: "build" }));
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

  const toggleExpand = (id: string) => setExpanded((e) => ({ ...e, [id]: !e[id] }));

  return (
    <TooltipProvider delay={300}>
      <div>
        {/* menu / action bar */}
        <div class="flex items-center justify-between mb-3">
          <Button
            variant="outline"
            size="sm"
            disabled={importing}
            onClick={pickFile}
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
              {rows.map((r) => {
                const buildLines = logs[r.instanceId] ?? [];
                const isInstalling = !!installing[r.instanceId];
                const activeTab: TabKey = tabByInstance[r.instanceId] ??
                  defaultTabFor(r, isInstalling, buildLines.length > 0);
                return (
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
                        <ActionButton
                          row={r}
                          busy={!!pending[r.instanceId] || isInstalling}
                          busyLabel={isInstalling
                            ? "Installing…"
                            : r.running
                            ? "Stopping…"
                            : "Starting…"}
                          disabled={!engineOnline}
                          onUp={() => act(r.instanceId, "up")}
                          onDown={() => act(r.instanceId, "down")}
                          onInstall={() => install(r.instanceId)}
                        />
                        <Tip label="Delete">
                          <Button
                            variant="ghost"
                            size="icon"
                            class="text-destructive hover:bg-destructive/10 hover:text-destructive"
                            onClick={() => setDeleting(r)}
                            aria-label="Delete"
                          >
                            <Trash2 class="size-4" />
                          </Button>
                        </Tip>
                        <Tip label={expanded[r.instanceId] ? "Hide details" : "Details"}>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => toggleExpand(r.instanceId)}
                            aria-label="Details"
                            aria-expanded={!!expanded[r.instanceId]}
                          >
                            <ChevronDown
                              class={cn(
                                "size-4 transition-transform",
                                expanded[r.instanceId] && "rotate-180",
                              )}
                            />
                          </Button>
                        </Tip>
                      </div>
                      {expanded[r.instanceId]
                        ? (
                          <DetailPanel
                            instanceId={r.instanceId}
                            running={r.running}
                            buildLines={buildLines}
                            installing={isInstalling}
                            services={r.services}
                            activeTab={activeTab}
                            onTab={(t) => setTabByInstance((m) => ({ ...m, [r.instanceId]: t }))}
                          />
                        )
                        : null}
                    </Card>
                  </li>
                );
              })}
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
              — the container and its image are removed. Persisted data (named volumes) is kept.
            </AlertDialogDescription>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" size="sm">Cancel</Button>} />
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  if (deleting) {
                    removeInstance(deleting.instanceId);
                    setDeleting(null);
                  }
                }}
              >
                Delete
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {
          /* trust gate: a freshly-imported recipe is built only after an explicit choice.
            Non-dismissable (onOpenChange ignored) so the decision is deliberate. */
        }
        <AlertDialog open={trust !== null} onOpenChange={() => {}}>
          <AlertDialogContent>
            <AlertDialogTitle>Trust the source and install?</AlertDialogTitle>
            <AlertDialogDescription>
              <span class="font-semibold">{trust?.view.name}</span>{" "}
              <span class="text-xs">{trust?.view.version}</span>{" "}
              ({trust?.view.appId}) will be installed. Source:{" "}
              <span class="font-mono">{trust?.source}</span>. Only install recipes you trust — the
              image is built or pulled from the source.
            </AlertDialogDescription>
            <AlertDialogFooter>
              <Button
                variant="outline"
                size="sm"
                onClick={() => trust && trustReject(trust.view.instanceId)}
              >
                Don't install
              </Button>
              <Button size="sm" onClick={() => trust && trustInstall(trust.view)}>
                Trust & install
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
}

/**
 * Wrap an icon-only control in a tooltip. The trigger is a `<span>` wrapping the control
 * (not the control itself) so the tooltip still appears while the control is disabled —
 * a native disabled `<button>` dispatches no hover events, and the busy/offline labels
 * ("Installing…", etc.) are exactly when the tooltip is most useful.
 */
function Tip({ label, children }: { label: string; children: VNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span class="inline-flex">{children}</span>} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Return a copy of `map` without `key` (identity-stable when the key is absent). */
function omit<T>(map: Record<string, T>, key: string): Record<string, T> {
  if (!(key in map)) return map;
  const { [key]: _drop, ...rest } = map;
  return rest;
}

function defaultTabFor(row: InstanceRow, installing: boolean, hasBuild: boolean): TabKey {
  if (installing) return "build";
  if (row.running) return "services";
  if (hasBuild) return "build";
  return "logs";
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
      <Tip label={busyLabel}>
        <Button size="icon" variant="ghost" disabled aria-label={busyLabel}>
          <LoaderCircle class="size-4 animate-spin" />
        </Button>
      </Tip>
    );
  }
  if (row.running) {
    return (
      <Tip label="Stop">
        <Button size="icon" variant="ghost" disabled={disabled} onClick={onDown} aria-label="Stop">
          <Square class="size-4" />
        </Button>
      </Tip>
    );
  }
  if (row.installed === false) {
    return (
      <Tip label="Install">
        <Button
          size="icon"
          variant="ghost"
          disabled={disabled}
          onClick={onInstall}
          aria-label="Install"
        >
          <Download class="size-4" />
        </Button>
      </Tip>
    );
  }
  return (
    <Tip label="Start">
      <Button size="icon" variant="ghost" disabled={disabled} onClick={onUp} aria-label="Start">
        <Play class="size-4" />
      </Button>
    </Tip>
  );
}

function DetailPanel(
  { instanceId, running, buildLines, installing, services, activeTab, onTab }: {
    instanceId: string;
    running: boolean;
    buildLines: string[];
    installing: boolean;
    services: Service[];
    activeTab: TabKey;
    onTab: (t: TabKey) => void;
  },
) {
  const buildAvailable = buildLines.length > 0 || installing;
  // Clamp to an available tab (the build tab can disappear when its log is cleared).
  const effective: TabKey = activeTab === "build" && !buildAvailable
    ? (running ? "services" : "logs")
    : activeTab;
  return (
    <div class="mt-3 border-t border-border pt-3">
      <Tabs
        value={effective}
        onValueChange={(v: unknown) => {
          if (v === "build" || v === "logs" || v === "services") onTab(v);
        }}
      >
        <TabsList>
          {buildAvailable
            ? (
              <TabsTrigger value="build">
                <Hammer class="size-3.5" />Build log
              </TabsTrigger>
            )
            : null}
          <TabsTrigger value="logs">
            <ScrollText class="size-3.5" />Runtime log
          </TabsTrigger>
          <TabsTrigger value="services">
            <Globe class="size-3.5" />Services
          </TabsTrigger>
        </TabsList>
        {buildAvailable
          ? (
            <TabsContent value="build">
              <BuildLog lines={buildLines} installing={installing} />
            </TabsContent>
          )
          : null}
        <TabsContent value="logs">
          <RuntimeLog instanceId={instanceId} running={running} />
        </TabsContent>
        <TabsContent value="services">
          <ServicesList services={services} running={running} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

const LOG_PANEL_CLASS =
  "max-h-64 overflow-auto whitespace-pre-wrap rounded bg-gray-900 p-3 text-xs text-gray-100";

function BuildLog({ lines, installing }: { lines: string[]; installing: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);
  if (!lines.length && !installing) {
    return <p class="text-sm text-muted-foreground">No build log yet.</p>;
  }
  return <pre ref={ref} class={LOG_PANEL_CLASS}>{lines.join("")}</pre>;
}

// Streams the running container's stdout/stderr over SSE while mounted. Base UI unmounts
// an inactive tab panel, so opening the tab opens the stream and leaving it closes it.
function RuntimeLog({ instanceId, running }: { instanceId: string; running: boolean }) {
  const [lines, setLines] = useState<string[]>([]);
  const ref = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (!running) return;
    setLines([]);
    const es = new EventSource(`/api/instances/${instanceId}/logs`);
    es.addEventListener("log", (ev) => {
      const { line } = JSON.parse((ev as MessageEvent).data) as { stream: string; line: string };
      setLines((l) => [...l, line]);
    });
    es.addEventListener("logerror", (ev) => {
      const { error } = JSON.parse((ev as MessageEvent).data) as { error: string };
      setLines((l) => [...l, `\n[log error: ${error}]`]);
      es.close();
    });
    es.addEventListener("end", () => es.close());
    return () => es.close();
  }, [instanceId, running]);

  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines]);

  if (!running) return <p class="text-sm text-muted-foreground">Not running.</p>;
  return <pre ref={ref} class={LOG_PANEL_CLASS}>{lines.join("")}</pre>;
}

function ServicesList({ services, running }: { services: Service[]; running: boolean }) {
  if (!running) return <p class="text-sm text-muted-foreground">Not running.</p>;
  if (!services.length) {
    return <p class="text-sm text-muted-foreground">No web UI ports declared.</p>;
  }
  // Listed straight from the manifest; the badge reflects whether the port is published
  // yet (the live host binding has appeared in `ps`) — `ready` once reachable, otherwise
  // `starting…` so the row doesn't blink in/out during container startup.
  return (
    <ul class="space-y-2">
      {services.map((s) => {
        const ready = s.url !== undefined;
        return (
          <li
            key={s.name}
            class="flex items-center justify-between gap-3 rounded border border-border px-3 py-2"
          >
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <span class="text-sm font-medium">{s.name}</span>
                <span class="text-xs text-muted-foreground font-mono">
                  {ready ? `:${s.port}` : `:${s.path}`}
                </span>
                {ready
                  ? (
                    <span class="rounded-full bg-green-100 px-2 py-0.5 text-[10px] font-medium text-green-800 dark:bg-green-500/15 dark:text-green-400">
                      ready
                    </span>
                  )
                  : (
                    <span class="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800 dark:bg-amber-500/15 dark:text-amber-400">
                      starting…
                    </span>
                  )}
              </div>
              {s.description
                ? <p class="text-xs text-muted-foreground truncate">{s.description}</p>
                : null}
            </div>
            {ready
              ? (
                <a
                  href={s.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class={cn(buttonVariants({ variant: "outline", size: "sm" }), "shrink-0")}
                >
                  <ExternalLink class="size-4" />Open
                </a>
              )
              : (
                <Button variant="outline" size="sm" disabled class="shrink-0">
                  <ExternalLink class="size-4" />Open
                </Button>
              )}
          </li>
        );
      })}
    </ul>
  );
}
