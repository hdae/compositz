import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { getConfig, setConfig } from "@/ipc/client";
import type { InstanceSettings, Override, Placement } from "@/ipc/client";

type Props = {
  instanceId: string;
  running: boolean;
  onRestart: () => Promise<void>;
};

const SELECT_CLASS =
  "h-8 rounded-lg border border-input bg-background px-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

/**
 * The per-instance launch-override editor (RI-4). Mounts fresh when the Settings tab
 * opens (Base UI unmounts inactive panels): loads the manifest ⊕ override view-model,
 * edits locally, then Save persists only the values that DIFFER from the manifest
 * defaults. The override applies on the next start — server-confirmed, no optimism.
 */
export const SettingsPanel = ({ instanceId, running, onRestart }: Props) => {
  const [settings, setSettings] = useState<InstanceSettings | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [ports, setPorts] = useState<Record<string, string>>({});
  const [env, setEnv] = useState<Record<string, string>>({});
  const [placement, setPlacement] = useState<Record<string, Placement>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [restarting, setRestarting] = useState(false);
  // Set from the server (load on open, save on PUT) so the Restart prompt shows ONLY
  // when a restart would actually apply a change.
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [saveError, setSaveError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    setSettings(undefined);
    setLoadError(undefined);
    setSaved(false);
    getConfig(instanceId)
      .then((s) => {
        if (!alive) return;
        setSettings(s);
        setRestartNeeded(s.restartNeeded);
        setPorts(
          Object.fromEntries(s.ports.map((p) => [p.name, String(p.override ?? p.manifestHost)])),
        );
        setEnv(Object.fromEntries(s.env.map((e) => [e.name, e.override ?? e.default ?? ""])));
        setPlacement(
          Object.fromEntries(s.mounts.map((m) => [m.name, m.override ?? m.manifestPlacement])),
        );
      })
      .catch((e) => {
        if (alive) setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [instanceId]);

  // Any edit invalidates a prior "Saved" confirmation.
  const editPort = (name: string, value: string) => {
    setPorts((s) => ({ ...s, [name]: value }));
    setSaved(false);
  };
  const editEnv = (name: string, value: string) => {
    setEnv((s) => ({ ...s, [name]: value }));
    setSaved(false);
  };
  const editPlace = (name: string, value: Placement) => {
    setPlacement((s) => ({ ...s, [name]: value }));
    setSaved(false);
  };

  const doRestart = async () => {
    setRestarting(true);
    try {
      await onRestart();
      setSaved(false);
      setRestartNeeded(false);
    } finally {
      setRestarting(false);
    }
  };

  if (loadError !== undefined) {
    return <p className="text-sm text-destructive">Failed to load settings: {loadError}</p>;
  }
  if (settings === undefined) {
    return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  }
  if (settings.ports.length === 0 && settings.env.length === 0 && settings.mounts.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing to configure for this recipe.</p>;
  }

  const missingRequired = settings.env.some(
    (e) => e.required && (env[e.name]?.trim() ?? "") === "",
  );

  // Port conflict is DEFINITION-based (host ports of OTHER instances + this instance's
  // own other ports) and recomputes as the user types.
  const portValues = settings.ports.map((p) => ({ name: p.name, value: Number(ports[p.name]) }));
  const conflictsWith = (name: string, value: number): boolean => {
    if (!Number.isInteger(value)) return false;
    if (settings.takenByOthers.includes(value)) return true;
    return portValues.some((pv) => pv.name !== name && pv.value === value);
  };
  const freePortFrom = (from: number, name: string): number => {
    const used = new Set(settings.takenByOthers);
    for (const pv of portValues) {
      if (pv.name !== name && Number.isInteger(pv.value)) used.add(pv.value);
    }
    let n = Number.isInteger(from) && from >= 1 ? from : 1024;
    while (used.has(n) && n < 65535) n += 1;
    return n;
  };

  // The override = only values that DIFFER from the manifest defaults (a minimal config).
  const buildOverride = (): Override => {
    const hostPorts: Record<string, number> = {};
    for (const p of settings.ports) {
      const n = Number(ports[p.name]?.trim());
      if (Number.isInteger(n) && n !== p.manifestHost) hostPorts[p.name] = n;
    }
    const envOut: Record<string, string> = {};
    for (const e of settings.env) {
      const v = env[e.name] ?? "";
      if (v !== "" && v !== (e.default ?? "")) envOut[e.name] = v;
    }
    const placeOut: Record<string, Placement> = {};
    for (const m of settings.mounts) {
      const p = placement[m.name];
      if (p !== undefined && p !== m.manifestPlacement) placeOut[m.name] = p;
    }
    const over: Override = {};
    if (Object.keys(hostPorts).length > 0) over.hostPorts = hostPorts;
    if (Object.keys(envOut).length > 0) over.env = envOut;
    if (Object.keys(placeOut).length > 0) over.placement = placeOut;
    return over;
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setSaveError(undefined);
    try {
      const result = await setConfig(instanceId, buildOverride());
      setSaved(true);
      setRestartNeeded(result.restartNeeded);
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-5">
      {settings.ports.length > 0 && (
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Ports
          </h4>
          {settings.ports.map((p) => {
            const cur = Number(ports[p.name]);
            const conflict = conflictsWith(p.name, cur);
            return (
              <div key={p.name} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{p.name}</span>
                    {p.web && (
                      <span className="rounded-full bg-blue-500/15 px-2 py-0.5 text-[10px] font-medium text-blue-600 dark:text-blue-400">
                        web
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      container {p.container} · default {p.manifestHost}
                    </span>
                  </div>
                  {conflict && (
                    <button
                      type="button"
                      className="text-xs text-amber-600 hover:underline dark:text-amber-400"
                      onClick={() => editPort(p.name, String(freePortFrom(cur, p.name)))}
                    >
                      port {cur} already in use → use free port {freePortFrom(cur, p.name)}
                    </button>
                  )}
                </div>
                <Input
                  type="number"
                  min={1}
                  max={65535}
                  value={ports[p.name] ?? ""}
                  onChange={(e) => editPort(p.name, e.target.value)}
                  aria-label={`Host port for ${p.name}`}
                  className={cn(
                    "w-28 font-mono",
                    conflict && "border-amber-500 focus-visible:ring-amber-500",
                  )}
                />
              </div>
            );
          })}
        </section>
      )}

      {settings.env.length > 0 && (
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Environment
          </h4>
          {settings.env.map((e) => (
            <div key={e.name} className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm">{e.name}</span>
                {e.required && (
                  <span className="text-xs font-medium text-destructive">required</span>
                )}
              </div>
              {e.description !== undefined && e.description !== null && (
                <p className="text-xs text-muted-foreground">{e.description}</p>
              )}
              <Input
                type="text"
                value={env[e.name] ?? ""}
                placeholder={e.default ?? ""}
                onChange={(ev) => editEnv(e.name, ev.target.value)}
                aria-label={`Value for ${e.name}`}
              />
            </div>
          ))}
        </section>
      )}

      {settings.mounts.length > 0 && (
        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            Storage
          </h4>
          {settings.mounts.map((m) => (
            <div key={m.name} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{m.name}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {m.target}
                  </span>
                </div>
                {m.description !== undefined && m.description !== null && (
                  <p className="truncate text-xs text-muted-foreground">{m.description}</p>
                )}
              </div>
              <select
                value={placement[m.name] ?? m.manifestPlacement}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v === "bind" || v === "volume") editPlace(m.name, v);
                }}
                aria-label={`Placement for ${m.name}`}
                className={cn(SELECT_CLASS, "w-28")}
              >
                <option value="volume">volume</option>
                <option value="bind">bind</option>
              </select>
            </div>
          ))}
        </section>
      )}

      <div className="flex flex-wrap items-center gap-3 border-t border-border pt-3">
        <Button size="sm" disabled={saving || missingRequired} onClick={() => void save()}>
          {saving ? (
            <>
              <Loader2 className="animate-spin" />
              Saving…
            </>
          ) : (
            "Save"
          )}
        </Button>
        {missingRequired && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            Set required values to save.
          </span>
        )}
        {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">Saved.</span>}
        {running && restartNeeded && (
          <Button
            size="sm"
            variant="outline"
            disabled={restarting}
            onClick={() => void doRestart()}
          >
            {restarting ? (
              <>
                <Loader2 className="animate-spin" />
                Restarting…
              </>
            ) : (
              "Restart now to apply"
            )}
          </Button>
        )}
        {saved && !running && (
          <span className="text-xs text-muted-foreground">Applies on next start.</span>
        )}
        {saveError !== undefined && <span className="text-xs text-destructive">{saveError}</span>}
      </div>
    </div>
  );
};
