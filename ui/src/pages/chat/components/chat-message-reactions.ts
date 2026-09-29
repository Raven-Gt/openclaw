import WaPopover from "@awesome.me/webawesome/dist/components/popover/popover.js";
import { css, html, nothing, svg } from "lit";
import { property, state } from "lit/decorators.js";
import { ref } from "lit/directives/ref.js";
import type { MessageReactionSummary } from "../../../../../packages/gateway-protocol/src/index.js";
import { strokeIcon } from "../../../components/icons-tools.ts";
import { sessionEmojiPickerShortcut } from "../../../components/session-icon-picker.ts";
import { syncPopoverLabel } from "../../../components/web-awesome-popover.ts";
import { t } from "../../../i18n/index.ts";
import { OpenClawLitElement } from "../../../lit/openclaw-element.ts";

export type MessageReactionAction = (messageId: string, emoji: string, remove: boolean) => void;

const addReactionIcon = strokeIcon(svg`<path d="M21 11.5a9 9 0 1 1-8.5-8.5"/>
  <path d="M8 14s1.5 2 4 2 4-2 4-2M16 5h6M19 2v6"/>
  <path d="M9 9h.01M15 9h.01"/>`);

export function renderMessageReactions(
  messageId: string | undefined,
  options: {
    messageReactions?: ReadonlyMap<string, MessageReactionSummary[]>;
    userId?: string | null;
    onReact?: MessageReactionAction;
  },
) {
  if (!messageId) {
    return nothing;
  }
  const reactions = options.messageReactions?.get(messageId) ?? [];
  const { userId, onReact } = options;
  return reactions.length
    ? html`<div class="chat-message-reactions" data-message-id=${messageId}>
        ${reactions.map((reaction) => {
          const pressed = reaction.identities.some((identity) => identity.id === userId);
          const label = reaction.identities
            .map((identity) => identity.label ?? identity.id)
            .join(", ");
          return html`<openclaw-tooltip .content=${label}>
            <button
              class="chat-reaction-chip"
              type="button"
              aria-label=${`${reaction.emoji} ${reaction.count}`}
              aria-pressed=${String(pressed)}
              ?disabled=${!onReact}
              @click=${() => onReact?.(messageId, reaction.emoji, pressed)}
            >
              <span>${reaction.emoji}</span><span>${reaction.count}</span>
            </button>
          </openclaw-tooltip>`;
        })}
      </div>`
    : nothing;
}

class MessageReactionPicker extends OpenClawLitElement {
  @property({ attribute: false }) onSelect?: (emoji: string) => void;
  @state() private custom = false;
  @state() private value = "";

  static override styles = css`
    :host {
      display: inline-flex;
    }
    button,
    input {
      font: inherit;
      color: var(--text);
    }
    button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      border-radius: var(--radius-md);
      background: transparent;
      cursor: default;
    }
    button:hover {
      background: var(--bg-hover);
    }
    button:focus-visible,
    input:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .trigger {
      width: 24px;
      height: 24px;
      padding: 4px;
      color: var(--muted);
    }
    .trigger:hover {
      color: var(--accent);
    }
    .trigger svg {
      width: 14px;
      height: 14px;
    }
    .palette {
      display: flex;
      align-items: center;
      gap: 2px;
    }
    .palette button {
      min-width: 32px;
      min-height: 34px;
      font-size: 20px;
    }
    .palette .more {
      font-size: 12px;
      padding: 0 8px;
    }
    .custom {
      width: 240px;
    }
    .controls {
      display: flex;
      gap: 8px;
    }
    input {
      min-width: 0;
      flex: 1;
      border: 1px solid var(--border);
      border-radius: var(--radius-md);
      background: var(--bg);
      padding: 6px 8px;
    }
    .apply {
      border: 1px solid var(--border);
      padding: 6px 10px;
    }
    button:disabled {
      opacity: 0.5;
    }
    .hint {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 12px;
    }
    wa-popover {
      --max-width: min(340px, calc(100vw - 16px));
    }
  `;

  private close() {
    const popover = this.renderRoot.querySelector<WaPopover>("wa-popover");
    if (popover) {
      popover.open = false;
    }
  }

  private select(emoji: string) {
    if (!emoji.trim()) {
      return;
    }
    this.onSelect?.(emoji.trim());
    this.close();
  }

  override render() {
    const shortcut = sessionEmojiPickerShortcut();
    return html`
      <openclaw-tooltip .content=${t("chat.reactions.add")}>
        <button
          id="reaction-trigger"
          class="trigger"
          type="button"
          aria-label=${t("chat.reactions.add")}
          aria-haspopup="dialog"
          aria-expanded="false"
        >
          ${addReactionIcon}
        </button>
      </openclaw-tooltip>
      <wa-popover
        class="chat-reaction-picker"
        for="reaction-trigger"
        placement="top-end"
        aria-label=${t("chat.reactions.add")}
        ${ref(syncPopoverLabel)}
        @wa-show=${(event: Event) => {
          if (event.currentTarget instanceof WaPopover) {
            event.currentTarget.anchor?.setAttribute("aria-expanded", "true");
          }
        }}
        @wa-hide=${(event: Event) => {
          if (event.currentTarget instanceof WaPopover) {
            event.currentTarget.anchor?.setAttribute("aria-expanded", "false");
          }
        }}
        @wa-after-hide=${() => {
          this.custom = false;
          this.value = "";
        }}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            this.close();
          }
        }}
      >
        ${
          this.custom
            ? html`<div class="custom">
                <div class="controls">
                  <input
                    aria-label=${t("chat.reactions.emoji")}
                    autocomplete="off"
                    .value=${this.value}
                    @input=${(event: InputEvent) => {
                      if (event.currentTarget instanceof HTMLInputElement) {
                        this.value = event.currentTarget.value;
                      }
                    }}
                    @keydown=${(event: KeyboardEvent) => {
                      if (event.key === "Enter" && !event.isComposing) {
                        event.preventDefault();
                        event.stopPropagation();
                        this.select(this.value);
                      }
                    }}
                  />
                  <button
                    class="apply"
                    type="button"
                    ?disabled=${!this.value.trim()}
                    @click=${() => this.select(this.value)}
                  >
                    ${t("chat.reactions.apply")}
                  </button>
                </div>
                <p class="hint">
                  ${shortcut ? t("chat.reactions.shortcut", { shortcut }) : t("chat.reactions.hint")}
                </p>
              </div>`
            : html`<div class="palette">
                ${["👍", "❤️", "🎉", "👀", "🚀", "😂"].map(
                  (emoji) => html`<button
                    type="button"
                    aria-label=${emoji}
                    @click=${() => this.select(emoji)}
                  >
                    ${emoji}
                  </button>`,
                )}
                <button
                  class="more"
                  type="button"
                  @click=${async () => {
                    this.custom = true;
                    await this.updateComplete;
                    this.renderRoot.querySelector("input")?.focus();
                  }}
                >
                  ${t("chat.reactions.more")}
                </button>
              </div>`
        }
      </wa-popover>
    `;
  }
}

if (!customElements.get("openclaw-message-reaction-picker")) {
  customElements.define("openclaw-message-reaction-picker", MessageReactionPicker);
}
