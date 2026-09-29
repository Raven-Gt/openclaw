import WaPopup from "@awesome.me/webawesome/dist/components/popup/popup.js";
import { html, nothing, svg, type PropertyValues, type TemplateResult } from "lit";
import { property, state as litState } from "lit/decorators.js";
import type {
  ChatReactionPerson,
  ChatReactionSummary,
} from "../../../../../packages/gateway-protocol/src/chat-reactions.js";
import { configureAnchoredPopup } from "../../../components/anchored-overlay.ts";
import { strokeIcon } from "../../../components/icons-tools.ts";
import { icons } from "../../../components/icons.ts";
import "../../../components/modal-dialog.ts";
import { focusWithoutTooltip } from "../../../components/tooltip.ts";
import { t } from "../../../i18n/index.ts";
import { emojiForShortcode, suggestEmoji } from "../../../lib/chat/emoji.ts";
import { OpenClawLightDomElement } from "../../../lit/openclaw-element.ts";
import type { ChatReactionsController } from "../chat-reactions.ts";
import "../../../styles/chat/reactions.css";

const MAX_INLINE_REACTIONS = 8;
const QUICK_EMOJI = ["thumbsup", "heart", "joy", "tada", "eyes", "rocket", "fire", "clap"];
const ADD_REACTION_ICON = strokeIcon(svg`<path d="M22 11v1a10 10 0 1 1-9-10" />
  <path d="M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01M16 5h6M19 2v6" />`);

/** Mounted bubbles subscribe to their pane cache; no transcript or browser-storage writes. */
export class ChatMessageReactions extends OpenClawLightDomElement {
  @property({ attribute: false }) controller?: ChatReactionsController;
  @property({ attribute: false }) actions: TemplateResult | typeof nothing = nothing;
  @property() messageId = "";
  @property({ reflect: true }) layout: "user" | "assistant" = "assistant";
  @litState() private expanded = false;
  @litState() private inlineCount = MAX_INLINE_REACTIONS;
  private resizeObserver?: ResizeObserver;
  private measuredStrip?: HTMLElement;
  private measuredChips?: HTMLElement;
  private measureFrame = 0;
  private peopleReturnTarget: HTMLButtonElement | null = null;
  @litState() private pickerOpen = false;
  @litState() private query = "";
  @litState() private peopleEmoji: string | null = null;
  @litState() private people: ChatReactionPerson[] = [];
  @litState() private peopleLoading = false;
  @litState() private peopleError = false;
  @litState() private nextCursor?: string;
  private unsubscribe?: () => void;
  private scopeVersion = -1;
  private pickerNeedsFocus = false;
  private peopleGeneration = 0;

  override connectedCallback() {
    super.connectedCallback();
    this.requestUpdate();
  }

  override disconnectedCallback() {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.measuredStrip = undefined;
    this.measuredChips = undefined;
    cancelAnimationFrame(this.measureFrame);
    this.measureFrame = 0;
    this.expanded = false;
    this.closeDialogs();
    super.disconnectedCallback();
  }

  protected override willUpdate(changed: PropertyValues) {
    if (!this.isConnected) {
      return;
    }
    if (changed.has("controller") || changed.has("messageId") || !this.unsubscribe) {
      this.unsubscribe?.();
      this.expanded = false;
      this.closeDialogs();
      this.scopeVersion = this.controller?.scopeVersion ?? -1;
      this.unsubscribe = this.controller?.subscribe(this.messageId, () => {
        if (this.scopeVersion !== this.controller?.scopeVersion) {
          this.scopeVersion = this.controller?.scopeVersion ?? -1;
          this.expanded = false;
          this.closeDialogs();
        }
        this.requestUpdate();
      });
    }
  }

  private closeDialogs() {
    this.closePicker();
    this.peopleEmoji = null;
    this.peopleGeneration += 1;
    this.people = [];
    this.peopleLoading = false;
    this.peopleError = false;
    this.nextCursor = undefined;
  }

  private selectEmoji(emoji: string) {
    const state = this.controller?.read(this.messageId);
    if (!state || state.pending || state.loading || !this.controller?.canReact) {
      return;
    }
    this.closePicker(this.pickerOpen);
    const active = !state.reactions.some(
      (reaction) => reaction.emoji === emoji && reaction.reactedByMe,
    );
    void this.controller.set(this.messageId, emoji, active);
  }

