import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionReactionsListParams,
  validateSessionReactionsSetParams,
  type MessageReactionSummary,
  type SessionReactionMirror,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveChannelAccount } from "../../channels/account-resolution.js";
import { listCrossChannelSchemaSupportedMessageActions } from "../../channels/plugins/message-action-discovery.js";
import {
  listSessionReactions,
  setSessionReaction,
  SessionReactionLimitError,
} from "../../config/sessions.js";
import { resolveConversation } from "../../config/sessions/conversation-registry.js";
import { readSessionTranscriptMessageByEventId } from "../../config/sessions/session-accessor.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { isConfiguredChannel } from "../../infra/outbound/channel-selection.js";
import { resolveMessageActionOutcome } from "../../infra/outbound/message-action-contracts.js";
import { getRuntimeVisibleChannelPlugin } from "../../infra/outbound/runtime-visible-channels.js";
import { withSystemEventOwner } from "../../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../../infra/system-events.js";
import { isAccountEnabled } from "../../shared/account-enabled.js";
import { operatorSessionCap } from "../operator-role-policy.js";
import {
  authorizeIncognitoSessionTarget,
  authorizeSessionSharingTarget,
  resolveSessionSharingRole,
  resolveSessionSharingTarget,
  resolveSessionVisibility,
} from "../session-sharing.js";
import { gatewayClientSessionCreator } from "./gateway-client-identity.js";
import {
  requireSuggestionTarget,
  requireVisibleSuggestionRole,
} from "./sessions-suggestions-access.js";
import type { GatewayClient, GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayHandler } from "./validation.js";

type ReactionTarget = NonNullable<ReturnType<typeof resolveSessionSharingTarget>>;
type ReactionAuthorization = {
  client: GatewayClient | null;
  cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
  target: ReactionTarget;
};

const emojiSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const emojiSequence =
  /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\u{1F3F4}[\u{E0061}-\u{E007A}]+\u{E007F}|\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*)$/u;

function isReactionEmoji(emoji: string): boolean {
  return (
    Array.from(emoji).length <= 32 &&
    [...emojiSegmenter.segment(emoji)].length === 1 &&
    emojiSequence.test(emoji)
  );
}

function authorizeSessionReaction(params: ReactionAuthorization) {
  const role = resolveSessionSharingRole(params);
  const cap = operatorSessionCap(params.client, params.cfg);
  if (cap === "none") {
    return errorShape(ErrorCodes.FORBIDDEN, "your operator role does not permit session reactions");
  }
  if (cap === "view" && role === "viewer") {
    return errorShape(ErrorCodes.FORBIDDEN, "your operator role permits viewing sessions only");
  }
  const denied = authorizeSessionSharingTarget(params);
  return denied && !(resolveSessionVisibility(params.target.entry) === "suggest" && cap !== "view")
    ? denied
    : null;
}

function reactionScope(target: ReactionTarget) {
  return { agentId: target.agentId, sessionKey: target.storeKey, storePath: target.storePath };
}

async function mirrorReaction(params: {
  context: GatewayRequestContext;
  target: ReactionTarget;
  message: Record<string, unknown>;
  emoji: string;
  remove: boolean;
  assertCurrent: () => void;
}): Promise<SessionReactionMirror> {
  if (params.message.role === "assistant") {
    return {
      status: "skipped",
      reason: "assistant reply has no persisted delivered channel message id",
    };
  }
  const transport = asOptionalRecord(asOptionalRecord(params.message["__openclaw"])?.transport);
  if (
    typeof transport?.channel !== "string" ||
    typeof transport.conversationRef !== "string" ||
    typeof transport.messageId !== "string"
  ) {
    return { status: "skipped", reason: "message has no source channel transport" };
  }
  try {
    const cfg = params.context.getRuntimeConfig();
    const conversation = resolveConversation(
      reactionScope(params.target),
      transport.conversationRef,
    );
    if (!conversation || conversation.channel !== transport.channel) {
      return { status: "skipped", reason: "source conversation is unavailable" };
    }
    const channel = conversation.channel;
    if (!isConfiguredChannel(cfg, channel)) {
      return { status: "skipped", reason: "source channel is not configured or enabled" };
    }
    if (
      !listCrossChannelSchemaSupportedMessageActions({
        cfg,
        channel,
        accountId: conversation.accountId,
        agentId: params.target.agentId,
        sessionKey: params.target.canonicalKey,
        sessionId: params.target.entry.sessionId,
        currentChannelId: conversation.nativeChannelId,
        currentMessageId: transport.messageId,
        currentThreadTs: conversation.threadId,
      }).includes("react")
    ) {
      return { status: "skipped", reason: "source channel does not support reactions" };
    }
    const plugin = getRuntimeVisibleChannelPlugin(channel);
    if (!plugin) {
      return { status: "skipped", reason: "source channel is unavailable" };
    }
    const account = await resolveChannelAccount({ plugin, cfg, accountId: conversation.accountId });
    if (
      !(plugin.config.isEnabled?.(account, cfg) ?? isAccountEnabled(account)) ||
      !((await plugin.config.isConfigured?.(account, cfg)) ?? true)
    ) {
      return { status: "skipped", reason: "source channel account is not configured or enabled" };
    }
    const { runMessageAction } = await import("../../infra/outbound/message-action-runner.js");
    const assertCurrent = () => {
      params.assertCurrent();
      if (params.context.getRuntimeConfig() !== cfg) {
        throw new Error("channel configuration changed before reaction delivery");
      }
    };
    assertCurrent();
    const outcome = resolveMessageActionOutcome(
      await runMessageAction({
        cfg,
        action: "react",
        agentId: params.target.agentId,
        sessionKey: params.target.canonicalKey,
        sessionId: params.target.entry.sessionId,
        assertDirectAdapterHandoff: assertCurrent,
        params: {
          channel,
          to: conversation.target,
          accountId: conversation.accountId,
          ...(conversation.threadId ? { threadId: conversation.threadId } : {}),
          messageId: transport.messageId,
          emoji: params.emoji,
          remove: params.remove,
        },
      }),
    );
    if (!outcome.ok) {
      throw new Error(outcome.error);
    }
    return { status: "delivered" };
  } catch (error) {
    const reason = formatErrorMessage(error);
    params.context.logGateway.warn(`Control UI reaction mirror failed: ${reason}`);
    return { status: "failed", reason };
  }
}

