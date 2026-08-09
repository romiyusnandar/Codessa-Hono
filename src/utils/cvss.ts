import { CVSS40 } from "./cvss40-vendor.js";

export type CvssResult = {
  score: number;
  rating: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "NONE";
  vector: string;
};

/**
 * CVSS 3.0/3.1 Base Score: native implementation of FIRST's formula
 * (https://www.first.org/cvss/v3.1/specification-document, section 7.1).
 * CVSS 4.0: uses the vendored, packaging-fixed @pandatix/js-cvss logic — see
 * cvss40-vendor.ts for why it's vendored instead of depended on directly.
 */

const AV_WEIGHTS: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const AC_WEIGHTS: Record<string, number> = { L: 0.77, H: 0.44 };
const PR_WEIGHTS_UNCHANGED: Record<string, number> = { N: 0.85, L: 0.62, H: 0.27 };
const PR_WEIGHTS_CHANGED: Record<string, number> = { N: 0.85, L: 0.68, H: 0.5 };
const UI_WEIGHTS: Record<string, number> = { N: 0.85, R: 0.62 };
const CIA_WEIGHTS: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

const REQUIRED_METRICS = ["AV", "AC", "PR", "UI", "S", "C", "I", "A"] as const;

function parseVector(vector: string): Record<string, string> | null {
  const parts = vector.split("/");
  const metrics: Record<string, string> = {};

  for (const part of parts) {
    if (part.startsWith("CVSS:")) continue;
    const [key, value] = part.split(":");
    if (!key || !value) continue;
    metrics[key] = value;
  }

  for (const key of REQUIRED_METRICS) {
    if (!metrics[key]) return null;
  }

  return metrics;
}

/** CVSS spec's own roundup: round up to the nearest 0.1, avoiding float error. */
function roundup(value: number): number {
  const intInput = Math.round(value * 100000);
  if (intInput % 10000 === 0) {
    return intInput / 100000;
  }
  return (Math.floor(intInput / 10000) + 1) / 10;
}

function scoreV31(metrics: Record<string, string>): number | null {
  const av = AV_WEIGHTS[metrics.AV];
  const ac = AC_WEIGHTS[metrics.AC];
  const ui = UI_WEIGHTS[metrics.UI];
  const c = CIA_WEIGHTS[metrics.C];
  const i = CIA_WEIGHTS[metrics.I];
  const a = CIA_WEIGHTS[metrics.A];
  const scopeChanged = metrics.S === "C";
  const pr = (scopeChanged ? PR_WEIGHTS_CHANGED : PR_WEIGHTS_UNCHANGED)[metrics.PR];

  if ([av, ac, ui, c, i, a, pr].some((v) => v === undefined)) return null;

  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = scopeChanged ? 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15) : 6.42 * iss;
  const exploitability = 8.22 * av * ac * pr * ui;

  if (impact <= 0) return 0;

  const base = scopeChanged ? 1.08 * (impact + exploitability) : impact + exploitability;
  return roundup(Math.min(base, 10));
}

function ratingFor(score: number): CvssResult["rating"] {
  if (score === 0) return "NONE";
  if (score < 4.0) return "LOW";
  if (score < 7.0) return "MEDIUM";
  if (score < 9.0) return "HIGH";
  return "CRITICAL";
}

function ratingFor40(score: number): CvssResult["rating"] {
  try {
    return CVSS40.Rating(score);
  } catch {
    return "NONE";
  }
}

/**
 * Computes a numeric CVSS score from a vector string using the official FIRST formulas
 * rather than trusting any score a caller (e.g. an LLM) might report itself. Supports
 * CVSS 3.0, 3.1, and 4.0. Returns null for malformed/unrecognized vectors — callers
 * should treat that as "no reliable score", not throw.
 */
export function computeCvssScore(vector: string | null | undefined): CvssResult | null {
  const trimmed = vector?.trim();
  if (!trimmed) return null;

  if (trimmed.startsWith("CVSS:4.0")) {
    try {
      const cvss = new CVSS40(trimmed);
      const score = cvss.Score();
      return { score, rating: ratingFor40(score), vector: trimmed };
    } catch {
      return null;
    }
  }

  if (!trimmed.startsWith("CVSS:3.0") && !trimmed.startsWith("CVSS:3.1")) return null;

  const metrics = parseVector(trimmed);
  if (!metrics) return null;

  const score = scoreV31(metrics);
  if (score === null) return null;

  return { score, rating: ratingFor(score), vector: trimmed };
}

/** Maps a CVSS score to this project's ReviewComment severity scale. */
export function cvssScoreToSeverity(score: number): "info" | "minor" | "major" | "critical" {
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "major";
  if (score >= 4.0) return "minor";
  return "info";
}
