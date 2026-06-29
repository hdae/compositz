import { Button } from "../components/ui/button.tsx";
import SpikeDialog from "../islands/SpikeDialog.tsx";

// SPIKE (throwaway): verify the Shadcn cva Button + a Base UI primitive (AlertDialog
// via preact/compat) compile + bundle under Fresh 2 / Tailwind v4. Remove once the
// component-library decision is settled.
export default function Spike() {
  return (
    <div class="p-10 flex flex-col gap-6">
      <div class="flex flex-wrap gap-3">
        <Button>Default</Button>
        <Button variant="secondary">Secondary</Button>
        <Button variant="outline">Outline</Button>
        <Button variant="destructive">Delete</Button>
        <Button variant="ghost">Ghost</Button>
        <Button variant="link">Link</Button>
        <Button size="sm">Small</Button>
        <Button disabled>Disabled</Button>
      </div>
      <SpikeDialog />
    </div>
  );
}
