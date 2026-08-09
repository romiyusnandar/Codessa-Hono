import type { Octokit } from "octokit";
import type { PullRequestFile } from "./github.service.js";
import { getManifestEcosystem, parseManifest, fetchManifestContent, type ManifestPackage } from "./manifest.service.js";
import { queryBatch, getVulnDetails } from "./osv.service.js";
import { computeCvssScore, cvssScoreToSeverity, type CvssResult } from "../utils/cvss.js";
import { getPatchLineContents } from "../utils/diff.js";

export type ScaFinding = {
  file: string;
  line: number | null;
  severity: "info" | "minor" | "major" | "critical";
  comment: string;
  vulnerabilityId: string;
  cvss: CvssResult | null;
};

const DB_SEVERITY_FALLBACK: Record<string, ScaFinding["severity"]> = {
  CRITICAL: "critical",
  HIGH: "major",
  MODERATE: "minor",
  MEDIUM: "minor",
  LOW: "info",
};

/**
 * Layer 1 (SCA): scans manifest files changed in the PR against OSV.dev's vulnerability
 * database. Deterministic — CVE/severity data comes straight from OSV, nothing is
 * computed or judged by an LLM here.
 */
export async function scanDependencies(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  files: PullRequestFile[]
): Promise<ScaFinding[]> {
  const manifestFiles = files.filter((f) => f.status !== "removed" && getManifestEcosystem(f.filename) !== null);
  if (manifestFiles.length === 0) return [];

  const allPackages: (ManifestPackage & { file: string })[] = [];
  for (const file of manifestFiles) {
    const content = await fetchManifestContent(octokit, owner, repo, file.filename, ref);
    if (!content) continue;
    for (const pkg of parseManifest(file.filename, content)) {
      allPackages.push({ ...pkg, file: file.filename });
    }
  }
  if (allPackages.length === 0) return [];

  const vulnIdLists = await queryBatch(allPackages);

  const uniqueIds = [...new Set(vulnIdLists.flat())];
  const detailsById = new Map<string, Awaited<ReturnType<typeof getVulnDetails>>>();
  await Promise.all(uniqueIds.map(async (id) => detailsById.set(id, await getVulnDetails(id))));

  const lineContentsByFile = new Map(
    manifestFiles.map((f) => [f.filename, f.patch ? getPatchLineContents(f.patch) : new Map<number, string>()])
  );

  const findings: ScaFinding[] = [];

  allPackages.forEach((pkg, i) => {
    for (const vulnId of vulnIdLists[i] ?? []) {
      const detail = detailsById.get(vulnId);
      const cvssVector = detail?.severity?.find((s) => s.type === "CVSS_V4")?.score ?? detail?.severity?.find((s) => s.type === "CVSS_V3")?.score;
      const cvss = computeCvssScore(cvssVector);
      const severity = cvss
        ? cvssScoreToSeverity(cvss.score)
        : DB_SEVERITY_FALLBACK[detail?.database_specific?.severity?.toUpperCase() ?? ""] ?? "minor";

      const cveAlias = detail?.aliases?.find((a) => a.startsWith("CVE-"));
      const displayId = cveAlias ?? vulnId;
      const title = detail?.summary ?? detail?.details?.slice(0, 200) ?? "Known vulnerability in this dependency version.";

      findings.push({
        file: pkg.file,
        line: findLineForPackage(lineContentsByFile.get(pkg.file) ?? new Map(), pkg.name),
        severity,
        comment: `\`${pkg.name}@${pkg.version}\` is affected by **${displayId}**${cvss ? ` (CVSS ${cvss.score.toFixed(1)})` : ""}: ${title} — https://osv.dev/vulnerability/${vulnId}`,
        vulnerabilityId: displayId,
        cvss,
      });
    }
  });

  return findings;
}

function findLineForPackage(lineContents: Map<number, string>, packageName: string): number | null {
  for (const [line, content] of lineContents) {
    if (content.includes(packageName)) return line;
  }
  return null;
}
