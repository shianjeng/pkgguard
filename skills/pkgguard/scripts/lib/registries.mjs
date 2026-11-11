// Thin clients for the public registries pkgguard reads. Every function
// resolves to plain facts; judging them happens in check.mjs.
import { findPep440, resolveRange } from './versions.mjs';

const TIMEOUT_MS = 8000;
const USER_AGENT = 'pkgguard (+https://github.com/shianjeng/pkgguard)';

async function getJson(url, { fetchImpl = globalThis.fetch, method = 'GET', body, accept = 'application/json' } = {}) {
  const res = await fetchImpl(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { accept, 'user-agent': USER_AGENT, ...(body ? { 'content-type': 'application/json' } : {}) },
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

function installScripts(manifest) {
  const scripts = {};
  for (const hook of ['preinstall', 'install', 'postinstall']) {
    if (manifest.scripts?.[hook]) scripts[hook] = manifest.scripts[hook];
  }
  if (manifest.gypfile && !scripts.install) scripts.install = 'node-gyp rebuild';
  return scripts;
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
  const scripts = installScripts(manifest);

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
    previousScripts: previousManifest ? installScripts(previousManifest) : null,
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

function sdistOnly(files) {
  return files.length > 0 && !files.some((f) => f.packagetype === 'bdist_wheel');
}

export async function pypiFacts(name, requested, options) {
  const doc = await getJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, options);
  if (!doc) {
    // A project can be registered with no files left: the JSON API then 404s,
    // but the simple index still lists it. Saying "does not exist" would be wrong.
    let simple = null;
    try {
      simple = await getJson(`https://pypi.org/simple/${encodeURIComponent(name)}/`, { ...options, accept: 'application/vnd.pypi.simple.v1+json' });
    } catch {}
    return simple ? { exists: true, noFiles: true, name: simple.name ?? name } : { exists: false };
  }
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
  if (!released.length) return { exists: true, noFiles: true, name: doc.info.name };
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
    sdistOnly: sdistOnly(files),
    previousSdistOnly: index > 0 ? sdistOnly(releases[released[index - 1][0]]) : null,
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

const OSV_BATCH = 1000; // the most queries OSV accepts per querybatch request

// Advisory ids for many exact (ecosystem, name, version) triples, one request
// per thousand. Returns one array of ids per query, in order. Only ids come
// back from the batch endpoint, so callers classify by id (MAL- = malware).
const OSV_PARALLEL = 4; // a batch takes about two seconds; a 10,000-package lockfile in sequence would near the hook's 30 s

export async function osvBatch(queries, options) {
  const chunks = [];
  for (let i = 0; i < queries.length; i += OSV_BATCH) chunks.push(queries.slice(i, i + OSV_BATCH));
  const answers = new Array(chunks.length);
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const index = next++;
      const body = {
        queries: chunks[index].map(({ ecosystem, name, version }) => ({ package: { name, ecosystem: ecosystem === 'npm' ? 'npm' : 'PyPI' }, version })),
      };
      const data = await getJson('https://api.osv.dev/v1/querybatch', { ...options, method: 'POST', body });
      answers[index] = chunks[index].map((_, j) => (data?.results?.[j]?.vulns ?? []).map((v) => v.id));
    }
  };
  await Promise.all(Array.from({ length: Math.min(OSV_PARALLEL, chunks.length) }, worker));
  return answers.flat();
}

// A malware report, as opposed to an ordinary vulnerability: an OpenSSF
// malicious-packages id (MAL-), CWE-506 "Embedded Malicious Code", or a title
// that says the package itself carries malware. The word "malicious" alone is
// not enough: "Requests vulnerable to .netrc credentials leak via malicious
// URLs" is a bug in requests, not malware, and must not block it.
const MALWARE_TITLE =
  /^(malicious (code|package|version|release|module)s?|malware) in\b|\bembedded (malware|malicious)\b|\bis malware\b|\b(contains?|contained|containing|includes?|included|ships?|shipped|has|had|have) (a |an )?(malware|malicious (code|software|payload|script|crypto ?miner|dependency|version|release|package))\b/i;

export function isMalware(vuln) {
  return (
    vuln.id.startsWith('MAL-') ||
    (vuln.aliases ?? []).some((a) => a.startsWith('MAL-')) ||
    (vuln.database_specific?.cwe_ids ?? []).includes('CWE-506') ||
    MALWARE_TITLE.test(vuln.summary ?? '')
  );
}

export async function osvVulns(ecosystem, name, version, options) {
  const body = { package: { name, ecosystem: ecosystem === 'npm' ? 'npm' : 'PyPI' } };
  if (version) body.version = version;
  const data = await getJson('https://api.osv.dev/v1/query', { ...options, method: 'POST', body });
  return (data?.vulns ?? []).map((v) => ({
    id: v.id,
    summary: v.summary ?? '',
    aliases: v.aliases ?? [],
    malicious: isMalware(v),
  }));
}