  private async loadPeople(emoji: string, append = false) {
    const controller = this.controller;
    if (!controller) {
      return;
    }
    const generation = ++this.peopleGeneration;
    const scopeVersion = controller.scopeVersion;
    const messageId = this.messageId;
    this.peopleEmoji = emoji;
    this.peopleLoading = true;
    this.peopleError = false;
    if (!append) {
      this.people = [];
      this.nextCursor = undefined;
    }
    const current = () =>
      this.isConnected &&
      this.controller === controller &&
      controller.available &&
      controller.scopeVersion === scopeVersion &&
      this.messageId === messageId &&
      this.peopleGeneration === generation;
    try {
      const result = await controller.people(
        messageId,
        emoji,
        append ? this.nextCursor : undefined,
      );
      if (!current() || !result) {
        return;
      }
      const merged = new Map(
        (append ? this.people : []).map((person) => [
          `${person.identity.type}:${person.identity.id}`,
          person,
        ]),
      );
      result.reactors.forEach((person) =>
        merged.set(`${person.identity.type}:${person.identity.id}`, person),
      );
      this.people = [...merged.values()];
      this.nextCursor = result.nextCursor;
    } catch {
      if (current()) {
        this.peopleError = true;
      }
    } finally {
      if (current()) {
        this.peopleLoading = false;
      }
    }
  }

  private personLabel(person: ChatReactionPerson) {
    return person.identity.type === "agent"
      ? t("chat.reactions.agentName", { name: person.label })
      : person.label;
  }

  private names(reaction: ChatReactionSummary) {
    const names = reaction.reactors.map((person) => this.personLabel(person)).join(", ");
    const count = Math.max(0, reaction.count - reaction.reactors.length);
    return t(count ? "chat.reactions.moreNames" : "chat.reactions.names", {
      names,
      count: String(count),
      emoji: reaction.emoji,
    });
  }

  private closePicker(restoreFocus = false) {
    this.pickerOpen = false;
    this.pickerNeedsFocus = false;
    this.ownerDocument.removeEventListener("pointerdown", this.dismissPickerOutside, true);
    this.ownerDocument.removeEventListener("focusin", this.dismissPickerOutside, true);
    if (restoreFocus) {
      this.querySelector<HTMLButtonElement>(".chat-reaction-add")?.focus({ preventScroll: true });
    }
  }

  private readonly dismissPickerOutside = (event: Event) => {
    const path = event.composedPath();
    const popup = this.querySelector("wa-popup");
    const trigger = this.querySelector(".chat-reaction-add");
    if ((!popup || !path.includes(popup)) && (!trigger || !path.includes(trigger))) {
      this.closePicker();
    }
  };

  private togglePicker() {
    if (this.pickerOpen) {
      this.closePicker();
      return;
    }
    this.query = "";
    this.pickerOpen = true;
    this.pickerNeedsFocus = true;
    this.ownerDocument.addEventListener("pointerdown", this.dismissPickerOutside, true);
    this.ownerDocument.addEventListener("focusin", this.dismissPickerOutside, true);
  }

  protected override updated() {
    if (!this.isConnected) {
      return;
    }
    this.observeLayout();
    const modal = this.querySelector("openclaw-modal-dialog");
    if (modal && this.peopleEmoji) {
      modal.setReturnFocusTarget(
        this.peopleReturnTarget?.isConnected
          ? this.peopleReturnTarget
          : ([...this.querySelectorAll<HTMLButtonElement>(".chat-reaction-toggle")].find(
              (button) => button.dataset.emoji === this.peopleEmoji,
            ) ??
              this.querySelector<HTMLButtonElement>(
                "button.chat-reaction-more, .chat-reaction-add",
              )),
      );
    }
    const popup = this.querySelector<WaPopup>("wa-popup");
    const trigger = this.querySelector<HTMLButtonElement>(".chat-reaction-add");
    if (popup && trigger && this.pickerOpen) {
      configureAnchoredPopup(popup, trigger, "top", "center");
    }
  }

  private readonly focusPicker = () => {
    if (this.pickerOpen && this.pickerNeedsFocus) {
      this.pickerNeedsFocus = false;
      // Emoji choices come first; do not summon the mobile keyboard until Search is tapped.
      this.querySelector<HTMLButtonElement>(".chat-reaction-picker button")?.focus({
        preventScroll: true,
      });
    }
  };

  private prepareReactionPointer(this: void, event: PointerEvent) {
    const trigger = event.currentTarget as HTMLButtonElement;
    const tooltip = trigger.closest("openclaw-tooltip");
    if (tooltip) {
      tooltip.openOnClick = event.pointerType === "touch" || event.pointerType === "pen";
    }
  }

