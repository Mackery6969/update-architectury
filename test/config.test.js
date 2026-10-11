import assert from 'node:assert/strict';
import { test } from 'node:test';
import { configIgnores, isArchitectury, loadConfig, normalizeDirectory, parseAllow, parseIgnore } from '../src/config.js';
import { parseYaml } from '../src/yaml.js';

test('reads dependabot.yml-style ignore lists', () => {
  const yaml = `
# keep Architectury API on this Minecraft version
- dependency-name: "dev.architectury:architectury*"
  update-types: ["version-update:semver-major"]
- dependency-name: dev.architectury.loom
  versions:
    - ">= 1.18"
    - '2.x'
- dependency-name: 'architectury-plugin' # everything
`;
  assert.deepEqual(parseYaml(yaml), [
    { 'dependency-name': 'dev.architectury:architectury*', 'update-types': ['version-update:semver-major'] },
    { 'dependency-name': 'dev.architectury.loom', versions: ['>= 1.18', '2.x'] },
    { 'dependency-name': 'architectury-plugin' },
  ]);

  const [api, loom, plugin] = parseIgnore(yaml);
  assert.ok(configIgnores(api, 'dev.architectury:architectury-fabric', '13.0.8', '22.0.4'));
  assert.ok(!configIgnores(api, 'dev.architectury:architectury-fabric', '13.0.8', '13.0.9'));
  assert.ok(configIgnores(loom, 'dev.architectury.loom', '1.14.473', '1.18.1'));
  assert.ok(!configIgnores(loom, 'dev.architectury.loom', '1.14.473', '1.17.493'));
  assert.ok(configIgnores(plugin, 'architectury-plugin', '3.4.161', '3.5.170'));
  assert.ok(!configIgnores(plugin, 'dev.architectury.loom', '1.14.473', '1.17.493'));
});

test('reads flow mappings, compact sequences and JSON', () => {
  assert.deepEqual(parseYaml('- {dependency-name: "a:b", versions: [">= 2", "3.x"]}'), [{ 'dependency-name': 'a:b', versions: ['>= 2', '3.x'] }]);
  assert.deepEqual(parseYaml('key:\n- one\n- "two"\nother: x'), { key: ['one', 'two'], other: 'x' });
  assert.deepEqual(parseYaml('[{"dependency-name": "x"}]'), [{ 'dependency-name': 'x' }]);
  assert.deepEqual(parseYaml("- 'it''s'"), ["it's"]);
  assert.equal(parseYaml('  '), null);
  assert.throws(() => parseYaml('- a\n  - b\n- : :'), /Could not parse/);
});

test('rejects malformed ignore conditions', () => {
  assert.throws(() => parseIgnore('- versions: ["1.0"]'), /dependency-name/);
  assert.throws(() => parseIgnore('- dependency-name: x\n  update-type: [major]'), /unknown keys/);
  assert.throws(() => parseIgnore('- dependency-name: x\n  update-types: [huge]'), /Unknown update type/);
  assert.throws(() => parseIgnore('- dependency-name: x\n  versions: [">= "]'), /requirement/);
  assert.deepEqual([...parseIgnore('- dependency-name: x\n  update-types: [minor, patch]')[0].updateTypes], ['minor', 'patch']);
});

test('limits updates to Architectury and the allow list', () => {
  assert.ok(isArchitectury({ kind: 'plugin', name: 'dev.architectury.loom' }));
  assert.ok(isArchitectury({ kind: 'plugin', name: 'architectury-plugin' }));
  assert.ok(isArchitectury({ kind: 'library', name: 'dev.architectury:architectury-neoforge' }));
  assert.ok(!isArchitectury({ kind: 'plugin', name: 'fabric-loom' }));
  assert.ok(!isArchitectury({ kind: 'library', name: 'me.shedaniel.cloth:cloth-config' }));
  const [pattern] = parseAllow('- dependency-name: "dev.architectury.*"');
  assert.ok(pattern.test('dev.architectury.loom') && !pattern.test('architectury-plugin'));
});

test('loads action inputs', () => {
  const config = loadConfig({
    'INPUT_TOKEN': 't',
    'INPUT_DIRECTORY': 'mc26/',
    'INPUT_LABELS': 'dependencies, gradle',
    'INPUT_COMMIT-MESSAGE-PREFIX': 'build',
    'INPUT_OPEN-PULL-REQUESTS-LIMIT': '2',
    'INPUT_DISPATCH-WORKFLOWS': 'build.yml\nlint.yml',
    'INPUT_DRY-RUN': 'true',
  });
  assert.equal(config.directory, '/mc26');
  assert.deepEqual(config.labels, ['dependencies', 'gradle']);
  assert.equal(config.commitMessage.prefix, 'build');
  assert.equal(config.openPullRequestsLimit, 2);
  assert.deepEqual(config.dispatchWorkflows, ['build.yml', 'lint.yml']);
  assert.equal(config.dryRun, true);
  assert.deepEqual(loadConfig({}).labels, ['dependencies', 'java']);
  assert.deepEqual(loadConfig({ INPUT_LABELS: '' }).labels, []);
  assert.throws(() => loadConfig({ 'INPUT_REBASE-STRATEGY': 'sometimes' }), /rebase-strategy/);
  assert.equal(normalizeDirectory('./'), '/');
  assert.equal(normalizeDirectory('\\common\\'), '/common');
});
