import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareVersions, ignoreRequirement, isDynamic, isPrerelease, maxVersion, parseRequirement, updateType, versionLabel } from '../src/version.js';

const ordered = (...versions) => {
  for (let i = 0; i < versions.length - 1; i++) {
    assert.equal(compareVersions(versions[i], versions[i + 1]), -1, `${versions[i]} < ${versions[i + 1]}`);
    assert.equal(compareVersions(versions[i + 1], versions[i]), 1, `${versions[i + 1]} > ${versions[i]}`);
  }
};

test('orders versions the way Gradle does', () => {
  ordered('1.0-dev', '1.0-ALPHA', '1.0-alpha', '1.0-rc', '1.0-snapshot', '1.0-final', '1.0-ga', '1.0-release', '1.0-sp', '1.0');
  ordered('1.a', '1.1');
  ordered('1.1', '1.1.0');
  ordered('1.1.a', '1.1');
  ordered('1.9', '1.10', '1.11.454');
  assert.equal(compareVersions('1.0-RC-1', '1.0.rc.1'), 0);
  assert.equal(compareVersions('1.a.1', '1-a+1'), 0);
});

test('orders Architectury release lines', () => {
  ordered('1.11-SNAPSHOT', '1.11.454', '1.13.467', '1.14-SNAPSHOT', '1.17.493');
  ordered('3.4-PR.26.25', '3.4.161', '3.5-SNAPSHOT', '3.5.170');
  ordered('12.0.25-beta', '12.0.25', '13.0.8');
  assert.equal(maxVersion(['1.11.454', '1.3.351', '0.11.0.219', '1.17.493', '1.10.455']), '1.17.493');
});

test('recognises pre-releases', () => {
  for (const version of ['1.11-SNAPSHOT', '3.4-PR.26.25', '12.0.22-beta', '2.0-rc1', '1.0-M2']) assert.ok(isPrerelease(version), version);
  for (const version of ['1.17.493', '0.11.0.219', '1.0.Final', '2.0-RELEASE']) assert.ok(!isPrerelease(version), version);
});

test('recognises dynamic versions', () => {
  for (const version of ['1.+', '+', 'latest.release', '[1.0,2.0)', '']) assert.ok(isDynamic(version), version);
  for (const version of ['1.17.493', '0.92.2+1.20.1', '1.11-SNAPSHOT']) assert.ok(!isDynamic(version), version);
});

test('classifies update types like Dependabot', () => {
  assert.equal(updateType('1.14.473', '1.17.493'), 'minor');
  assert.equal(updateType('1.17.490', '1.17.493'), 'patch');
  assert.equal(updateType('13.0.8', '22.0.4'), 'major');
  assert.equal(updateType('1.11-SNAPSHOT', '1.17.493'), 'minor');
});

test('parses requirements', () => {
  const matches = (requirement, version) => parseRequirement(requirement)(version);
  assert.ok(matches('>= 1.2.30', '1.2.30'));
  assert.ok(!matches('>= 1.2.30', '1.2.29'));
  assert.ok(matches('>= 2.a, < 3', '2.0.1'));
  assert.ok(!matches('>= 2.a, < 3', '3.0'));
  assert.ok(matches('1.x', '1.17.493'));
  assert.ok(!matches('1.x', '2.0'));
  assert.ok(matches('1.17.*', '1.17.493'));
  assert.ok(matches('[1.0,2.0)', '1.5'));
  assert.ok(!matches('[1.0,2.0)', '2.0'));
  assert.ok(matches('(,1.0],[1.2,)', '1.3'));
  assert.ok(!matches('(,1.0],[1.2,)', '1.1'));
  assert.ok(matches('[1.5]', '1.5'));
  assert.ok(matches('~> 1.2', '1.9'));
  assert.ok(!matches('~> 1.2', '2.0'));
  assert.ok(matches('1.0 || 2.0', '2.0'));
  assert.ok(matches('1.17.493', '1.17.493'));
  assert.ok(!matches('1.17.493', '1.17.494'));
  assert.throws(() => parseRequirement('>= '));
  assert.throws(() => parseRequirement('[1.0'));
});

test('builds the ranges behind "ignore this major/minor version"', () => {
  const major = parseRequirement(ignoreRequirement('major', '1.17.493'));
  assert.equal(ignoreRequirement('major', '1.17.493'), '>= 1.a, < 2');
  assert.ok(major('1.0') && major('1.18.1') && !major('2.0') && !major('0.11.0.219'));
  const minor = parseRequirement(ignoreRequirement('minor', '1.17.493'));
  assert.equal(ignoreRequirement('minor', '1.17.493'), '>= 1.17.a, < 1.18');
  assert.ok(minor('1.17') && minor('1.17.500') && !minor('1.18.1') && !minor('1.16.9'));
  assert.equal(versionLabel('major', '1.17.493'), '1.x.x');
  assert.equal(versionLabel('minor', '1.17.493'), '1.17.x');
});