  private activateReaction(event: MouseEvent, emoji: string) {
    const tooltip = (event.currentTarget as HTMLButtonElement).closest("openclaw-tooltip");
    // The tooltip's capture handler reveals names on the first touch. A second
    // tap toggles the pill; the names bubble can open details without a write.
    if (tooltip?.openOnClick && tooltip.hasAttribute("open")) {
      return;
    }
    this.selectEmoji(emoji);
  }

  private renderPicker() {
    const names = this.query.trim()
      ? suggestEmoji(this.query.trim().toLowerCase().replace(/^:/u, ""))
      : QUICK_EMOJI;
    return html`<wa-popup active @wa-reposition=${this.focusPicker}>
      <section
        class="chat-reaction-popover"
        role="dialog"
        aria-label=${t("chat.reactions.add")}
        @keydown=${(event: KeyboardEvent) => {
          if (event.key === "Escape" && !event.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            this.closePicker(true);
          }
        }}
      >
        <div class="chat-reaction-picker" role="group" aria-label=${t("chat.reactions.add")}>
          ${names.map((name) => {
            const emoji = emojiForShortcode(name);
            return emoji
              ? html`<button
                  type="button"
                  aria-label=${name}
                  @click=${() => this.selectEmoji(emoji)}
                >
                  ${emoji}
                </button>`
              : nothing;
          })}
        </div>
        ${names.length ? nothing : html`<p role="status">${t("chat.reactions.empty")}</p>`}
        <input
          class="chat-reaction-search"
          type="search"
          aria-label=${t("chat.reactions.search")}
          placeholder=${t("chat.reactions.search")}
          autocomplete="off"
          .value=${this.query}
          @input=${(event: InputEvent) => {
            this.query = (event.target as HTMLInputElement).value;
          }}
        />
      </section>
    </wa-popup>`;
  }

  private renderPeople(reactions: ChatReactionSummary[]) {
    const emoji = this.peopleEmoji;
    if (!emoji) {
      return nothing;
    }
    return html`<openclaw-modal-dialog
      label=${t("chat.reactions.people")}
      @modal-cancel=${() => this.closeDialogs()}
    >
      <section class="chat-reaction-dialog">
        <header>
          <h2>${t("chat.reactions.people")}</h2>
          <button
            type="button"
            class="btn btn--icon"
            aria-label=${t("common.close")}
            @click=${() => this.closeDialogs()}
          >
            ${icons.x}
          </button>
        </header>
        <div class="chat-reaction-tabs" role="group" aria-label=${t("chat.reactions.people")}>
          ${reactions.map((reaction) => html`<button type="button" class="chat-reaction-chip" aria-label=${t("chat.reactions.toggle", { emoji: reaction.emoji, count: String(reaction.count) })} aria-pressed=${String(emoji === reaction.emoji)} @click=${() => void this.loadPeople(reaction.emoji)}>${this.renderChipContent(reaction)}</button>`)}
        </div>
        <ul class="chat-reaction-people">
          ${this.people.map((person) => html`<li><span class="chat-reaction-person-avatar" aria-hidden="true">${person.label.slice(0, 1)}</span><span>${this.personLabel(person)}</span></li>`)}
        </ul>
        ${this.peopleLoading ? html`<p role="status">${t("common.loading")}</p>` : nothing}
        ${this.peopleError ? html`<p role="alert">${t("chat.reactions.peopleFailed")} <button type="button" class="btn" @click=${() => void this.loadPeople(emoji, this.people.length > 0)}>${t("chat.reactions.retry")}</button></p>` : nothing}
        ${!this.peopleLoading && !this.peopleError && !this.people.length ? html`<p>${t("chat.reactions.none")}</p>` : nothing}
        ${this.nextCursor && !this.peopleError ? html`<button type="button" class="btn" ?disabled=${this.peopleLoading} @click=${() => void this.loadPeople(emoji, true)}>${t("chat.reactions.more")}</button>` : nothing}
      </section>
    </openclaw-modal-dialog>`;
  }

  private observeLayout() {
    const strip = this.querySelector<HTMLElement>(".chat-reaction-strip") ?? undefined;
    const chips = this.querySelector<HTMLElement>(".chat-reaction-measure") ?? undefined;
    if (strip !== this.measuredStrip || chips !== this.measuredChips) {
      this.resizeObserver?.disconnect();
      this.measuredStrip = strip;
      this.measuredChips = chips;
      if (strip && chips && typeof ResizeObserver !== "undefined") {
        this.resizeObserver ??= new ResizeObserver(this.scheduleMeasure);
        this.resizeObserver.observe(strip);
        this.resizeObserver.observe(chips);
      }
    }
    this.scheduleMeasure();
  }

