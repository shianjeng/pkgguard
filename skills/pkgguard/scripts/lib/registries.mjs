// Thin clients for the public registries pkgguard reads. Every function
// resolves to plain facts; judging them happens in check.mjs.
import { findPep440, resolveRange } from './versions.mjs';

const TIMEOUT_MS = 8000;
const USER_AGENT = 'pkgguard (+https://github.com/shianjeng/pkgguard)';

async function getJson(url, { fetchImpl = globalThis.fetch, method = 'GET', body } = {}) {
  const res = await fetchImpl(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { accept: 'application/json', 'user-agent': USER_AGENT, ...(body ? { 'content-type': 'application/json' } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw Object.assign(new Error(`${new URL(url).host} answered ${res.status}`), { status: res.status });
  return res.json();
}

function encodeNpm(name) {
  return name.startsWith('@') ? `@${encodeURIComponent(name.slice(1))}` : encodeURIComponent(name);
}

function repoUrl(value) {
  const url = typeof value === 'string' ? value : value?.url;
  return url ? url.replace(/^git\+/, '').replace(/\.git$/, '') : null;
}

export async function npmFacts(name, requested, options) {
  const doc = await getJson(`https://registry.npmjs.org/${encodeNpm(name)}`, options);
  if (!doc) return { exists: false };
  const tags = doc['dist-tags'] ?? {};
  const time = doc.time ?? {};
  const versions = Object.keys(doc.versions ?? {});
  if (!versions.length) return { exists: false, unpublished: Boolean(time.unpublished) };
  let version = tags.latest ?? versions.at(-1);
  let requestedExists = true;
  if (requested) {
    if (doc.versions[requested]) version = requested;
    else if (tags[requested]) version = tags[requested];
    else {
      const resolved = resolveRange(versions, requested, tags.latest);
      if (resolved) version = resolved;
      else requestedExists = false;
    }
  }
  const manifest = doc.versions?.[version] ?? {};
  const byTime = versions.filter((v) => time[v]).sort((a, b) => Date.parse(time[a]) - Date.parse(time[b]));
  const previous = byTime[byTime.indexOf(version) - 1] ?? null;
  const previousManifest = previous ? doc.versions[previous] : null;
  const scripts = {};
  for (const hook of ['preinstall', 'install', 'postinstall']) {
    if (manifest.scripts?.[hook]) scripts[hook] = manifest.scripts[hook];
  }
  if (manifest.gypfile && !scripts.install) scripts.install = 'node-gyp rebuild';

  return {
    exists: true,
    name: doc.name ?? name,
    latest: tags.latest ?? null,
    version,
    versionExists: Boolean(doc.versions?.[version]),
    requestedExists,
    versionCount: versions.length,
    created: time.created ?? null,
    versionTime: time[version] ?? null,
    previous,
    previousTime: previous ? time[previous] : null,
    publisher: manifest._npmUser?.name ?? null,
    previousPublisher: previousManifest?._npmUser?.name ?? null,
    provenance: Boolean(manifest.dist?.attestations),
    previousProvenance: Boolean(previousManifest?.dist?.attestations),
    scripts,
    deprecated: manifest.deprecated ?? null,
    description: manifest.description ?? doc.description ?? '',
    repository: repoUrl(manifest.repository ?? doc.repository),
    maintainers: (doc.maintainers ?? []).length,
    securityHolder: /-security$/.test(version ?? '') || /security holding package/i.test(doc.description ?? ''),
  };
}

export async function npmDownloads(name, options) {
  const data = await getJson(`https://api.npmjs.org/downloads/point/last-week/${encodeNpm(name)}`, options);
  return data?.downloads ?? 0;
}

export async function pypiFacts(name, requested, options) {
  const doc = await getJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, options);
  if (!doc) return { exists: false };
  const releases = doc.releases ?? {};
  const earliest = (files) =>
    files.reduce((min, f) => {
      const t = f.upload_time_iso_8601 ?? f.upload_time;
      return t && (!min || Date.parse(t) < Date.parse(min)) ? t : min;
    }, null);
  const released = Object.entries(releases)
    .filter(([, files]) => files.length)
    .map(([v, files]) => [v, earliest(files)])
    .sort((a, b) => Date.parse(a[1]) - Date.parse(b[1]));
  const match = requested ? findPep440(Object.keys(releases), requested) : null;
  const version = match ?? doc.info.version;
  const files = releases[version] ?? [];
  const index = released.findIndex(([v]) => v === version);
  const urls = doc.info.project_urls ?? {};
  const repository =
    Object.entries(urls).find(([k]) => /source|repo|github|gitlab|code/i.test(k))?.[1] ??
    (/github|gitlab|codeberg|bitbucket/.test(doc.info.home_page ?? '') ? doc.info.home_page : null);

  return {
    exists: true,
    name: doc.info.name,
    latest: doc.info.version,
    version,
    versionExists: Boolean(releases[version]?.length),
    requestedExists: !requested || Boolean(match && releases[match].length),
    versionCount: released.length,
    created: released[0]?.[1] ?? null,
    versionTime: earliest(files),
    previous: index > 0 ? released[index - 1][0] : null,
    previousTime: index > 0 ? released[index - 1][1] : null,
    sdistOnly: files.length > 0 && !files.some((f) => f.packagetype === 'bdist_wheel'),
    yanked: files.length > 0 && files.every((f) => f.yanked),
    yankedReason: files.find((f) => f.yanked_reason)?.yanked_reason ?? null,
    description: doc.info.summary ?? '',
    repository,
  };
}

export async function pypiDownloads(name, options) {
  const data = await getJson(`https://pypistats.org/api/packages/${encodeURIComponent(name)}/recent`, options);
  return data?.data?.last_week ?? 0;
}

export async function osvVulns(ecosystem, name, version, options) {
  const body = { package: { name, ecosystem: ecosystem === 'npm' ? 'npm' : 'PyPI' } };
  if (version) body.version = version;
  const data = await getJson('https://api.osv.dev/v1/query', { ...options, method: 'POST', body });
  return (data?.vulns ?? []).map((v) => ({
    id: v.id,
    summary: v.summary ?? '',
    aliases: v.aliases ?? [],
    malicious:
      v.id.startsWith('MAL-') ||
      (v.aliases ?? []).some((a) => a.startsWith('MAL-')) ||
      /\b(malware|malicious)\b/i.test(v.summary ?? '') ||
      (v.database_specific?.cwe_ids ?? []).includes('CWE-506'),
  }));
}
