import assert from 'node:assert/strict';
import test from 'node:test';
import { findInstalls, MAYBE_INSTALL, parseNpmSpec, parsePySpec, tokenize } from '../skills/pkgguard/scripts/lib/parse.mjs';

const names = (command) => findInstalls(command).map((p) => `${p.ecosystem}:${p.name}${p.version ? `@${p.version}` : ''}`);

test('tokenizer splits on shell operators and respects quotes', () => {
  assert.deepEqual(tokenize(`cd app && npm i "left pad" 'a;b' x\\ y; echo hi | cat # npm i nope`), [
    ['cd', 'app'],
    ['npm', 'i', 'left pad', 'a;b', 'x y'],
    ['echo', 'hi'],
    ['cat'],
  ]);
});

test('npm family', () => {
  assert.deepEqual(names('npm install lodash react@18.2.0 -D @types/node@^20'), ['npm:lodash', 'npm:react@18.2.0', 'npm:@types/node']);
  assert.deepEqual(names('npm i --registry https://r.example.com --save-exact chalk'), ['npm:chalk']);
  assert.deepEqual(names('npm install'), [], 'a bare install uses the lockfile');
  assert.deepEqual(names('npm ci && npm run build'), []);
  assert.deepEqual(names('npm install ./local ../x file:../y git+https://g/x.git user/repo https://x/y.tgz'), []);
  assert.deepEqual(names('npm i my-alias@npm:real-pkg@1.0.0'), ['npm:real-pkg@1.0.0']);
  assert.deepEqual(names('pnpm add -D vitest && yarn add zod && bun add hono'), ['npm:vitest', 'npm:zod', 'npm:hono']);
  assert.deepEqual(names('yarn global add typescript'), ['npm:typescript']);
});

test('package runners only count the package, not its arguments', () => {
  assert.deepEqual(names('npx create-vite@latest my-app --template react'), ['npm:create-vite']);
  assert.deepEqual(names('npx -y prettier --write .'), ['npm:prettier']);
  assert.deepEqual(names('npx -p typescript tsc --init'), ['npm:typescript']);
  assert.deepEqual(names('pnpm dlx shadcn@latest init'), ['npm:shadcn']);
  assert.deepEqual(names('bunx cowsay hi'), ['npm:cowsay']);
  assert.deepEqual(names('npm exec -- eslint .'), ['npm:eslint']);
});

test('python family', () => {
  assert.deepEqual(names('pip install requests numpy==1.26.4 "pandas>=2" flask[async] -U'), [
    'pypi:requests',
    'pypi:numpy@1.26.4',
    'pypi:pandas',
    'pypi:flask',
  ]);
  assert.deepEqual(names('pip install -r requirements.txt -e . --index-url https://x/simple'), []);
  assert.deepEqual(names('python3 -m pip install Django_REST.framework'), ['pypi:django-rest-framework']);
  assert.deepEqual(names('uv add httpx && uv pip install rich && uvx ruff check'), ['pypi:httpx', 'pypi:rich', 'pypi:ruff']);
  assert.deepEqual(names('uvx --from black==24.1.0 black .'), ['pypi:black@24.1.0']);
  assert.deepEqual(names('pipx install poetry && poetry add pydantic'), ['pypi:poetry', 'pypi:pydantic']);
  assert.deepEqual(names('python script.py install requests'), []);
});

test('wrappers and environment assignments are skipped', () => {
  assert.deepEqual(names('sudo -E npm i -g pm2'), ['npm:pm2']);
  assert.deepEqual(names('CI=1 FOO=bar pip3 install httpx'), ['pypi:httpx']);
  assert.deepEqual(names('/usr/local/bin/npm install express'), ['npm:express']);
});

test('duplicates are reported once', () => {
  assert.deepEqual(names('npm i zod && npm i zod'), ['npm:zod']);
});

test('spec parsing', () => {
  assert.equal(parseNpmSpec('Lodash'), null, 'npm names are lowercase');
  assert.deepEqual(parseNpmSpec('@scope/pkg@next'), { ecosystem: 'npm', name: '@scope/pkg', requested: 'next', version: null });
  assert.equal(parsePySpec('pkg @ https://example.com/pkg.whl'), null);
  assert.equal(parsePySpec('numpy==1.*').version, null);
  assert.equal(parsePySpec('numpy===1.26').version, '1.26');
});

test('pre-check matches install commands and skips everything else cheaply', () => {
  assert.ok(MAYBE_INSTALL.test('cd x && npm i y'));
  assert.ok(MAYBE_INSTALL.test('python3 -m pip install x'));
  assert.ok(!MAYBE_INSTALL.test('ls -la && git status'));
});
