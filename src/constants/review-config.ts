export const REVIEW_TONES = ["friendly", "strict", "concise"] as const;
export type ReviewTone = (typeof REVIEW_TONES)[number];

export const SEVERITY_THRESHOLDS = ["balanced", "critical_only", "strict"] as const;
export type SeverityThreshold = (typeof SEVERITY_THRESHOLDS)[number];

export type ReviewAnalysisFocus = {
  security?: boolean;
  performance?: boolean;
  bugs?: boolean;
  codeStyle?: boolean;
};
