import { AlertDialog } from "@base-ui-components/react/alert-dialog";
import { Button } from "../components/ui/button.tsx";

// SPIKE (throwaway): verify a Base UI primitive (AlertDialog — portal + focus trap,
// the part most likely to break) runs under preact/compat in a Fresh island.
export default function SpikeDialog() {
  return (
    <AlertDialog.Root>
      <AlertDialog.Trigger
        render={<Button variant="destructive">Delete instance…</Button>}
      />
      <AlertDialog.Portal>
        <AlertDialog.Backdrop class="fixed inset-0 bg-black/40" />
        <AlertDialog.Popup class="fixed left-1/2 top-1/2 w-80 -translate-x-1/2 -translate-y-1/2 rounded-lg bg-white p-6 shadow-xl">
          <AlertDialog.Title class="text-lg font-semibold">Delete this instance?</AlertDialog.Title>
          <AlertDialog.Description class="mt-2 text-sm text-gray-500">
            The container and definition are removed. Persisted data is kept.
          </AlertDialog.Description>
          <div class="mt-4 flex justify-end gap-2">
            <AlertDialog.Close render={<Button variant="outline">Cancel</Button>} />
            <AlertDialog.Close render={<Button variant="destructive">Delete</Button>} />
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
