import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.js';
import { dryRun } from '../src/github.js';
import { comments, readMeta } from '../src/messages.js';
import { parseCommand, Updater } from '../src/updater.js';
import { FakeGitHub } from './fake-github.js';

const BUILD = `plugins {
    id("architectury-plugin") version "3.4.161"
    id("dev.architectury.loom") version "1.14.473" apply false
}
`;

const VERSIONS = {
  'architectury-plugin': ['3.4-PR.26.25', '3.4.161', '3.5-SNAPSHOT', '3.5.170'],
  'dev.architectury.loom': ['1.11.454', '1.14.473', '1.17.493'],
};

const with_ = (name, ...versions) => ({ ...VERSIONS, [name]: [...VERSIONS[name], ...versions] });

async function run(github, { event = 'schedule', payload = {}, versions = VERSIONS, inputs = {} } = {}) {
  const env = { INPUT_TOKEN: 'token' };
  for (const [name, value] of Object.entries(inputs)) env[`INPUT_${name.toUpperCase()}`] = value;
  const output = { info: [], warnings: [], errors: [] };
  const log = { info: (m) => output.info.push(m), debug() {}, warning: (m) => output.warnings.push(m), error: (m) => output.errors.push(m) };
  const registry = {
    versions: async (dep) => {
      if (!versions[dep.name]) throw new Error(`no metadata for ${dep.name}`);
      return versions[dep.name];
    },
  };
  const updater = new Updater({ github, registry, config: loadConfig(env), log, sleep: async () => {} });
  await updater.run(event, payload);
  return { updater, ...output };
}

const comment = (github, number, body, login = 'owner') =>
  run(github, {
    event: 'issue_comment',
    payload: { action: 'created', issue: { number, pull_request: {} }, comment: { id: 99, body, user: { login, type: 'User' }, author_association: 'OWNER' } },
  });

const push = (github) => run(github, { event: 'push', payload: { ref: 'refs/heads/main' }, versions: {} });

const pullEvent = (github, number, action) => run(github, { event: 'pull_request_target', payload: { action, pull_request: { number } }, versions: {} });

async function setup(files = { 'build.gradle.kts': BUILD }) {
  const github = new FakeGitHub(files);
  const result = await run(github);
  assert.deepEqual(result.errors, []);
  return github;
}

