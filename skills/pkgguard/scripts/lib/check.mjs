import { npmDownloads, npmFacts, osvVulns, pypiDownloads, pypiFacts } from './registries.mjs';
import { lookalike } from './similar.mjs';

const DAY = 86_400_000;
const HOUR = 3_600_000;

export const LIMITS = {
  newPackageDays: 30, // a first release this recent is "new"
  brandNewDays: 7, // ...and this recent is "brand new"
  freshReleaseHours: 72, // a version this recent has had little time to be vetted
  fewDownloads: 100, // weekly downloads below this are "very few"
  lookalikeSafeDownloads: 50_000, // a lookalike this popular is probably legitimate
  lookalikeBlockDownloads: 1_000, // a lookalike this unpopular is probably a typosquat
};

const RANK = { ok: 0, info: 1, warn: 2, block: 3 };
const REGISTRY = { npm: 'npm', pypi: 'PyPI' };

function ago(iso, now) {
  const ms = now - Date.parse(iso);
  if (ms < 2 * DAY) {
    const hours = Math.max(1, Math.round(ms / HOUR));
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }
  return `${Math.round(ms / DAY)} days ago`;
}

export function verdictOf(findings) {
  return findings.reduce((worst, f) => (RANK[f.level] > RANK[worst] ? f.level : worst), 'ok');
}

async function settle(promise) {
  try {
    return { value: await promise };
  } catch (error) {
    return { error };
  }
}

