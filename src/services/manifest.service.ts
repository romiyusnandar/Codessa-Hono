import type { Octokit } from "octokit";

export type ManifestEcosystem = "npm" | "PyPI" | "Packagist" | "Go";

export type ManifestPackage = {
  name: string;
  version: string;
  ecosystem: ManifestEcosystem;
};

const MANIFEST_ECOSYSTEMS: Record<string, ManifestEcosystem> = {
  "package.json": "npm",
  "requirements.txt": "PyPI",
  "composer.json": "Packagist",
  "go.mod": "Go",
};

export function getManifestEcosystem(filename: string): ManifestEcosystem | null {
  const base = filename.split("/").pop() ?? filename;
  return MANIFEST_ECOSYSTEMS[base] ?? null;
}

/** Strips range operators (^, ~, >=, etc.) down to the first concrete version-like token. OSV needs an exact version. */
function cleanVersion(raw: string): string | null {
  const stripped = raw.trim().replace(/^[~^>=<\s]+/, "");
  const match = stripped.match(/^v?[0-9][0-9A-Za-z.\-+]*/);
  return match ? match[0] : null;
}

function parsePackageJson(content: string): ManifestPackage[] {
  const packages: ManifestPackage[] = [];
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(content);
  } catch {
    return packages;
  }

  for (const section of ["dependencies", "devDependencies"]) {
    const deps = json[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, rawVersion] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof rawVersion !== "string") continue;
      const version = cleanVersion(rawVersion);
      if (version) packages.push({ name, version, ecosystem: "npm" });
    }
  }

  return packages;
}

function parseComposerJson(content: string): ManifestPackage[] {
  const packages: ManifestPackage[] = [];
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(content);
  } catch {
    return packages;
  }

  for (const section of ["require", "require-dev"]) {
    const deps = json[section];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, rawVersion] of Object.entries(deps as Record<string, unknown>)) {
      // "php" and "ext-*" are platform requirements, not installable packages OSV can look up
      if (typeof rawVersion !== "string" || name === "php" || name.startsWith("ext-")) continue;
      const version = cleanVersion(rawVersion);
      if (version) packages.push({ name, version, ecosystem: "Packagist" });
    }
  }

  return packages;
}

function parseRequirementsTxt(content: string): ManifestPackage[] {
  const packages: ManifestPackage[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;

    // only handle exact pins (name==version); ranges/extras aren't a single resolvable version
    const match = trimmed.match(/^([A-Za-z0-9_.\-]+)(?:\[[^\]]*\])?\s*==\s*([A-Za-z0-9_.\-]+)/);
    if (match) packages.push({ name: match[1], version: match[2], ecosystem: "PyPI" });
  }

  return packages;
}

function parseGoMod(content: string): ManifestPackage[] {
  const packages: ManifestPackage[] = [];
  const lines: string[] = [];

  const requireBlock = content.match(/require\s*\(([\s\S]*?)\)/);
  if (requireBlock) {
    lines.push(...requireBlock[1].split("\n"));
  }
  for (const line of content.split("\n")) {
    const singleLine = line.trim().match(/^require\s+(\S+)\s+(v\S+)/);
    if (singleLine) lines.push(`${singleLine[1]} ${singleLine[2]}`);
  }

  for (const raw of lines) {
    const trimmed = raw.trim().replace(/\s*\/\/.*$/, "");
    if (!trimmed) continue;
    const match = trimmed.match(/^(\S+)\s+(v[0-9][^\s]*)/);
    if (match) packages.push({ name: match[1], version: match[2], ecosystem: "Go" });
  }

  return packages;
}

export function parseManifest(filename: string, content: string): ManifestPackage[] {
  switch (getManifestEcosystem(filename)) {
    case "npm":
      return parsePackageJson(content);
    case "Packagist":
      return parseComposerJson(content);
    case "PyPI":
      return parseRequirementsTxt(content);
    case "Go":
      return parseGoMod(content);
    default:
      return [];
  }
}

/** Fetches the full manifest content at `ref` — SCA scans the whole dependency list, not just the diff'd lines. */
export async function fetchManifestContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  path: string,
  ref: string
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) return null;
    return Buffer.from(data.content, "base64").toString("utf-8");
  } catch (error) {
    console.warn(`Failed to fetch manifest ${path}:`, error);
    return null;
  }
}
