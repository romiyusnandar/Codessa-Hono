export type OsvQuery = { name: string; version: string; ecosystem: string };

export type OsvVulnSeverity = {
  type: string;
  score: string;
};

export type OsvVulnDetail = {
  id: string;
  summary?: string;
  details?: string;
  severity?: OsvVulnSeverity[];
  database_specific?: { severity?: string };
  aliases?: string[];
};

const OSV_BASE_URL = "https://api.osv.dev/v1";
const BATCH_CHUNK_SIZE = 100;

/**
 * Batch-queries OSV.dev for known vulnerabilities per package. Free, no API key.
 * Returns one vulnerability-ID array per input query, same order as `queries`.
 * Never throws — a failed chunk resolves to empty results for that chunk so one
 * bad batch doesn't take down the whole PR review.
 */
export async function queryBatch(queries: OsvQuery[]): Promise<string[][]> {
  if (queries.length === 0) return [];

  const results: string[][] = [];

  for (let i = 0; i < queries.length; i += BATCH_CHUNK_SIZE) {
    const chunk = queries.slice(i, i + BATCH_CHUNK_SIZE);

    try {
      const response = await fetch(`${OSV_BASE_URL}/querybatch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          queries: chunk.map((q) => ({ package: { name: q.name, ecosystem: q.ecosystem }, version: q.version })),
        }),
      });

      if (!response.ok) {
        console.warn(`OSV querybatch failed: ${response.status} ${await response.text()}`);
        results.push(...chunk.map(() => []));
        continue;
      }

      const data = (await response.json()) as { results?: { vulns?: { id: string }[] }[] };
      results.push(...(data.results ?? chunk.map(() => ({ vulns: [] }))).map((r) => (r.vulns ?? []).map((v) => v.id)));
    } catch (error) {
      console.warn("OSV querybatch request failed:", error);
      results.push(...chunk.map(() => []));
    }
  }

  return results;
}

export async function getVulnDetails(id: string): Promise<OsvVulnDetail | null> {
  try {
    const response = await fetch(`${OSV_BASE_URL}/vulns/${id}`);
    if (!response.ok) return null;
    return (await response.json()) as OsvVulnDetail;
  } catch (error) {
    console.warn(`Failed to fetch OSV vuln details for ${id}:`, error);
    return null;
  }
}