export async function checkPackage(pkg, { fetchImpl, now = Date.now() } = {}) {
  const options = { fetchImpl };
  const { ecosystem, name } = pkg;
  const registry = REGISTRY[ecosystem];
  const findings = [];
  const add = (level, code, text) => findings.push({ level, code, text });

  const [factsResult, downloadsResult] = await Promise.all([
    settle(ecosystem === 'npm' ? npmFacts(name, pkg.version ?? pkg.requested, options) : pypiFacts(name, pkg.version, options)),
    settle(ecosystem === 'npm' ? npmDownloads(name, options) : pypiDownloads(name, options)),
  ]);

  if (factsResult.error) {
    add('warn', 'unverified', `Could not reach ${registry} (${factsResult.error.message}); this package was not checked.`);
    return { ...pkg, verdict: verdictOf(findings), findings, facts: null };
  }
  const facts = factsResult.value;
  const downloads = downloadsResult.error ? null : downloadsResult.value;
  const vulnsResult = await settle(osvVulns(ecosystem, name, facts.exists ? facts.version : null, options));
  const vulns = vulnsResult.value ?? [];
  const malicious = vulns.filter((v) => v.malicious);
  const similar = lookalike(ecosystem, name);

  if (malicious.length) {
    add('block', 'malicious', `Reported as malicious: ${malicious.map((v) => `${v.id} (${v.summary || 'no summary'})`).join('; ')}.`);
  }

  if (!facts.exists) {
    add(
      'block',
      'missing',
      (facts.unpublished
        ? `"${name}" was unpublished from ${registry} and has no versions to install.`
        : `"${name}" does not exist on ${registry}. The name may be hallucinated, or the package lives on a private registry.`) +
        (similar ? ` Did you mean "${similar.name}"?` : ''),
    );
    return { ...pkg, verdict: verdictOf(findings), findings, facts: { exists: false, downloads }, suggestion: similar?.name ?? null };
  }

  if (facts.securityHolder) {
    add('block', 'removed', `${registry} replaced this package with a security placeholder, which usually means it was malware.`);
  }
  if (pkg.version && !facts.requestedExists) {
    add('block', 'missing-version', `Version ${pkg.version} does not exist (latest is ${facts.latest}).`);
  } else if (pkg.requested && !facts.requestedExists) {
    add('warn', 'no-match', `No published version matches "${pkg.requested}", so the install will fail. Checked ${facts.latest} instead.`);
  }

  if (similar && (downloads === null || downloads < LIMITS.lookalikeSafeDownloads)) {
    const level = downloads !== null && downloads < LIMITS.lookalikeBlockDownloads ? 'block' : 'warn';
    add(
      level,
      'lookalike',
      `Looks like the popular package "${similar.name}" (${similar.reason})` +
        (downloads !== null ? `, but has only ${downloads.toLocaleString('en-US')} downloads last week` : '') +
        `. Possible typosquat.`,
    );
  }

  const ageDays = facts.created ? (now - Date.parse(facts.created)) / DAY : null;
  const hasScripts = ecosystem === 'npm' && Object.keys(facts.scripts).length > 0;
  if (ageDays !== null && ageDays < LIMITS.newPackageDays) {
    const brandNew = ageDays < LIMITS.brandNewDays;
    add(
      brandNew && hasScripts ? 'block' : 'warn',
      'new',
      `First published ${ago(facts.created, now)}${brandNew && hasScripts ? ' and runs code at install time' : ''}.`,
    );
  }

  const releaseHours = facts.versionTime ? (now - Date.parse(facts.versionTime)) / HOUR : null;
  if (releaseHours !== null && releaseHours < LIMITS.freshReleaseHours && facts.previous) {
    let text = `${facts.version} was published ${ago(facts.versionTime, now)}. Fresh releases are how hijacked packages spread; consider ${name}@${facts.previous} until this one has been out a few days.`;
    if (facts.publisher && facts.previousPublisher && facts.publisher !== facts.previousPublisher) {
      text += ` It was published by "${facts.publisher}", the previous version by "${facts.previousPublisher}".`;
    }
    add('warn', 'fresh', text);
  }
  if (ecosystem === 'npm' && facts.previousProvenance && !facts.provenance) {
    add('warn', 'provenance', `${facts.previous} was published with build provenance but ${facts.version} was not.`);
  }

  if (hasScripts) {
    const shown = Object.entries(facts.scripts)
      .map(([hook, script]) => `${hook}: ${script.length > 120 ? `${script.slice(0, 117)}...` : script}`)
      .join('; ');
    add('warn', 'install-script', `Runs code during install (${shown}).`);
  }
  if (ecosystem === 'pypi' && facts.sdistOnly) {
    add('warn', 'sdist-only', `No wheel for ${facts.version}; installing it runs the package's build code (setup.py).`);
  }
  if (ecosystem === 'pypi' && facts.yanked) {
    add('warn', 'yanked', `${facts.version} was yanked${facts.yankedReason ? `: ${facts.yankedReason}` : ''}.`);
  }
  if (facts.deprecated) add('warn', 'deprecated', `Deprecated: ${facts.deprecated}`);

  const known = vulns.filter((v) => !v.malicious);
  if (known.length) {
    const listed = known.slice(0, 3).map((v) => `${v.id}${v.summary ? ` (${v.summary})` : ''}`).join('; ');
    add('warn', 'vulnerable', `${known.length} known vulnerabilit${known.length === 1 ? 'y' : 'ies'} in ${facts.version}: ${listed}${known.length > 3 ? '; ...' : ''}.`);
  }
  if (vulnsResult.error) add('info', 'osv-unreachable', `Could not reach OSV (${vulnsResult.error.message}); vulnerability data missing.`);

  if (downloads !== null && downloads < LIMITS.fewDownloads && !findings.some((f) => f.code === 'lookalike')) {
    add('warn', 'unpopular', `Only ${downloads} downloads last week.`);
  }
  if (!facts.repository) add('info', 'no-repo', 'No source repository listed.');

  return {
    ...pkg,
    version: pkg.version && !facts.requestedExists ? pkg.version : facts.version,
    verdict: verdictOf(findings),
    findings,
    facts: { ...facts, downloads },
    suggestion: similar && findings.some((f) => f.code === 'lookalike') ? similar.name : null,
  };
}

export async function checkAll(packages, options) {
  return Promise.all(packages.map((pkg) => checkPackage(pkg, options)));
}