  private readonly scheduleMeasure = () => {
    if (!this.isConnected || this.measureFrame) {
      return;
    }
    // Measure after layout, never write sizes in ResizeObserver delivery. The
    // strip's CSS containment prevents its inventory from resizing the bubble.
    this.measureFrame = requestAnimationFrame(() => {
      this.measureFrame = 0;
      const strip = this.measuredStrip;
      const measure = this.measuredChips;
      if (!this.isConnected || !strip || !measure || !strip.clientWidth) {
        return;
      }
      const widths = [...measure.querySelectorAll<HTMLElement>(".chat-reaction-chip")].map(
        (chip) => chip.getBoundingClientRect().width,
      );
      const total = this.controller?.read(this.messageId)?.reactions.length ?? 0;
      const gap = Number.parseFloat(getComputedStyle(strip).columnGap) || 0;
      const allWidth = widths.reduce((sum, width) => sum + width, 0) + Math.max(0, total - 1) * gap;
      let count = 0;
      if (total <= MAX_INLINE_REACTIONS && allWidth <= strip.clientWidth) {
        count = total;
      } else {
        // Reserve the widest possible +N label, so changing the visible prefix
        // cannot oscillate between two capacities at a rounding boundary.
        let used =
          measure.querySelector<HTMLElement>(".chat-reaction-more")?.getBoundingClientRect()
            .width ?? 0;
        for (const width of widths) {
          used += gap + width;
          if (used > strip.clientWidth) {
            break;
          }
          count += 1;
        }
      }
      const focused = this.ownerDocument.activeElement;
      const removingFocus =
        focused instanceof HTMLButtonElement &&
        this.contains(focused) &&
        ((count >= total &&
          (focused.classList.contains("chat-reaction-more") ||
            Boolean(this.querySelector(".chat-reaction-overflow")?.contains(focused)))) ||
          (strip.contains(focused) &&
            focused.classList.contains("chat-reaction-toggle") &&
            [...strip.querySelectorAll(".chat-reaction-toggle")].indexOf(focused) >= count));
      const emoji = removingFocus ? focused.dataset.emoji : undefined;
      const scopeVersion = this.scopeVersion;
      this.inlineCount = count;
      if (count >= total) {
        this.expanded = false;
      }
      if (removingFocus) {
        void this.updateComplete.then(() => {
          const active = this.ownerDocument.activeElement;
          if (
            !this.isConnected ||
            this.scopeVersion !== scopeVersion ||
            this.inlineCount !== count ||
            (active !== focused && active !== this.ownerDocument.body)
          ) {
            return;
          }
          const chips = [
            ...this.querySelectorAll<HTMLButtonElement>(
              ".chat-reaction-strip .chat-reaction-toggle",
            ),
          ];
          focusWithoutTooltip(
            chips.find((chip) => chip.dataset.emoji === emoji) ??
              this.querySelector<HTMLButtonElement>("button.chat-reaction-more") ??
              chips[0] ??
              this.querySelector<HTMLButtonElement>(".chat-reaction-actions button"),
          );
        });
      }
    });
  };

  private collapseReactions() {
    this.querySelector<HTMLButtonElement>(".chat-reaction-more")?.focus({ preventScroll: true });
    this.expanded = false;
  }

  private renderChipContent(reaction: ChatReactionSummary) {
    return html`<span class="chat-reaction-emoji" aria-hidden="true">${reaction.emoji}</span>
      ${reaction.count > 1 ? html`<span class="chat-reaction-count" aria-hidden="true">${reaction.count}</span>` : nothing}`;
  }

  private renderReaction(reaction: ChatReactionSummary, disabled: boolean, expanded = false) {
    return html`<openclaw-tooltip
      class="chat-reaction-tooltip"
      .delay=${400}
      .placement=${expanded ? "bottom" : "top"}
      .disabled=${this.pickerOpen || this.peopleEmoji !== null}
    >
      <button
        type="button"
        class="chat-reaction-chip chat-reaction-toggle"
        data-emoji=${reaction.emoji}
        aria-label=${t("chat.reactions.toggle", { emoji: reaction.emoji, count: String(reaction.count) })}
        aria-pressed=${String(reaction.reactedByMe)}
        aria-disabled=${String(disabled)}
        @pointerdown=${this.prepareReactionPointer}
        @keydown=${(event: KeyboardEvent) => {
          const tooltip = (event.currentTarget as HTMLButtonElement).closest("openclaw-tooltip");
          if (tooltip) {
            tooltip.openOnClick = false;
          }
        }}
        @click=${(event: MouseEvent) => this.activateReaction(event, reaction.emoji)}
      >
        ${this.renderChipContent(reaction)}
      </button>
      <button
        slot="content"
        type="button"
        class="chat-reaction-details-link"
        aria-label=${t("chat.reactions.peopleForEmoji", { emoji: reaction.emoji })}
        aria-haspopup="dialog"
        @click=${(event: MouseEvent) => {
          this.peopleReturnTarget =
            (event.currentTarget as HTMLElement)
              .closest("openclaw-tooltip")
              ?.querySelector<HTMLButtonElement>(".chat-reaction-toggle") ?? null;
          // The native dialog also remembers its opening focus. Put that
          // on the stable pill, not the transient rich-tooltip link.
          this.peopleReturnTarget?.focus({ preventScroll: true });
          void this.loadPeople(reaction.emoji);
        }}
      >
        ${this.names(reaction)}
      </button>
    </openclaw-tooltip>`;
  }

