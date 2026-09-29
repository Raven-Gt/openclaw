/* @vitest-environment jsdom */
import type { LitElement } from "lit";
import { nothing, render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MessageReactionSummary } from "../../../../../packages/gateway-protocol/src/index.js";
import { renderMessageGroup } from "./chat-message-group.ts";
import { createMessageGroup } from "./chat-message.test-support.ts";

const reactions: MessageReactionSummary[] = [
  {
    emoji: "👍",
    count: 2,
    identities: [
      { id: "self", label: "Alex" },
      { id: "peer", label: "Riley" },
    ],
  },
];
let host: HTMLDivElement;
afterEach(() => {
  if (host) {
    render(nothing, host);
    host.remove();
  }
});

function show(
  options: { role?: string; persisted?: boolean; streaming?: boolean; writable?: boolean } = {},
) {
  host = document.body.appendChild(document.createElement("div"));
  const role = options.role ?? "user";
  const onReact = vi.fn();
  const message = {
    role,
    content: [{ type: "text", text: "A shared prompt" }],
    timestamp: 1,
    ...(options.persisted === false ? {} : { __openclaw: { id: "message-1" } }),
  };
  render(
    renderMessageGroup(
      createMessageGroup(message, role, { isStreaming: options.streaming ?? false }),
      {
        showReasoning: false,
        userId: "self",
        messageReactions: new Map([["message-1", reactions]]),
        onReact: options.writable === false ? undefined : onReact,
      },
    ),
    host,
  );
  return { onReact, picker: host.querySelector<LitElement>("openclaw-message-reaction-picker") };
}

describe("transcript message reactions", () => {
  it.each(["user", "assistant"])(
    "renders %s chips with attribution and toggles the current user's reaction",
    (role) => {
      const { onReact, picker } = show({ role });
      expect(picker).not.toBeNull();
      const chip = host.querySelector<HTMLButtonElement>(".chat-reaction-chip")!;
      expect(chip.textContent).toContain("👍");
      expect(chip.getAttribute("aria-pressed")).toBe("true");
      const tooltip = chip.parentElement as HTMLElement & { content: string };
      expect(tooltip.content).toBe("Alex, Riley");
      chip.click();
      expect(onReact).toHaveBeenCalledWith("message-1", "👍", true);
    },
  );

  it("keeps chips visible for readers while hiding mutation controls", () => {
    const { picker, onReact } = show({ writable: false });
    expect(picker).toBeNull();
    const chip = host.querySelector<HTMLButtonElement>(".chat-reaction-chip")!;
    expect(chip.disabled).toBe(true);
    chip.click();
    expect(onReact).not.toHaveBeenCalled();
  });

  it.each([{ persisted: false }, { streaming: true }, { role: "system" }])(
    "omits controls for ineligible messages: %j",
    (options) => {
      const { picker } = show(options);
      expect(picker).toBeNull();
      expect(host.querySelector(".chat-message-reactions")).toBeNull();
    },
  );

  it("adds palette and custom emoji through the message action", async () => {
    const { picker, onReact } = show();
    await picker!.updateComplete;
    const root = picker!.shadowRoot!;
    // JSDOM's selector engine misses non-BMP attribute values in a shadow root.
    const choice = [...root.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("aria-label") === "🎉",
    );
    expect(choice).toBeDefined();
    choice!.click();
    expect(onReact).toHaveBeenLastCalledWith("message-1", "🎉", false);
    root.querySelector<HTMLButtonElement>(".more")!.click();
    await picker!.updateComplete;
    const input = root.querySelector<HTMLInputElement>('[aria-label="Emoji"]')!;
    input.value = "🦞";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await picker!.updateComplete;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(onReact).toHaveBeenLastCalledWith("message-1", "🦞", false);
    expect(root.querySelector(".hint")?.textContent?.trim()).not.toBe("");
  });
});