export const sessionReactionHandlers: GatewayRequestHandlers = {
  "session.reactions.list": defineValidatedGatewayHandler(
    "session.reactions.list",
    validateSessionReactionsListParams,
    ({ params, respond, client, context }) => {
      const target = requireSuggestionTarget({ client, context, ...params, respond });
      if (!target) {
        return;
      }
      const cfg = (context.getCommittedRuntimeConfig ?? context.getRuntimeConfig)();
      if (
        requireVisibleSuggestionRole({
          client,
          cfg,
          sessionKey: params.sessionKey,
          target,
          respond,
        }) === null
      ) {
        return;
      }
      respond(true, {
        sessionId: target.entry.sessionId,
        reactions: listSessionReactions(reactionScope(target), {
          sessionId: target.entry.sessionId,
        }),
      });
    },
  ),
  "session.reactions.set": defineValidatedGatewayHandler(
    "session.reactions.set",
    validateSessionReactionsSetParams,
    async ({ params, respond, client, context, hasCurrentClientAuthority }) => {
      const target = requireSuggestionTarget({ client, context, ...params, respond });
      if (!target) {
        return;
      }
      const cfg = (context.getCommittedRuntimeConfig ?? context.getRuntimeConfig)();
      if (
        requireVisibleSuggestionRole({
          client,
          cfg,
          sessionKey: params.sessionKey,
          target,
          respond,
        }) === null
      ) {
        return;
      }
      const denied = authorizeSessionReaction({ client, cfg, target });
      if (denied) {
        respond(false, undefined, denied);
        return;
      }
      const actor = gatewayClientSessionCreator(client);
      if (!actor) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "identified reaction author required"),
        );
        return;
      }
      if (!isReactionEmoji(params.emoji)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "one emoji grapheme is required"),
        );
        return;
      }
      const scope = reactionScope(target);
      const message = asOptionalRecord(
        readSessionTranscriptMessageByEventId(
          {
            ...scope,
            sessionId: target.entry.sessionId,
          },
          params.messageId,
        )?.message,
      );
      if (!message || (message.role !== "user" && message.role !== "assistant")) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unknown message"));
        return;
      }
      const assertCurrent = () => {
        const currentCfg = (context.getCommittedRuntimeConfig ?? context.getRuntimeConfig)();
        const current = resolveSessionSharingTarget({
          cfg: currentCfg,
          sessionKey: params.sessionKey,
          agentId: target.agentId,
        });
        if (
          hasCurrentClientAuthority?.() === false ||
          client?.invalidated ||
          client?.connectionSignal?.aborted ||
          !current ||
          current.storePath !== target.storePath ||
          current.entry.sessionId !== target.entry.sessionId ||
          authorizeIncognitoSessionTarget({
            client,
            sessionKey: params.sessionKey,
            target: current,
          }) ||
          authorizeSessionReaction({ client, cfg: currentCfg, target: current }) ||
          gatewayClientSessionCreator(client)?.id !== actor.id
        ) {
          throw new Error("reaction author or session authority changed");
        }
      };
      let reactions: MessageReactionSummary[];
      try {
        assertCurrent();
        reactions = setSessionReaction(scope, {
          messageId: params.messageId,
          emoji: params.emoji,
          identityId: actor.id,
          identityLabel: actor.label,
          remove: params.remove,
          expectedSessionId: target.entry.sessionId,
        });
      } catch (error) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            error instanceof SessionReactionLimitError
              ? "reaction limit reached"
              : formatErrorMessage(error),
          ),
        );
        return;
      }
      const action = params.remove ? "removed" : "added";
      context.broadcast(
        "session.reaction",
        {
          sessionKey: target.canonicalKey,
          agentId: target.agentId,
          sessionId: target.entry.sessionId,
          messageId: params.messageId,
          emoji: params.emoji,
          action,
          actor,
          reactions,
        },
        {
          sessionKeys: [
            ...new Set([params.sessionKey, target.canonicalKey, target.storeKey]),
          ].toSorted(),
          agentId: target.agentId,
        },
      );
      const metadata = asOptionalRecord(message["__openclaw"]);
      const author =
        message.role === "assistant"
          ? "assistant"
          : ([metadata?.senderName, metadata?.senderUsername, metadata?.senderId].find(
              (label): label is string => typeof label === "string" && label.trim().length > 0,
            ) ?? "user");
      enqueueSystemEvent(
        `Control UI reaction ${action}: ${params.emoji} by ${actor.label ?? actor.id} on msg ${params.messageId} from ${author}`,
        withSystemEventOwner(
          {
            sessionKey: target.canonicalKey,
            sessionStorePath: target.storePath,
            contextKey: `control-ui:reaction:${action}:${params.messageId}:${actor.id}:${params.emoji}`,
          },
          target.agentId,
        ),
      );
      const mirror = await mirrorReaction({
        context,
        target,
        message,
        emoji: params.emoji,
        remove: params.remove === true,
        assertCurrent,
      });
      respond(true, { messageId: params.messageId, reactions, mirror });
    },
  ),
};
