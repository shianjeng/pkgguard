import { privateRegistry, scopeRegistries } from './npmrc.mjs';
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
  establishedDownloads: 50_000, // install scripts on a package this popular are expected, not alarming
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

function result(pkg, findings, extra = {}) {
  return { ...pkg, verdict: verdictOf(findings), findings, facts: null, ...extra };
}

// Packages whose source pkgguard cannot look up at all.
function unverifiable(pkg, registry) {
  const text =
    pkg.kind === 'external'
      ? `Installs from ${pkg.name}, outside the ${registry} registry. pkgguard cannot check code from URLs or git repositories; install it only if you trust that source.`
      : `The package name (${pkg.name}) is only known when the command runs, so pkgguard cannot check it. Install with explicit package names instead.`;
  return result(pkg, [{ level: 'warn', code: pkg.kind, text }]);
}

export async function checkPackage(pkg, { fetchImpl, now = Date.now(), registries = null } = {}) {
  const options = { fetchImpl };
  const { ecosystem, name } = pkg;
  const registry = REGISTRY[ecosystem];
  if (pkg.kind === 'external' || pkg.kind === 'computed') return unverifiable(pkg, registry);

  const findings = [];
  const add = (level, code, text) => findings.push({ level, code, text });

  const internal = ecosystem === 'npm' ? privateRegistry(name, registries) : null;
  if (internal) {
    add('info', 'private-registry', `${name.split('/')[0]} installs from ${internal} (set in .npmrc), so it was not checked against the public registry.`);
    return result(pkg, findings);
  }

  const [factsResult, downloadsResult] = await Promise.all([
    settle(ecosystem === 'npm' ? npmFacts(name, pkg.version ?? pkg.requested, options) : pypiFacts(name, pkg.version, options)),
    settle(ecosystem === 'npm' ? npmDownloads(name, options) : pypiDownloads(name, options)),
  ]);

  if (factsResult.error) {
    add('warn', 'unverified', `Could not reach ${registry} (${factsResult.error.message}); this package was not checked.`);
    return result(pkg, findings);
  }
  const facts = factsResult.value;
  const downloads = downloadsResult.error ? null : downloadsResult.value;
  const vulnsResult = await settle(osvVulns(ecosystem, name, facts.exists ? facts.version : null, options));
  const vulns = vulnsResult.value ?? [];
  const malicious = vulns.filter((v) => v.malicious);
  const similar = lookalike(ecosystem, name);

  // Missing data must be visible: a check that could not run is not a pass.
  if (vulnsResult.error) {
    add('warn', 'osv-unreachable', `Could not reach OSV (${vulnsResult.error.message}), so malware reports and known vulnerabilities were not checked.`);
  }
  if (downloadsResult.error) {
    add('info', 'downloads-unavailable', `Download counts were unavailable (${downloadsResult.error.message}), so popularity could not be checked.`);
  }

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
    return result(pkg, findings, { facts: { exists: false, downloads }, suggestion: similar?.name ?? null });
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
        (downloads === null
          ? '. Download counts were unavailable, so a typosquat could not be ruled out.'
          : `, but has only ${downloads.toLocaleString('en-US')} downloads last week. Possible typosquat.`),
    );
  }

  const ageDays = facts.created ? (now - Date.parse(facts.created)) / DAY : null;
  const isNew = ageDays !== null && ageDays < LIMITS.newPackageDays;
  const hasScripts = ecosystem === 'npm' && Object.keys(facts.scripts).length > 0;
  if (isNew) {
    const brandNew = ageDays < LIMITS.brandNewDays;
    add(
      brandNew && hasScripts ? 'block' : 'warn',
      'new',
      `First published ${ago(facts.created, now)}${brandNew && hasScripts ? ' and runs code at install time' : ''}.`,
    );
  }

  // A fresh release alone is routine (some packages ship daily). It is worth a
  // warning when it also changed who published it or what runs at install.
  const scriptsAdded = hasScripts && facts.previousScripts != null && Object.keys(facts.previousScripts).length === 0;
  const wheelDropped = ecosystem === 'pypi' && facts.sdistOnly && facts.previousSdistOnly === false;
  const provenanceDropped = ecosystem === 'npm' && facts.previousProvenance && !facts.provenance;
  const publisherChanged = Boolean(facts.publisher && facts.previousPublisher && facts.publisher !== facts.previousPublisher);
  const releaseHours = facts.versionTime ? (now - Date.parse(facts.versionTime)) / HOUR : null;
  const fresh = releaseHours !== null && releaseHours < LIMITS.freshReleaseHours && facts.previous;
  if (fresh) {
    const signals = [
      publisherChanged && `it was published by "${facts.publisher}", the previous version by "${facts.previousPublisher}"`,
      provenanceDropped && `${facts.previous} had build provenance and this version does not`,
      scriptsAdded && 'it adds install scripts the previous version did not have',
      wheelDropped && `${facts.previous} shipped wheels and this version only builds from source`,
    ].filter(Boolean);
    const when = `${facts.version} was published ${ago(facts.versionTime, now)}`;
    if (signals.length) {
      add(
        'warn',
        'fresh',
        `${when}, and ${signals.join('; ')}. Hijacked releases look like this; consider ${name}@${facts.previous} until this one has been out a few days.`,
      );
    } else {
      add('info', 'fresh', `${when}; same publisher and provenance as ${facts.previous}, and no new install scripts.`);
    }
  } else if (provenanceDropped) {
    add('info', 'provenance', `${facts.previous} was published with build provenance but ${facts.version} was not.`);
  }

  if (hasScripts) {
    const shown = Object.entries(facts.scripts)
      .map(([hook, script]) => `${hook}: ${script.length > 120 ? `${script.slice(0, 117)}...` : script}`)
      .join('; ');
    // Long-standing scripts on a widely used package (esbuild, sharp) are expected;
    // warning on every install would only teach people to click yes.
    const established = !isNew && !scriptsAdded && downloads !== null && downloads >= LIMITS.establishedDownloads;
    if (established) add('info', 'install-script', `Runs code during install (${shown}), as earlier versions did.`);
    else add('warn', 'install-script', `Runs code during install (${shown}).`);
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

  if (downloads !== null && downloads < LIMITS.fewDownloads && !findings.some((f) => f.code === 'lookalike')) {
    add('warn', 'unpopular', `Only ${downloads} downloads last week.`);
  }
  if (!facts.repository) add('info', 'no-repo', 'No source repository listed.');

  return result(pkg, findings, {
    version: pkg.version && !facts.requestedExists ? pkg.version : facts.version,
    facts: { ...facts, downloads },
    suggestion: similar && findings.some((f) => f.code === 'lookalike') ? similar.name : null,
  });
}

export async function checkAll(packages, { cwd = process.cwd(), env = process.env, ...options } = {}) {
  const registries = options.registries ?? scopeRegistries(cwd, env);
  return Promise.all(packages.map((pkg) => checkPackage(pkg, { ...options, registries })));
}
