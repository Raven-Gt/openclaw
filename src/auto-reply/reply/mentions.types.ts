/** Runtime type contracts for mention-pattern matching helpers. */
import type { ResolveMentionPatternPolicyParams } from "../../channels/mention-pattern-policy.js";
import type {
  buildMentionRegexes,
  matchesMentionPatterns,
  matchesMentionWithExplicit,
} from "./mentions.js";

/** Options for building mention regexes without binding config/agent id. */
export type BuildMentionRegexesOptions = Omit<ResolveMentionPatternPolicyParams, "cfg" | "agentId">;

/** Builds mention regexes for the current config and agent. */
export type BuildMentionRegexes = typeof buildMentionRegexes;

/** Tests plain text against mention regexes. */
export type MatchesMentionPatterns = typeof matchesMentionPatterns;

/** Explicit mention metadata supplied by channel adapters. */
export type ExplicitMentionSignal = {
  hasAnyMention: boolean;
  isExplicitlyMentioned: boolean;
  canResolveExplicit: boolean;
};

/** Tests mention state using regexes plus explicit channel mention metadata. */
export type MatchesMentionWithExplicit = typeof matchesMentionWithExplicit;
