import { Globe, Hammer, ScrollText, Settings } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useInstancesStore } from "@/store/instances";
import type { RowVM, TabKey } from "@/store/instances";
import { LogView } from "./LogView";
import { RuntimeLog } from "./RuntimeLog";
import { ServicesList } from "./ServicesList";
import { SettingsPanel } from "./SettingsPanel";

/** The tab shown when the user hasn't picked one: follows the instance's current state. */
function defaultTabFor(vm: RowVM, buildAvailable: boolean): TabKey {
  if (vm.busy === "installing") return "build";
  if (vm.row.running) return "services";
  if (buildAvailable) return "build";
  return "logs";
}

/**
 * The expanded row's tabbed detail: Build log (while/after a build) · Runtime log
 * (streamed while running) · Services · Settings. The active tab follows an explicit
 * pick (`vm.tab`) else a per-state default, clamped to a tab that actually exists. Base
 * UI unmounts inactive panels, so the runtime-log stream and the settings fetch only
 * run while their tab is active.
 */
export const DetailPanel = ({ vm }: { vm: RowVM }) => {
  const { row, buildLog, tab } = vm;
  const setTab = useInstancesStore((s) => s.setTab);
  const restart = useInstancesStore((s) => s.restart);

  const buildLines = buildLog ?? [];
  const buildAvailable = buildLines.length > 0 || vm.busy === "installing";
  let active = tab ?? defaultTabFor(vm, buildAvailable);
  if (active === "build" && !buildAvailable) active = row.running ? "services" : "logs";

  return (
    <Tabs
      value={active}
      onValueChange={(value) => {
        if (value === "build" || value === "logs" || value === "services" || value === "settings") {
          setTab(row.instanceId, value);
        }
      }}
    >
      <TabsList variant="line">
        {buildAvailable && (
          <TabsTrigger value="build">
            <Hammer />
            Build log
          </TabsTrigger>
        )}
        <TabsTrigger value="logs">
          <ScrollText />
          Runtime log
        </TabsTrigger>
        <TabsTrigger value="services">
          <Globe />
          Services
        </TabsTrigger>
        <TabsTrigger value="settings">
          <Settings />
          Settings
        </TabsTrigger>
      </TabsList>

      {buildAvailable && (
        <TabsContent value="build">
          <LogView lines={buildLines} emptyLabel="Waiting for build output…" />
        </TabsContent>
      )}
      <TabsContent value="logs" keepMounted={false}>
        <RuntimeLog instanceId={row.instanceId} running={row.running} />
      </TabsContent>
      <TabsContent value="services">
        <ServicesList services={row.services} running={row.running} />
      </TabsContent>
      <TabsContent value="settings" keepMounted={false}>
        <SettingsPanel
          instanceId={row.instanceId}
          running={row.running}
          onRestart={() => restart(row.instanceId)}
        />
      </TabsContent>
    </Tabs>
  );
};
