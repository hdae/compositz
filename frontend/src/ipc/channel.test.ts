import { Channel, invoke } from "@tauri-apps/api/core";
import { mockIPC } from "@tauri-apps/api/mocks";
import { describe, expect, it } from "vite-plus/test";
import { channelCallbackId, channelPusher } from "./mock";

// REGRESSION TRIPWIRE. Our browser-dev mock (src/ipc/mock.ts) delivers Channel
// messages by resolving the channel's callback in window.__TAURI_INTERNALS__
// .callbacks (installed by mockIPC) and pushing the { index, message } envelope
// that Tauri's Channel callback expects — all implementation behavior of
// @tauri-apps/api, not a documented contract. If a @tauri-apps/api upgrade
// changes how Channel exposes its id, how mockIPC registers callbacks, or the
// envelope shape, this test fails first and tells us the mock needs updating.
//
// These tests drive the *real* channelPusher/channelCallbackId helpers so a
// regression in the mock's plumbing trips here, not just in a hand-rolled copy.

describe("Channel under mockIPC", () => {
  it("delivers ordered messages through channelPusher", async () => {
    const received: string[] = [];

    mockIPC((cmd, payload) => {
      expect(cmd).toBe("stream_logs");
      const pusher = channelPusher((payload as Record<string, unknown>)["onLog"]);
      expect(pusher).toBeDefined();
      pusher!.push("first");
      pusher!.push("second");
      pusher!.end();
      return null;
    });

    const channel = new Channel<string>();
    channel.onmessage = (line) => received.push(line);

    await invoke("stream_logs", { containerId: "abc123", onLog: channel });

    expect(received).toEqual(["first", "second"]);
  });

  it("recovers the callback id from the live Channel object", async () => {
    let resolvedId: number | undefined;

    mockIPC((_cmd, payload) => {
      resolvedId = channelCallbackId((payload as Record<string, unknown>)["onLog"]);
      return null;
    });

    const channel = new Channel<string>();
    await invoke("stream_logs", { onLog: channel });

    // The channel's public id is the callback id our mock resolves against.
    expect(resolvedId).toBe(channel.id);
  });

  it("reorders out-of-order envelopes by their index", async () => {
    const received: string[] = [];

    mockIPC((_cmd, payload) => {
      const id = channelCallbackId((payload as Record<string, unknown>)["onLog"])!;
      const callback = window.__TAURI_INTERNALS__!.callbacks!.get(id)!;
      // Deliver index 1 before index 0; the Channel must buffer and reorder.
      callback({ index: 1, message: "second" });
      callback({ index: 0, message: "first" });
      return null;
    });

    const channel = new Channel<string>();
    channel.onmessage = (line) => received.push(line);

    await invoke("stream_logs", { onLog: channel });

    expect(received).toEqual(["first", "second"]);
  });

  it("stops delivering to the caller after streamLogs' disposer runs", async () => {
    // Exercises the real facade (src/ipc/index.ts), so a regression in the
    // facade's Channel handling also trips here.
    const { streamLogs } = await import("./index");
    const lines: string[] = [];
    let push: ((message: string) => void) | undefined;

    mockIPC((_cmd, payload) => {
      const pusher = channelPusher((payload as Record<string, unknown>)["onLog"])!;
      push = pusher.push;
      push("before dispose");
      return null;
    });

    const dispose = await streamLogs("cid", (line) => lines.push(line));
    expect(lines).toEqual(["before dispose"]);

    // The Phase 0 disposer detaches the local handler; later pushes are dropped.
    dispose();
    push?.("after dispose");
    expect(lines).toEqual(["before dispose"]);
  });
});
