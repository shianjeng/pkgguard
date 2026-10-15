import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { privateRegistry, scopeRegistries } from '../skills/pkgguard/scripts/lib/npmrc.mjs';

test('scope registries come from env, then the nearest .npmrc, then the home one', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pkgguard-rc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const project = path.join(root, 'work', 'app');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(project, 'src'), { recursive: true });
  fs.writeFileSync(path.join(home, '.npmrc'), '@home:registry=https://home.example/\n@shared:registry=https://from-home.example/\n');
  fs.writeFileSync(path.join(root, 'work', '.npmrc'), '@work:registry="https://work.example/"\n');
  fs.writeFileSync(
    path.join(project, '.npmrc'),
    '; a comment\n@shared:registry = https://from-project.example/\n//npm.corp.example/:_authToken=abc\n@public:registry=https://registry.npmjs.org/\n',
  );

  const map = scopeRegistries(path.join(project, 'src'), { 'npm_config_@env:registry': 'https://env.example/' }, home);
  assert.equal(map.get('@env'), 'https://env.example/');
  assert.equal(map.get('@shared'), 'https://from-project.example/', 'the nearest file wins');
  assert.equal(map.get('@work'), 'https://work.example/', 'parent directories are read, quotes stripped');
  assert.equal(map.get('@home'), 'https://home.example/');

  assert.equal(privateRegistry('@shared/x', map), 'https://from-project.example/');
  assert.equal(privateRegistry('@public/x', map), null, 'a scope mapped to the public registry is still checked');
  assert.equal(privateRegistry('@unknown/x', map), null);
  assert.equal(privateRegistry('unscoped', map), null);
});
