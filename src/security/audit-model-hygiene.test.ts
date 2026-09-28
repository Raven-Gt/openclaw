// Covers model hygiene audit findings and provider routing risks.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { collectModelHygieneFindings } from "./audit-extra.sync.js";

describe("security audit model hygiene findings", () => {
  it("classifies legacy and weak-tier model identifiers", () => {
    const cases: Array<{
      name: string;
      cfg: OpenClawConfig;
      expectedPresent?: Array<{ checkId: string; severity: "warn" }>;
      expectedAbsentCheckId?: string;
    }> = [
      {
        name: "legacy model",
        cfg: {
          agents: { defaults: { model: { primary: "openai/gpt-3.5-turbo" } } },
        },
        expectedPresent: [{ checkId: "models.legacy", severity: "warn" }],
      },
      {
        name: "weak-tier model",
        cfg: {
          agents: { defaults: { model: { primary: "anthropic/claude-haiku-4-5" } } },
        },
        expectedPresent: [{ checkId: "models.weak_tier", severity: "warn" }],
      },
      {
        name: "venice opus-45",
        cfg: {
          agents: { defaults: { model: { primary: "venice/claude-opus-45" } } },
        },
        expectedAbsentCheckId: "models.weak_tier",
      },
    ];

    for (const testCase of cases) {
      const findings = collectModelHygieneFindings(testCase.cfg);
      for (const expected of testCase.expectedPresent ?? []) {
        expect(
          findings.some(
            (finding) =>
              finding.checkId === expected.checkId && finding.severity === expected.severity,
          ),
          testCase.name,
        ).toBe(true);
      }
      if (testCase.expectedAbsentCheckId) {
        expect(
          findings.some((finding) => finding.checkId === testCase.expectedAbsentCheckId),
          testCase.name,
        ).toBe(false);
      }
    }
  });

  it.each([
    "gpt-3.5-turbo",
    "azure-openai/gpt-35-turbo",
    "azure-openai/GPT-35-TURBO-16k",
    "openai/ft:gpt-4o-mini:example:suffix:abc123",
    "ft:gpt-3.5-turbo-0125:example::abc123",
    "openai/gpt-4",
    "openai/gpt-4-turbo",
    "openai/gpt-4-0613",
    "openai/gpt-4.1-mini",
    "openai/gpt-4o",
    "openrouter/openai/gpt-4o-2024-08-06",
    "custom/GPT-4O-mini",
    "openrouter/openai/gpt-4:extended",
  ])("warns about an older GPT version: %s", (model) => {
    const findings = collectModelHygieneFindings({
      agents: { defaults: { model: { primary: model } } },
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "models.weak_tier",
        severity: "warn",
        detail: expect.stringContaining("Below GPT-5 family"),
      }),
    );
  });

  it.each([
    "gpt-5",
    "openai/gpt-5-mini",
    "openai/gpt-5.1",
    "openai/gpt-5.2-codex",
    "openai/gpt-5-chat-latest",
    "openrouter/openai/gpt-5-2025-08-07",
    // Higher versions are synthetic fixtures, not assertions of model availability or safety.
    "gpt-6-example",
    "custom/GPT-6.1-example",
    "openrouter/openai/gpt-10-example:free",
    "custom/gpt-12.3-example@20260901",
    "custom/gpt-35-example",
    "custom/gpt-35-turboish",
    "openai/ft:gpt-6-example:example:suffix:abc123",
  ])("does not label GPT-5 or a later version as older: %s", (model) => {
    const findings = collectModelHygieneFindings({
      agents: { defaults: { model: { primary: model } } },
    });

    expect(findings.map((finding) => finding.checkId)).not.toContain("models.weak_tier");
  });

  it.each([
    "custom/unknown-model",
    "custom/gpt-example",
    "custom/ft:gpt-example:example:suffix:abc123",
    "custom/gpt-",
    "custom/gpt-4unknown",
    "custom/gpt-4.x",
    "custom/gpt-oss-20b",
    "custom/gpt-image-1",
    "custom/gpt-realtime",
    "gpt-4-provider/unknown-model",
    "custom/not-gpt-4",
  ])("does not infer an old GPT version from an unknown name: %s", (model) => {
    const findings = collectModelHygieneFindings({
      agents: { defaults: { model: { primary: model } } },
    });

    expect(findings.map((finding) => finding.checkId)).not.toContain("models.weak_tier");
  });

  it("keeps legacy and other tier warnings alongside a higher GPT version", () => {
    const findings = collectModelHygieneFindings({
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-6-example",
            fallbacks: ["openai/gpt-4o"],
          },
        },
        entries: {
          legacy: {
            model: {
              primary: "openai/gpt-4-0613",
              fallbacks: ["anthropic/claude-haiku-4-5"],
            },
          },
        },
      },
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "models.legacy",
        severity: "warn",
        detail: expect.stringContaining("Legacy GPT-4 snapshots"),
      }),
    );
    const weakTier = findings.find((finding) => finding.checkId === "models.weak_tier");
    expect(weakTier?.severity).toBe("warn");
    expect(weakTier?.detail).toContain(
      "openai/gpt-4o (Below GPT-5 family) @ agents.defaults.model.fallbacks",
    );
    expect(weakTier?.detail).toContain(
      "openai/gpt-4-0613 (Below GPT-5 family) @ agents.entries.legacy.model.primary",
    );
    expect(weakTier?.detail).toContain("Haiku tier (smaller model)");
    expect(weakTier?.detail).not.toContain("gpt-6-example");
  });

  it("resolves configured aliases before tier classification", () => {
    const findings = collectModelHygieneFindings({
      agents: {
        defaults: {
          model: {
            primary: "gpt",
            fallbacks: ["gpt-prev", "gpt-mini", "gpt-future"],
          },
          models: {
            "openai/gpt-5.5": { alias: "gpt" },
            "openai/gpt-5.4": { alias: "gpt-prev" },
            "openai/gpt-5-mini": { alias: "gpt-mini" },
            "openai/gpt-6-example": { alias: "gpt-future" },
          },
        },
      },
    } satisfies OpenClawConfig);

    expect(findings.map((finding) => finding.checkId)).not.toContain("models.weak_tier");
  });
});
