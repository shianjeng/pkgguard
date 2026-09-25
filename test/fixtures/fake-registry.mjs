// A stand-in for npm, PyPI, pypistats and OSV. Tests describe packages; this
// turns them into the JSON each registry would return.
const DAY = 86_400_000;

export const NOW = Date.parse('2026-09-25T12:00:00Z');
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();

export const PACKAGES = {
  npm: {
    lodash: { created: 5000, versions: { '4.17.20': 400, '4.17.21': 300 }, downloads: 50_000_000, repo: true },
    expresss: { created: 3000, versions: { '0.0.0': 3000 }, downloads: 400, repo: false },
    'left-pad': { created: 3500, versions: { '1.3.0': 2500 }, downloads: 2_000_000, repo: true, deprecated: 'use String.prototype.padStart()' },
    'shiny-new-cli': { created: 2, versions: { '0.1.0': 2 }, downloads: 20, repo: true, scripts: { postinstall: 'node setup.js' } },
    chalky: { created: 900, versions: { '5.0.0': 400, '5.0.1': 0.5 }, downloads: 3_000_000, repo: true, provenance: ['5.0.0'], publishers: { '5.0.0': 'sindre', '5.0.1': 'someone-else' } },
    crossenv: { created: 3000, versions: { '0.0.2-security': 2000 }, downloads: 1500, repo: false, description: 'security holding package' },
  },
  pypi: {
    requests: { created: 5000, versions: { '2.32.3': 300 }, downloads: 200_000_000, repo: true },
    'sketchy-build': { created: 400, versions: { '1.0': 400 }, downloads: 5000, repo: true, sdistOnly: true },
  },
};

export const VULNS = {
  'npm:crossenv': [{ id: 'GHSA-c2m4-w5hm-vqjw', summary: 'crossenv is malware' }],
  'npm:lodash@4.17.20': [{ id: 'GHSA-35jh-r3h4-6jhm', summary: 'Command injection in lodash' }],
};

function npmDoc(name, p) {
  const versions = {};
  const time = { created: iso(p.created) };
  for (const [v, age] of Object.entries(p.versions)) {
    time[v] = iso(age);
    versions[v] = {
      name,
      version: v,
      scripts: p.scripts ?? {},
      deprecated: p.deprecated,
      repository: p.repo ? { url: `git+https://github.com/example/${name}.git` } : undefined,
      dist: p.provenance?.includes(v) ? { attestations: { url: 'x' } } : {},
      _npmUser: { name: p.publishers?.[v] ?? 'maintainer' },
    };
  }
  const latest = Object.keys(p.versions).at(-1);
  return { name, 'dist-tags': { latest }, time, versions, description: p.description ?? '', maintainers: [{ name: 'm' }] };
}

function pypiDoc(name, p) {
  const releases = {};
  for (const [v, age] of Object.entries(p.versions)) {
    releases[v] = [
      { packagetype: 'sdist', upload_time_iso_8601: iso(age), yanked: false },
      ...(p.sdistOnly ? [] : [{ packagetype: 'bdist_wheel', upload_time_iso_8601: iso(age), yanked: false }]),
    ];
  }
  return {
    info: { name, version: Object.keys(p.versions).at(-1), summary: '', project_urls: p.repo ? { Source: `https://github.com/example/${name}` } : {} },
    releases,
  };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function fakeFetch(overrides = {}) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push(String(url));
    const u = new URL(url);
    if (overrides[u.host]) return overrides[u.host](u, init);
    if (u.host === 'registry.npmjs.org') {
      const name = decodeURIComponent(u.pathname.slice(1));
      const p = PACKAGES.npm[name];
      return p ? json(npmDoc(name, p)) : json({ error: 'Not found' }, 404);
    }
    if (u.host === 'api.npmjs.org') {
      const name = decodeURIComponent(u.pathname.split('/last-week/')[1]);
      const p = PACKAGES.npm[name];
      return p ? json({ downloads: p.downloads }) : json({ error: 'not found' }, 404);
    }
    if (u.host === 'pypi.org') {
      const name = decodeURIComponent(u.pathname.split('/')[2]);
      const p = PACKAGES.pypi[name];
      return p ? json(pypiDoc(name, p)) : json({ message: 'Not Found' }, 404);
    }
    if (u.host === 'pypistats.org') {
      const name = decodeURIComponent(u.pathname.split('/')[3]);
      const p = PACKAGES.pypi[name];
      return p ? json({ data: { last_week: p.downloads } }) : json({}, 404);
    }
    if (u.host === 'api.osv.dev') {
      const body = JSON.parse(init.body);
      const eco = body.package.ecosystem === 'npm' ? 'npm' : 'pypi';
      const vulns = [...(VULNS[`${eco}:${body.package.name}`] ?? []), ...(VULNS[`${eco}:${body.package.name}@${body.version}`] ?? [])];
      return json(vulns.length ? { vulns } : {});
    }
    throw new Error(`unexpected request ${url}`);
  };
  impl.calls = calls;
  return impl;
}