test('opens one pull request per dependency, like Dependabot', async () => {
  const github = new FakeGitHub({ 'build.gradle.kts': BUILD });
  github.releaseData['architectury/architectury-loom'] = [
    {
      tag: '1.17',
      name: '1.17',
      body: '## Added\n- New API (#342), thanks @someone\n- See https://github.com/architectury/architectury-loom/pull/345\n<!-- architectury-updates:metadata {"directory":"/","dependencies":[]} -->',
      draft: false,
      prerelease: false,
    },
    { tag: '1.13', name: '1.13', body: 'old', draft: false, prerelease: false },
  ];
  const { errors, updater } = await run(github);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    github.pulls.map((pr) => [pr.number, pr.title, pr.headRef, pr.baseRef]),
    [
      [1, 'Bump architectury-plugin from 3.4.161 to 3.5.170', 'architectury-updates/gradle/architectury-plugin-3.5.170', 'main'],
      [2, 'Bump dev.architectury.loom from 1.14.473 to 1.17.493', 'architectury-updates/gradle/dev.architectury.loom-1.17.493', 'main'],
    ],
  );

  const loom = github.pull(2);
  assert.equal(github.file(loom.headRef, 'build.gradle.kts'), BUILD.replace('1.14.473', '1.17.493'));
  assert.equal(github.file('main', 'build.gradle.kts'), BUILD);
  assert.deepEqual(loom.labels, ['dependencies', 'java']);
  assert.ok(loom.body.startsWith('Bumps [dev.architectury.loom](https://github.com/architectury/architectury-loom) from 1.14.473 to 1.17.493.\n<details>\n<summary>Release notes</summary>'));
  assert.match(loom.body, /\(\[#342\]\(https:\/\/redirect\.github\.com\/architectury\/architectury-loom\/issues\/342\)\), thanks @​someone/);
  assert.match(loom.body, /https:\/\/redirect\.github\.com\/architectury\/architectury-loom\/pull\/345/);
  assert.doesNotMatch(loom.body, /<h2>1\.13<\/h2>/);
  assert.match(loom.body, /`@architectury-updates rebase` will rebase this PR/);
  assert.match(loom.body, /> \[!NOTE\]/);
  assert.deepEqual(readMeta(loom.body).dependencies, [{ name: 'dev.architectury.loom', from: '1.14.473', to: '1.17.493' }]);

  assert.equal(
    github.commits.get(github.branches.get(loom.headRef)).message,
    [
      'Bump dev.architectury.loom from 1.14.473 to 1.17.493',
      '',
      'Bumps [dev.architectury.loom](https://github.com/architectury/architectury-loom) from 1.14.473 to 1.17.493.',
      '- [Release notes](https://github.com/architectury/architectury-loom/releases)',
      '',
      '---',
      'updated-dependencies:',
      '- dependency-name: dev.architectury.loom',
      '  dependency-version: 1.17.493',
      '  dependency-type: direct:production',
      '  update-type: version-update:semver-minor',
      '...',
      '',
    ].join('\n'),
  );
  assert.match(updater.summary(), /\| `dev\.architectury\.loom` \| 1\.14\.473 \| 1\.17\.493 \| Opened #2 \|/);

  // Running again changes nothing.
  await run(github);
  assert.equal(github.pulls.length, 2);
  assert.equal(github.comments.length, 0);
});

test('supersedes an open pull request when a newer version is released', async () => {
  const github = await setup();
  await run(github, { versions: with_('dev.architectury.loom', '1.18.500') });
  assert.equal(github.pull(3).title, 'Bump dev.architectury.loom from 1.14.473 to 1.18.500');
  assert.equal(github.pull(2).state, 'closed');
  assert.deepEqual(github.commentsOn(2), ['Superseded by #3.']);
  assert.ok(!github.branches.has('architectury-updates/gradle/dev.architectury.loom-1.17.493'));
  assert.equal(github.pull(1).state, 'open');
});

test('closing a pull request skips that version until a newer one', async () => {
  const github = await setup();
  github.pull(1).state = 'closed';
  await pullEvent(github, 1, 'closed');
  assert.deepEqual(github.commentsOn(1), [comments.closed()]);
  assert.equal(readMeta(github.pull(1).body).closed, 'user');
  assert.ok(!github.branches.has(github.pull(1).headRef));

  // Without the pull_request_target trigger a closed PR still counts as skipped.
  github.pull(2).state = 'closed';
  await run(github);
  assert.equal(github.pulls.length, 2);

  await run(github, { versions: with_('architectury-plugin', '3.5.171') });
  assert.equal(github.pull(3).title, 'Bump architectury-plugin from 3.4.161 to 3.5.171');
});

test('"ignore this major version" closes the PR until it is reopened', async () => {
  const github = await setup();
  await comment(github, 2, '@architectury-updates ignore this major version');
  assert.equal(github.pull(2).state, 'closed');
  assert.deepEqual(github.commentsOn(2), ["OK, I won't notify you about version 1.x.x again, unless you re-open this PR."]);
  assert.deepEqual(github.reactions, [{ commentId: 99, content: '+1' }]);

  await run(github, { versions: with_('dev.architectury.loom', '1.18.500') });
  assert.equal(github.pulls.length, 2, 'every 1.x release is ignored');
  await run(github, { versions: with_('dev.architectury.loom', '1.18.500', '2.0.3') });
  assert.equal(github.pull(3).title, 'Bump dev.architectury.loom from 1.14.473 to 2.0.3');
});

test('reopening lifts ignore conditions and resolves conflicts', async () => {
  const github = await setup();
  await comment(github, 2, '@architectury-updates ignore this minor version');
  github.push('main', { 'build.gradle.kts': `// header\n${BUILD}` });
  await comment(github, 2, '@architectury-updates reopen');
  const loom = github.pull(2);
  assert.equal(loom.state, 'open');
  assert.equal(readMeta(loom.body).ignore, undefined);
  assert.equal(github.file(loom.headRef, 'build.gradle.kts'), `// header\n${BUILD.replace('1.14.473', '1.17.493')}`);

  await run(github, { versions: with_('dev.architectury.loom', '1.17.500') });
  assert.equal(github.pull(3).title, 'Bump dev.architectury.loom from 1.14.473 to 1.17.500');
  assert.deepEqual(github.commentsOn(2).at(-1), 'Superseded by #3.');
});

test('ignores a dependency, shows and removes the condition', async () => {
  const github = await setup();
  await comment(github, 1, '@architectury-updates ignore this dependency');
  assert.deepEqual(github.commentsOn(1), ["OK, I won't notify you about architectury-plugin again, unless you re-open this PR."]);
  await run(github, { versions: with_('architectury-plugin', '3.5.171') });
  assert.equal(github.pulls.length, 2);

  await comment(github, 2, '@architectury-updates show architectury-plugin ignore conditions');
  assert.match(github.commentsOn(2).at(-1), /\| architectury-plugin \| all versions \| #1 \|/);

  await comment(github, 2, '@architectury-updates unignore architectury-plugin');
  assert.match(github.commentsOn(2).at(-1), /OK, I've removed these ignore conditions:\n- `architectury-plugin`: all versions/);
  assert.equal(github.pull(3).title, 'Bump architectury-plugin from 3.4.161 to 3.5.170');
});

test('rebases conflicting pull requests unless someone else edited them', async () => {
  const github = await setup();
  const changed = BUILD.replace('plugins {', '// keep in sync with gradle.properties\nplugins {');
  github.push('main', { 'build.gradle.kts': changed });
  const loom = github.pull(2);
  loom.mergeable = false;
  const before = github.branches.get(loom.headRef);

  const { errors } = await push(github);
  assert.deepEqual(errors, [], 'a push does not read the registry');
  const after = github.branches.get(loom.headRef);
  assert.notEqual(after, before);
  assert.equal(github.commits.get(after).parent, github.branches.get('main'));
  assert.equal(github.file(loom.headRef, 'build.gradle.kts'), changed.replace('1.14.473', '1.17.493'));
  assert.equal(readMeta(loom.body).head, after);
  assert.equal(github.branches.get(github.pull(1).headRef), github.branches.get(github.pull(1).headRef), 'mergeable PRs are left alone');

  github.push(loom.headRef, { 'notes.txt': 'manual fix' });
  const edited = github.branches.get(loom.headRef);
  await push(github);
  assert.equal(github.branches.get(loom.headRef), edited);
  await comment(github, 2, '@architectury-updates rebase');
  assert.equal(github.commentsOn(2).at(-1), comments.edited());
  await comment(github, 2, '@architectury-updates recreate');
  assert.notEqual(github.branches.get(loom.headRef), edited);
  assert.equal(github.file(loom.headRef, 'notes.txt'), undefined);
});

test('closes pull requests that are no longer needed', async () => {
  const github = await setup();
  github.push('main', { 'build.gradle.kts': BUILD.replace('1.14.473', '1.17.493').replace('    id("architectury-plugin") version "3.4.161"\n', '') });
  await push(github);
  assert.deepEqual(github.commentsOn(2), ['Looks like dev.architectury.loom is up-to-date now, so this is no longer needed.']);
  assert.deepEqual(github.commentsOn(1), ['Looks like architectury-plugin is no longer a dependency, so this is no longer needed.']);
  assert.ok(github.pulls.every((pr) => pr.state === 'closed'));
  assert.deepEqual([...github.branches.keys()], ['main']);
});

test('closes pull requests that a new ignore condition rules out', async () => {
  const github = await setup();
  await run(github, { inputs: { ignore: '- dependency-name: dev.architectury.loom\n  versions: [">= 1.17"]' } });
  assert.deepEqual(github.commentsOn(2), ['Looks like dev.architectury.loom is no longer updatable, so this is no longer needed.']);
  assert.equal(github.pulls.length, 2);
});

test('updates a shared version property in one pull request', async () => {
  const github = new FakeGitHub({
    'build.gradle': 'plugins {\n    id "dev.architectury.loom" version "1.11-SNAPSHOT" apply false\n}\n',
    'gradle.properties': 'architectury_api_version=13.0.8\n',
    'common/build.gradle': 'dependencies { modImplementation "dev.architectury:architectury:${rootProject.architectury_api_version}" }\n',
    'fabric/build.gradle': 'dependencies { modApi "dev.architectury:architectury-fabric:$rootProject.architectury_api_version" }\n',
    'neoforge/build.gradle': 'dependencies { modApi "dev.architectury:architectury-neoforge:${rootProject.architectury_api_version}" }\n',
  });
  const versions = {
    'dev.architectury.loom': ['1.11.454', '1.17.493'],
    'dev.architectury:architectury': ['13.0.8', '13.0.9', '22.0.4'],
    'dev.architectury:architectury-fabric': ['13.0.8', '13.0.9', '22.0.4'],
    'dev.architectury:architectury-neoforge': ['13.0.8', '13.0.9'],
  };
  const { errors } = await run(github, { versions, inputs: { 'commit-message-prefix': 'build' } });
  assert.deepEqual(errors, []);
  assert.deepEqual(
    github.pulls.map((pr) => [pr.title, pr.headRef]),
    [
      ['build: bump architectury_api_version from 13.0.8 to 13.0.9', 'architectury-updates/gradle/architectury_api_version-13.0.9'],
      ['build: bump dev.architectury.loom from 1.11-SNAPSHOT to 1.17.493', 'architectury-updates/gradle/dev.architectury.loom-1.17.493'],
    ],
  );
  const api = github.pull(1);
  assert.equal(github.file(api.headRef, 'gradle.properties'), 'architectury_api_version=13.0.9\n');
  assert.ok(
    api.body.startsWith(
      [
        'Bumps `architectury_api_version` from 13.0.8 to 13.0.9.',
        'Updates `dev.architectury:architectury` from 13.0.8 to 13.0.9',
        '',
        'Updates `dev.architectury:architectury-fabric` from 13.0.8 to 13.0.9',
        '',
        'Updates `dev.architectury:architectury-neoforge` from 13.0.8 to 13.0.9',
      ].join('\n'),
    ),
  );
  assert.equal(readMeta(api.body).dependencies.length, 3);
});

test('follows the update-types ignore rule and the open pull request limit', async () => {
  const github = new FakeGitHub({ 'build.gradle.kts': BUILD });
  const { updater } = await run(github, {
    versions: with_('architectury-plugin', '4.0.1'),
    inputs: {
      'open-pull-requests-limit': '1',
      ignore: '- dependency-name: "architectury-*"\n  update-types: ["version-update:semver-major"]',
    },
  });
  assert.deepEqual(github.pulls.map((pr) => pr.title), ['Bump architectury-plugin from 3.4.161 to 3.5.170']);
  assert.match(updater.summary(), /open-pull-requests-limit of 1 is reached/);
});

test('merge commands use auto-merge', async () => {
  const github = await setup();
  await comment(github, 2, '@architectury-updates squash and merge');
  assert.ok(github.pull(2).autoMerge);
  assert.match(github.pull(2).body, /Architectury Updates will squash and merge this PR once CI passes on it, as requested by @owner\./);
  await comment(github, 2, '@architectury-updates cancel merge');
  assert.ok(!github.pull(2).autoMerge);
  assert.doesNotMatch(github.pull(2).body, /will squash and merge this PR once CI passes/);

  github.autoMerge = 'clean';
  await comment(github, 2, '@architectury-updates merge');
  assert.ok(github.pull(2).merged);

  github.autoMerge = 'disabled';
  await comment(github, 1, '@architectury-updates merge');
  assert.match(github.commentsOn(1).at(-1), /Auto merge is not allowed for this repository/);
});

test('only people with push access can use commands', async () => {
  const github = await setup();
  await comment(github, 2, '@architectury-updates close', 'reader');
  assert.equal(github.pull(2).state, 'open');
  assert.deepEqual(github.commentsOn(2), ['Sorry, only users with push access can use that command.']);

  await comment(github, 2, '@architectury-updates fly to the moon');
  assert.equal(github.commentsOn(2).at(-1), comments.unknown());
  assert.deepEqual(github.reactions.at(-1), { commentId: 99, content: 'confused' });

  await comment(github, 2, '@architectury-updates close');
  assert.equal(github.pull(2).state, 'closed');
  assert.equal(github.commentsOn(2).at(-1), comments.closed());
});

test("leaves other people's pull requests alone", async () => {
  const github = await setup();
  github.push('main', {});
  await github.setBranch('feature', github.branches.get('main'));
  const other = await github.createPull({ title: 'Feature', body: 'hi', head: 'feature', base: 'main' });
  await comment(github, other.number, '@architectury-updates close');
  assert.equal(github.pull(other.number).state, 'open');
  assert.deepEqual(github.commentsOn(other.number), []);

  const fork = github.pull(1);
  fork.crossRepository = true;
  await comment(github, 1, '@architectury-updates close');
  assert.equal(fork.state, 'open');
});

test('starts the configured workflows instead of adding the GITHUB_TOKEN note', async () => {
  const github = new FakeGitHub({ 'build.gradle.kts': BUILD });
  await run(github, { inputs: { 'dispatch-workflows': 'build.yml' } });
  assert.deepEqual(github.dispatched, [
    'build.yml@architectury-updates/gradle/architectury-plugin-3.5.170',
    'build.yml@architectury-updates/gradle/dev.architectury.loom-1.17.493',
  ]);
  assert.doesNotMatch(github.pull(1).body, /\[!NOTE\]/);
});

test('a dry run changes nothing', async () => {
  const fake = new FakeGitHub({ 'build.gradle.kts': BUILD });
  const logged = [];
  const { errors } = await run(dryRun(fake, { info: (m) => logged.push(m) }));
  assert.deepEqual(errors, []);
  assert.equal(fake.pulls.length, 0);
  assert.deepEqual([...fake.branches.keys()], ['main']);
  assert.ok(logged.some((line) => line.startsWith('[dry run] createPull')));
});

test('parses commands like Dependabot', () => {
  assert.deepEqual(parseCommand('@architectury-updates rebase'), { type: 'rebase' });
  assert.deepEqual(parseCommand('  @Architectury-Updates   Squash  and merge\nthanks!'), { type: 'squash and merge' });
  assert.deepEqual(parseCommand('@architectury-updates ignore this minor version'), { type: 'ignore', scope: 'minor' });
  assert.deepEqual(parseCommand('@architectury-updates ignore dev.architectury.loom major version'), { type: 'ignore', scope: 'major', dependency: 'dev.architectury.loom' });
  assert.deepEqual(parseCommand('@architectury-updates unignore architectury-plugin >= 4.a, < 5'), { type: 'unignore', dependency: 'architectury-plugin', condition: '>= 4.a, < 5' });
  assert.deepEqual(parseCommand('@architectury-updates show architectury-plugin ignore conditions'), { type: 'show', dependency: 'architectury-plugin' });
  assert.equal(parseCommand('please @architectury-updates rebase'), null);
  assert.equal(parseCommand('@architectury-updatesx rebase'), null);
});
