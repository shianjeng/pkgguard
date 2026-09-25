import assert from 'node:assert/strict';
import test from 'node:test';
import { findPep440, pep440Key, resolveRange, satisfies } from '../skills/pkgguard/scripts/lib/versions.mjs';

test('semver ranges', () => {
  const yes = [
    ['1.2.3', '^1.0.0'], ['1.9.0', '^1.2'], ['0.2.5', '^0.2.3'], ['0.0.3', '^0.0.3'], ['1.2.9', '~1.2.3'],
    ['1.5.0', '1.x'], ['1.2.7', '1.2.*'], ['2.0.0', '>=1.2.3'], ['1.2.3', '=1.2.3'], ['1.2.3', '1.2.3'],
    ['3.1.0', '^1.0.0 || ^3.0.0'], ['1.3.0', '1.2 - 1.4'], ['1.4.9', '1.2 - 1.4'], ['5.0.0', '*'], ['1.3.0', '>1.2'],
    ['1.2.9', '<=1.2'], ['1.0.0-beta.2', '>=1.0.0-beta.1 <1.0.0'], ['1.2.4', '>= 1.2.3 < 2'],
  ];
  const no = [
    ['2.0.0', '^1.0.0'], ['0.3.0', '^0.2.3'], ['0.0.4', '^0.0.3'], ['1.3.0', '~1.2.3'], ['1.2.9', '>1.2'],
    ['1.3.0', '<=1.2'], ['2.0.0-rc.1', '^1.0.0'], ['2.0.0-rc.1', '>=1.0.0'], ['1.5.0', '1.2 - 1.4'],
  ];
  for (const [v, r] of yes) assert.ok(satisfies(v, r), `${v} should satisfy ${r}`);
  for (const [v, r] of no) assert.ok(!satisfies(v, r), `${v} should not satisfy ${r}`);
});

test('npm picks latest when it fits, else the highest match', () => {
  const versions = ['16.14.0', '17.0.2', '18.2.0', '18.3.1', '19.0.0', '19.1.0-rc.1'];
  assert.equal(resolveRange(versions, '^17', '19.0.0'), '17.0.2');
  assert.equal(resolveRange(versions, '>=18', '19.0.0'), '19.0.0');
  assert.equal(resolveRange(versions, '^18.0.0', '18.2.0'), '18.2.0', 'latest wins even if a newer 18.x exists');
  assert.equal(resolveRange(versions, '^20', '19.0.0'), null);
  assert.equal(resolveRange(versions, 'not-a-range', '19.0.0'), undefined);
});

test('PEP 440 equality', () => {
  assert.equal(pep440Key('2.0.0'), '2');
  assert.equal(pep440Key('2.0'), '2');
  assert.equal(pep440Key('2.10'), '2.10');
  assert.equal(pep440Key('1.20.0'), '1.20');
  assert.equal(pep440Key('1.0-RC1'), pep440Key('1.0rc1'));
  assert.equal(pep440Key('1.0.0.post1'), pep440Key('1.0-post1'));
  assert.equal(findPep440(['1.26.4', '2.0.0', '2.1.0'], '2.0'), '2.0.0');
  assert.equal(findPep440(['2.0.0'], '2.0.1'), null);
});
