import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vite-plus/test";
import { ContainerList } from "./ContainerList";
import type { ContainerSummary } from "@/ipc";

const CONTAINERS: ContainerSummary[] = [
  {
    id: "a1b2c3",
    name: "compositz-comfyui-a1b2c3",
    state: "running",
    image: "compositz/comfyui-a1b2c3:latest",
    ports: ["8188->8188/tcp"],
  },
  {
    id: "0f1e2d",
    name: "compositz-whisper-0f1e2d",
    state: "exited",
    image: "compositz/whisper-0f1e2d:latest",
    ports: [],
  },
];

// getByText throws when the text is absent, so it doubles as an existence
// assertion; we still assert the node is attached to the document for clarity.
// (This project can't use jest-dom's toBeInTheDocument — see src/test/setup.ts.)
function expectVisible(text: string) {
  const node = screen.getByText(text);
  expect(document.body.contains(node)).toBe(true);
  return node;
}

describe("ContainerList", () => {
  it("renders a row per container with name, state, image and ports", () => {
    render(
      <ContainerList
        containers={CONTAINERS}
        selectedId={undefined}
        loading={false}
        onSelect={() => {}}
      />,
    );

    expectVisible("compositz-comfyui-a1b2c3");
    expectVisible("running");
    expectVisible("compositz/comfyui-a1b2c3:latest");
    expectVisible("8188->8188/tcp");

    expectVisible("compositz-whisper-0f1e2d");
    expectVisible("exited");

    // One <tr> per fixture container, plus the header row.
    expect(screen.getAllByRole("row")).toHaveLength(CONTAINERS.length + 1);
  });

  it("renders a dash for a container with no published ports", () => {
    render(
      <ContainerList
        containers={[CONTAINERS[1]!]}
        selectedId={undefined}
        loading={false}
        onSelect={() => {}}
      />,
    );

    expectVisible("—");
  });

  it("shows an empty-state message when there are no containers", () => {
    render(
      <ContainerList containers={[]} selectedId={undefined} loading={false} onSelect={() => {}} />,
    );

    expectVisible("No managed containers.");
    expect(screen.queryByText("Loading containers…")).toBeNull();
  });

  it("shows a loading message in the empty state while loading", () => {
    render(
      <ContainerList containers={[]} selectedId={undefined} loading={true} onSelect={() => {}} />,
    );

    expectVisible("Loading containers…");
  });

  it("calls onSelect with the container id when a row is clicked", async () => {
    const onSelect = vi.fn();
    render(
      <ContainerList
        containers={CONTAINERS}
        selectedId={undefined}
        loading={false}
        onSelect={onSelect}
      />,
    );

    await userEvent.click(screen.getByText("compositz-comfyui-a1b2c3"));

    expect(onSelect).toHaveBeenCalledExactlyOnceWith("a1b2c3");
  });

  it("marks the selected row as selected", () => {
    render(
      <ContainerList
        containers={CONTAINERS}
        selectedId="a1b2c3"
        loading={false}
        onSelect={() => {}}
      />,
    );

    const selectedRow = screen.getByText("compositz-comfyui-a1b2c3").closest("tr");
    expect(selectedRow?.getAttribute("data-state")).toBe("selected");
  });
});
