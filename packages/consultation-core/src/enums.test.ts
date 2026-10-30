import { describe, expect, it } from "bun:test";
import {
  ClaimKindSchema,
  ConfidenceSchema,
  ConsultationModeInputSchema,
  ConsultationModeSchema,
  CritiqueProtocolSchema,
  normalizeConsultationMode,
  RiskLevelSchema,
  SourceGradeSchema,
  StabilitySchema,
  TierSchema,
} from "./enums";

describe("enums", () => {
  it("ClaimKindSchema has the five epistemic kinds", () => {
    // given // when // then
    expect(ClaimKindSchema.options).toEqual([
      "fact",
      "causal",
      "experiential",
      "prediction",
      "preference",
    ]);
  });

  it("RiskLevelSchema has low/medium/high", () => {
    // given // when // then
    expect(RiskLevelSchema.options).toEqual(["low", "medium", "high"]);
  });

  it("TierSchema has fast/standard/deep", () => {
    // given // when // then
    expect(TierSchema.options).toEqual(["fast", "standard", "deep"]);
  });

  it("SourceGradeSchema has high/medium/low/lead_only", () => {
    // given // when // then
    expect(SourceGradeSchema.options).toEqual(["high", "medium", "low", "lead_only"]);
  });

  it("ConfidenceSchema has high/medium/low", () => {
    // given // when // then
    expect(ConfidenceSchema.options).toEqual(["high", "medium", "low"]);
  });

  it("StabilitySchema has stable/conditional/provisional", () => {
    // given // when // then
    expect(StabilitySchema.options).toEqual(["stable", "conditional", "provisional"]);
  });

  it("ConsultationModeSchema has the seven public modes", () => {
    // given // when // then
    expect(ConsultationModeSchema.options).toEqual([
      "select",
      "verify",
      "roadmap",
      "research",
      "guide",
      "doc",
      "design",
    ]);
  });

  it("normalizes the legacy plan/author mode names", () => {
    expect(ConsultationModeInputSchema.parse("plan")).toBe("roadmap")
    expect(ConsultationModeInputSchema.parse("author")).toBe("doc")
    expect(ConsultationModeInputSchema.parse("roadmap")).toBe("roadmap")
    expect(ConsultationModeInputSchema.parse("doc")).toBe("doc")
    expect(normalizeConsultationMode("plan")).toBe("roadmap")
    expect(normalizeConsultationMode("author")).toBe("doc")
    expect(normalizeConsultationMode("nope")).toBeUndefined()
  });

  it("CritiqueProtocolSchema exposes the five methodology protocols", () => {
    expect(CritiqueProtocolSchema.options).toEqual([
      "counter_evidence",
      "hypothesis_matrix",
      "plan_robustness",
      "design_premortem",
      "code_plan_review",
    ]);
  });
});
