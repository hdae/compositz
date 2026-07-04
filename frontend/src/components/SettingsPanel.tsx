import { useEffect, useState } from "react";
import { FileDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { exportMount, getConfig, pickSaveDest, setConfig } from "@/ipc/client";
import type { InstanceSettings, Override, Placement } from "@/ipc/client";
import { Tip } from "./Tip";

type Props = {
  instanceId: string;
  running: boolean;
  onRestart: () => Promise<void>;
};

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
  const [exporting, setExporting] = useState<string | undefined>(undefined); // mount name in flight
  const [exportError, setExportError] = useState<string | undefined>(undefined);

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

  // Export a mount's data as a tar: pick a destination (native save dialog), then the
  // backend streams it there. Works on a stopped instance (a throwaway helper reads it).
  const doExport = async (mountName: string) => {
    setExportError(undefined);
    setExporting(mountName);
    try {
      const dest = await pickSaveDest(`${instanceId}-${mountName}.tar`);
      if (dest === undefined) return; // cancelled
      await exportMount(instanceId, mountName, dest);
    } catch (e) {
      setExportError(`export ${mountName} failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setExporting(undefined);
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

  // Port validity: digits-only is enforced at input time; here the range check.
  // Empty stays legal (= fall back to the manifest default on save).
  const portOutOfRange = (raw: string): boolean => {
    if (raw === "") return false;
    const n = Number(raw);
    return !Number.isInteger(n) || n < 1 || n > 65535;
  };
  const invalidPorts = settings.ports.some((p) => portOutOfRange(ports[p.name] ?? ""));

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
            const raw = ports[p.name] ?? "";
            const cur = Number(raw);
            const outOfRange = portOutOfRange(raw);
            const conflict = !outOfRange && conflictsWith(p.name, cur);
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
                  {outOfRange && (
                    <span className="text-xs text-destructive">port must be 1–65535</span>
                  )}
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
                {/* text + numeric input mode (not type="number"): no spinner buttons,
                    and no scroll-wheel value changes. Digits-only at the keystroke;
                    the 1–65535 range check gates Save. */}
                <Input
                  type="text"
                  inputMode="numeric"
                  value={raw}
                  onChange={(e) => {
                    if (/^\d*$/.test(e.target.value)) editPort(p.name, e.target.value);
                  }}
                  aria-label={`Host port for ${p.name}`}
                  aria-invalid={outOfRange || undefined}
                  className={cn(
                    "w-28 font-mono",
                    conflict && "border-amber-500 focus-visible:ring-amber-500",
                    outOfRange && "border-destructive focus-visible:ring-destructive",
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
              <div className="flex shrink-0 items-center gap-2">
                <Select
                  value={placement[m.name] ?? m.manifestPlacement}
                  onValueChange={(v) => {
                    if (v === "bind" || v === "volume") editPlace(m.name, v);
                  }}
                >
                  <SelectTrigger className="w-24" aria-label={`Placement for ${m.name}`}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="volume">volume</SelectItem>
                    <SelectItem value="bind">bind</SelectItem>
                  </SelectContent>
                </Select>
                <Tip label="Export this mount's data as a tar">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={exporting !== undefined}
                    onClick={() => void doExport(m.name)}
                  >
                    {exporting === m.name ? <Loader2 className="animate-spin" /> : <FileDown />}
                    Export
                  </Button>
                </Tip>
              </div>
            </div>
          ))}
          {exportError !== undefined && (
            <span className="text-xs text-destructive">{exportError}</span>
          )}
        </section>
      )}

      {/* Footer, right-aligned: status text sits immediately left of the actions,
          Save anchors the bottom-right corner. */}
      <div className="flex flex-wrap items-center justify-end gap-3 border-t border-border pt-3">
        {saveError !== undefined && <span className="text-xs text-destructive">{saveError}</span>}
        {invalidPorts && (
          <span className="text-xs text-destructive">Fix invalid ports to save.</span>
        )}
        {missingRequired && (
          <span className="text-xs text-amber-600 dark:text-amber-400">
            Set required values to save.
          </span>
        )}
        {saved && <span className="text-xs text-emerald-600 dark:text-emerald-400">Saved.</span>}
        {saved && !running && (
          <span className="text-xs text-muted-foreground">Applies on next start.</span>
        )}
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
        <Button
          size="sm"
          disabled={saving || missingRequired || invalidPorts}
          onClick={() => void save()}
        >
          {saving ? (
            <>
              <Loader2 className="animate-spin" />
              Saving…
            </>
          ) : (
            "Save"
          )}
        </Button>
      </div>
    </div>
  );
};