  override render() {
    const state = this.controller?.read(this.messageId);
    if (!state) {
      return html`<div class="chat-reactions">
        <div class="chat-reaction-strip"></div>
        <div class="chat-reaction-actions">${this.actions}</div>
      </div>`;
    }
    const disabled = state.pending || state.loading || !this.controller?.canReact;
    const hiddenCount = Math.max(0, state.reactions.length - this.inlineCount);
    return html`<div
        class="chat-reactions"
        aria-busy=${String(state.pending || state.loading)}
        @keydown=${(event: KeyboardEvent) => {
          if (
            this.expanded &&
            event.key === "Escape" &&
            !event.isComposing &&
            !event.defaultPrevented
          ) {
            event.preventDefault();
            event.stopPropagation();
            this.collapseReactions();
          }
        }}
      >
        <div class="chat-reaction-strip">
          ${state.reactions.slice(0, this.inlineCount).map((reaction) => this.renderReaction(reaction, disabled))}
          ${
            hiddenCount
              ? html`<button
                  type="button"
                  class="chat-reaction-more"
                  aria-label=${t("chat.reactions.showMore", { count: String(hiddenCount) })}
                  aria-expanded=${String(this.expanded)}
                  @click=${() => {
                    this.expanded = !this.expanded;
                  }}
                >
                  +${hiddenCount}
                </button>`
              : nothing
          }
        </div>
        <div class="chat-reaction-actions">
          ${this.actions}
          ${
            this.controller?.canReact
              ? html`<openclaw-tooltip
                  content=${t("chat.reactions.add")}
                  .disabled=${this.pickerOpen}
                  ><button
                    type="button"
                    class="chat-reaction-add"
                    aria-label=${t("chat.reactions.add")}
                    aria-haspopup="dialog"
                    aria-expanded=${String(this.pickerOpen)}
                    ?disabled=${disabled}
                    @click=${() => this.togglePicker()}
                  >
                    <span class="chat-reaction-add-icon" aria-hidden="true"
                      >${ADD_REACTION_ICON}</span
                    >
                  </button></openclaw-tooltip
                >`
              : nothing
          }
        </div>
        ${
          this.expanded && hiddenCount
            ? html`<section class="chat-reaction-overflow" aria-label=${t("chat.reactions.all")}>
                <div class="chat-reaction-overflow-heading">
                  <span>${t("chat.reactions.all")}</span>
                  <button
                    type="button"
                    class="chat-reaction-collapse"
                    @click=${() => this.collapseReactions()}
                  >
                    ${t("chat.reactions.collapse")}
                  </button>
                </div>
                <div class="chat-reaction-overflow-chips">
                  ${state.reactions.map((reaction) => this.renderReaction(reaction, disabled, true))}
                </div>
              </section>`
            : nothing
        }
        <div class="chat-reaction-measure-clip" aria-hidden="true" inert>
          <div class="chat-reaction-measure">
            ${state.reactions.slice(0, MAX_INLINE_REACTIONS).map((reaction) => html`<span class="chat-reaction-chip">${this.renderChipContent(reaction)}</span>`)}
            <span class="chat-reaction-more">+${state.reactions.length}</span>
          </div>
        </div>
      </div>
      ${state.error ? html`<span class="chat-reaction-error" role="alert">${t(state.error === "save" ? "chat.reactions.saveFailed" : "chat.reactions.loadFailed")} <button type="button" ?disabled=${state.pending || state.loading} @click=${() => this.controller?.retry(this.messageId)}>${t("chat.reactions.retry")}</button></span>` : nothing}
      ${this.pickerOpen ? this.renderPicker() : nothing} ${this.renderPeople(state.reactions)}`;
  }
}

customElements.define("openclaw-chat-message-reactions", ChatMessageReactions);
