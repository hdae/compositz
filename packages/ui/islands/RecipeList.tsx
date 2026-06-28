import { useEffect, useRef, useState } from "preact/hooks";
import {
  type ContainerStatus,
  type RecipeRow,
  type RecipeView,
  toRecipeRows,
  withOptimisticAction,
} from "../lib/dashboard.ts";

// CLIENT island. It imports ONLY types + pure helpers from lib/dashboard.ts —
// never `@compositz/core` (that would pull node:net into the browser bundle and
// fail the build). Engine I/O happens server-side; this talks to it over SSE
// (/api/events) and fetch POST (/api/recipes/:id/:action).

type Initial = {
  containers: ContainerStatus[];
  installedTags: string[];
  engineOnline: boolean;
  engineError: string | null;
};

export default function RecipeList({ views, initial }: { views: RecipeView[]; initial: Initial }) {
  const [containers, setContainers] = useState<ContainerStatus[]>(initial.containers);
  const [installedTags, setInstalledTags] = useState<string[]>(initial.installedTags);
  const [engineOnline, setEngineOnline] = useState<boolean>(initial.engineOnline);
  const [engineError, setEngineError] = useState<string | null>(initial.engineError);
  const [pending, setPending] = useState<Record<string, boolean>>({}); // up/down in flight
  const [installing, setInstalling] = useState<Record<string, boolean>>({});
  const [logs, setLogs] = useState<Record<string, string[]>>({}); // install build log per recipe

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
    // On a transport error the browser auto-reconnects; keep the last state.
    return () => es.close();
  }, []);

  const rows = toRecipeRows(views, engineOnline ? { containers, installedTags } : null);

  const appendLog = (id: string, line: string) =>
    setLogs((l) => ({ ...l, [id]: [...(l[id] ?? []), line] }));

  async function act(id: string, action: "up" | "down") {
    setPending((p) => ({ ...p, [id]: true }));
    try {
      const res = await fetch(`/api/recipes/${id}/${action}`, { method: "POST" });
      if (res.ok) {
        // The POST resolves only once the op is complete server-side, but the
        // SSE-driven `containers` lags up to one poll. Fold the result in now so
        // the label flips straight from "…" to the new state (no flicker back).
        setContainers((cs) => withOptimisticAction(cs, id, action));
      } else {
        const body = await res.json().catch(() => ({})) as { error?: string };
        console.error(`${action} ${id} failed:`, body.error ?? res.status);
      }
    } finally {
      setPending((p) => ({ ...p, [id]: false }));
    }
  }

  async function install(id: string) {
    setInstalling((s) => ({ ...s, [id]: true }));
    setLogs((l) => ({ ...l, [id]: [] }));
    try {
      const res = await fetch(`/api/recipes/${id}/install`, { method: "POST" });
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
        buf = lines.pop() ?? ""; // keep the trailing partial line for the next chunk
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
      <div class="flex justify-end mb-2">
        <EngineBadge online={engineOnline} error={engineError} />
      </div>
      {rows.length === 0
        ? <p class="mt-10 text-gray-500">No recipes found.</p>
        : (
          <ul class="divide-y divide-gray-200">
            {rows.map((r) => (
              <li key={r.id} class="py-4">
                <div class="flex items-center gap-4">
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="font-semibold">{r.name}</span>
                      <span class="text-xs text-gray-400">{r.version}</span>
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
                    busy={!!pending[r.id] || !!installing[r.id]}
                    disabled={!engineOnline}
                    onUp={() => act(r.id, "up")}
                    onDown={() => act(r.id, "down")}
                    onInstall={() => install(r.id)}
                  />
                </div>
                {logs[r.id]?.length ? <InstallLog lines={logs[r.id]} /> : null}
              </li>
            ))}
          </ul>
        )}
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
    row: RecipeRow;
    busy: boolean;
    disabled: boolean;
    onUp: () => void;
    onDown: () => void;
    onInstall: () => void;
  },
) {
  if (busy) return <Btn tone="gray" disabled>…</Btn>;
  if (row.running) return <Btn tone="red" disabled={disabled} onClick={onDown}>Stop</Btn>;
  if (row.installed === false) {
    return <Btn tone="blue" disabled={disabled} onClick={onInstall}>Install</Btn>;
  }
  return <Btn tone="green" disabled={disabled} onClick={onUp}>Start</Btn>;
}

function Btn(
  { tone, disabled, onClick, children }: {
    tone: "green" | "red" | "blue" | "gray";
    disabled?: boolean;
    onClick?: () => void;
    children: string;
  },
) {
  const tones = {
    green: "bg-green-50 text-green-700 hover:bg-green-100",
    red: "bg-red-50 text-red-700 hover:bg-red-100",
    blue: "bg-blue-50 text-blue-700 hover:bg-blue-100",
    gray: "bg-gray-50 text-gray-500",
  };
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      class={`w-16 rounded-md px-3 py-1 text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed ${
        tones[tone]
      }`}
    >
      {children}
    </button>
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
      class="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-gray-900 p-3 text-xs text-gray-100"
    >{lines.join("")}</pre>
  );
}
