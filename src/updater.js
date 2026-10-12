import { configIgnores, DEFAULT_LABELS } from './config.js';
import { comments, commitMessage, HANDLE, joinWords, NAME, patchBody, pullBody, pullTitle, readMeta } from './messages.js';
import { releaseNotesHtml, selectReleases, sourceRepository } from './releases.js';
import { isCandidate, scanFiles } from './scan.js';
import { buildUnits, currentVersion, planUpdate } from './units.js';
import { compareVersions, ignoreRequirement, isPrerelease, maxVersion, parseRequirement, versionLabel } from './version.js';

// Reasons the bot itself closed a PR. A PR closed any other way was closed by
// a person, which (as with Dependabot) means "skip this version".
const BOT_CLOSE_REASONS = new Set(['superseded', 'up-to-date', 'removed', 'not-updatable', 'unignored']);
const CONVENTIONAL_COMMIT = /^(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]*\))?!?:\s/i;
const GITMOJI = /^(?::\w+:|\p{Extended_Pictographic})/u;

export function parseCommand(body) {
  const line = String(body ?? '').trim().split(/\r?\n/)[0].trim();
  const match = new RegExp(`^${HANDLE}(?![\\w-])\\s*(.*)$`, 'i').exec(line);
  if (!match) return null;
  const text = match[1].trim().replace(/\s+/g, ' ');
  const lower = text.toLowerCase();
  if (['rebase', 'recreate', 'merge', 'squash and merge', 'cancel merge', 'reopen', 'close'].includes(lower)) return { type: lower };
  let m;
  if ((m = /^ignore this (major|minor) version$/.exec(lower))) return { type: 'ignore', scope: m[1] };
  if (lower === 'ignore this dependency') return { type: 'ignore', scope: 'dependency' };
  if ((m = /^ignore (\S+) (major|minor) version$/i.exec(text))) return { type: 'ignore', scope: m[2].toLowerCase(), dependency: m[1] };
  if ((m = /^ignore (\S+)$/i.exec(text))) return { type: 'ignore', scope: 'dependency', dependency: m[1] };
  if (lower === 'unignore this dependency') return { type: 'unignore', dependency: null, condition: null };
  if ((m = /^unignore (\S+)(?: (.+))?$/i.exec(text))) return { type: 'unignore', dependency: m[1], condition: m[2] ?? null };
  if ((m = /^show (\S+) ignore conditions$/i.exec(text))) return { type: 'show', dependency: m[1] };
  return { type: 'unknown', text };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const cell = (text) => String(text).replace(/[\\|]/g, '\\$&');

export class Updater {
  constructor({ github, registry, config, log, sleep }) {
    this.github = github;
    this.registry = registry;
    this.config = config;
    this.log = log;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.branchRoot = `${config.branchPrefix}${config.branchSeparator}`;
    this.failed = false;
    this.report = [];
    this.actions = [];
    this.releaseCache = new Map();
  }

  async run(eventName, payload = {}) {
    switch (eventName) {
      case 'issue_comment':
        return this.onComment(payload);
      case 'pull_request':
      case 'pull_request_target':
        return this.onPullRequest(payload);
      case 'push':
        return this.onPush(payload);
      default:
        return this.reconcile({ checkForUpdates: true });
    }
  }

  // Runs one step; a failure is reported and fails the job at the end, but
  // does not stop the other dependencies from being handled.
  async attempt(label, fn) {
    try {
      return await fn();
    } catch (error) {
      this.failed = true;
      this.log.error(`${label}: ${error.message}`);
      if (error.stack) this.log.debug(error.stack);
      return undefined;
    }
  }

  // For extras like labels and reviewers, which Dependabot also treats as best effort.
  async soft(label, fn) {
    try {
      return await fn();
    } catch (error) {
      this.log.warning(`${label}: ${error.message}`);
      return undefined;
    }
  }

  async base() {
    if (!this.baseInfo) {
      const repo = await this.github.getRepo();
      const branch = this.config.targetBranch || repo.defaultBranch;
      const head = await this.github.getBranchHead(branch);
      if (!head) throw new Error(`The target branch "${branch}" does not exist.`);
      this.baseInfo = { repo, branch, ...head };
    }
    return this.baseInfo;
  }

  async snapshot() {
    if (!this.snapshotInfo) {
      const base = await this.base();
      const directory = this.config.directory === '/' ? '' : this.config.directory.slice(1);
      const { entries, truncated } = await this.github.getTree(base.treeSha);
      if (truncated) this.log.warning('The repository tree is too large to list in full; some Gradle files may have been missed.');
      const wanted = entries.filter((entry) => entry.type === 'blob' && isCandidate(entry.path, directory)).sort((a, b) => a.path.localeCompare(b.path));
      const contents = await mapLimit(wanted, 8, (entry) => this.github.getBlob(entry.sha));
      const files = new Map(wanted.map((entry, index) => [entry.path, contents[index]]));
      const scan = scanFiles(files, { include: this.config.include });
      for (const warning of scan.warnings) this.log.warning(warning);
      for (const notice of scan.notices) this.log.info(notice);
      this.snapshotInfo = {
        ...base,
        files,
        modes: new Map(wanted.map((entry) => [entry.path, entry.mode])),
        deps: scan.deps,
        units: buildUnits(scan.deps),
      };
    }
    return this.snapshotInfo;
  }

  ours(pr) {
    if (!pr.headRef.startsWith(this.branchRoot) || pr.crossRepository) return null;
    const meta = readMeta(pr.body);
    return meta && meta.directory === this.config.directory ? { ...pr, meta } : null;
  }

  async pulls() {
    this.pullList ??= (await this.github.listPulls()).map((pr) => this.ours(pr)).filter(Boolean);
    return this.pullList;
  }

  async loadPull(number) {
    return this.ours(await this.github.getPull(number));
  }

  isEdited(pr) {
    return Boolean(pr.meta.head) && pr.headSha !== pr.meta.head;
  }

  needsNote(author) {
    return !this.config.dispatchWorkflows.length && /^github-actions(?:\[bot\])?$/.test(author ?? '');
  }

  async saveMeta(pr, meta) {
    const body = patchBody(pr.body, meta);
    if (body !== pr.body) await this.github.updatePull(pr.number, { body });
    pr.body = body;
    pr.meta = meta;
  }

  async closePull(pr, reason, message, meta = pr.meta) {
    await this.saveMeta(pr, { ...meta, closed: reason, automerge: undefined });
    if (message) await this.github.comment(pr.number, message);
    await this.github.updatePull(pr.number, { state: 'closed' });
    await this.github.deleteBranch(pr.headRef);
    pr.state = 'closed';
    this.actions.push(`Closed #${pr.number} (${reason})`);
    this.log.info(`Closed #${pr.number} (${reason}).`);
  }

  // Why an open PR is no longer wanted, if it isn't.
  staleReason(pr, snapshot) {
    const names = pr.meta.dependencies.map((update) => update.name);
    const present = pr.meta.dependencies
      .map((update) => ({ ...update, dep: snapshot.deps.find((dep) => dep.name === update.name) }))
      .filter((update) => update.dep);
    if (!present.length) return { reason: 'removed', message: comments.removed(names) };
    if (present.every((update) => compareVersions(currentVersion(update.dep), update.to) >= 0)) {
      return { reason: 'up-to-date', message: comments.upToDate(names) };
    }
    const ignored = present.some((update) =>
      this.config.ignore.some((rule) => configIgnores(rule, update.name, currentVersion(update.dep), update.to)),
    );
    if (ignored) return { reason: 'not-updatable', message: comments.notUpdatable(names) };
    return null;
  }

  async reconcile({ checkForUpdates }) {
    const snapshot = await this.snapshot();
    const pulls = await this.pulls();
    this.log.info(
      snapshot.deps.length
        ? `Architectury dependencies on ${snapshot.branch}: ${snapshot.deps.map((dep) => `${dep.name} ${currentVersion(dep)}`).join(', ')}`
        : `No Architectury dependencies found on ${snapshot.branch}${this.config.directory === '/' ? '' : ` in ${this.config.directory}`}.`,
    );
    const open = () => pulls.filter((pr) => pr.state === 'open' && pr.baseRef === snapshot.branch);

    for (const pr of open()) {
      await this.attempt(`#${pr.number}`, async () => {
        // An open PR that still carries close/ignore state was reopened by hand,
        // which (as with Dependabot) lifts its ignore conditions.
        if (pr.meta.closed || pr.meta.ignore) await this.saveMeta(pr, { ...pr.meta, closed: undefined, ignore: undefined });
        const stale = this.staleReason(pr, snapshot);
        if (stale) await this.closePull(pr, stale.reason, stale.message);
      });
    }

    if (checkForUpdates) {
      const ignores = this.commentIgnores(pulls);
      for (const unit of snapshot.units) await this.attempt(unit.name, () => this.updateUnit(unit, snapshot, pulls, ignores));
    }

    if (this.config.rebaseStrategy === 'auto') {
      const candidates = open().filter((pr) => !pr.fresh);
      const mergeable = await Promise.all(candidates.map((pr) => this.attempt(`#${pr.number}`, () => this.mergeable(pr))));
      for (const [index, pr] of candidates.entries()) {
        if (mergeable[index] !== false) continue;
        if (this.isEdited(pr)) {
          this.log.info(`#${pr.number} has conflicts, but it was edited by someone else, so it is left alone.`);
          continue;
        }
        await this.attempt(`#${pr.number}`, () => this.recreate(pr, snapshot));
      }
    }
  }

  async mergeable(pr) {
    let mergeable = pr.mergeable;
    // GitHub works out mergeability in the background after the base moves.
    for (let attempt = 1; mergeable === null && attempt <= 5; attempt++) {
      await this.sleep(2000 * attempt);
      mergeable = (await this.github.getPull(pr.number)).mergeable;
    }
    return mergeable;
  }

  commentIgnores(pulls) {
    const rules = [];
    for (const pr of pulls) {
      if (pr.state !== 'closed' || pr.merged) continue;
      for (const rule of pr.meta.ignore ?? []) {
        let matches = null;
        if (rule.versions) {
          try {
            matches = parseRequirement(rule.versions);
          } catch {
            continue;
          }
        }
        rules.push({ name: rule.name, versions: rule.versions ?? null, from: rule.from ?? null, matches, pr: pr.number });
      }
    }
    return rules;
  }

  isIgnored(dep, version, ignores) {
    if (this.config.ignore.some((rule) => configIgnores(rule, dep.name, dep.current, version))) return true;
    return ignores.some((rule) => {
      if (rule.name !== dep.name) return false;
      if (!rule.matches) return true;
      // A range ignored from a comment stops counting once the project moves
      // into it by hand ("unless you ... upgrade to it yourself").
      const upgradedInto = rule.from && !rule.matches(rule.from) && rule.matches(dep.current);
      return rule.matches(version) && !upgradedInto;
    });
  }

  async updateUnit(unit, snapshot, pulls, ignores) {
    const row = { name: unit.name, current: unit.current, latest: '', result: '' };
    this.report.push(row);
    let lists;
    try {
      lists = await Promise.all(unit.deps.map((dep) => this.registry.versions(dep)));
    } catch (error) {
      row.result = 'Could not read versions';
      throw error;
    }
    const available = lists.reduce((common, list) => {
      const published = new Set(list);
      return common.filter((version) => published.has(version));
    });
    const prerelease = unit.sources.some((source) => isPrerelease(source.value));
    const newer = available.filter((version) => compareVersions(version, unit.current) > 0 && (prerelease || !isPrerelease(version)));
    row.latest = maxVersion(newer) ?? unit.current;
    const target = maxVersion(newer.filter((version) => !unit.deps.some((dep) => this.isIgnored(dep, version, ignores))));
    if (!target) {
      row.result = newer.length ? 'Newer versions are ignored' : 'Up to date';
      return;
    }

    const names = new Set(unit.deps.map((dep) => dep.name));
    const targetsOf = (pr) => pr.meta.dependencies.filter((update) => names.has(update.name));
    const related = pulls.filter((pr) => targetsOf(pr).length);
    const open = related.filter((pr) => pr.state === 'open' && pr.baseRef === snapshot.branch);

    const current = open.find((pr) => targetsOf(pr).every((update) => update.to === target));
    if (current) {
      row.result = `#${current.number} is open for ${target}`;
      return;
    }
    const skipped = related.find(
      (pr) => pr.state === 'closed' && !pr.merged && !BOT_CLOSE_REASONS.has(pr.meta.closed) && targetsOf(pr).some((update) => update.to === target),
    );
    if (skipped) {
      row.result = `Skipped; #${skipped.number} for ${target} was closed`;
      return;
    }
    const openCount = pulls.filter((pr) => pr.state === 'open' && pr.baseRef === snapshot.branch).length;
    if (!open.length && openCount >= this.config.openPullRequestsLimit) {
      row.result = `Not opened; the open-pull-requests-limit of ${this.config.openPullRequestsLimit} is reached`;
      return;
    }

    const pr = await this.openPull(new Map(unit.deps.map((dep) => [dep.name, target])), snapshot);
    pulls.push(pr);
    row.result = `Opened #${pr.number}`;
    for (const old of open) {
      await this.closePull(old, 'superseded', comments.superseded(pr.number));
      row.result += `, superseding #${old.number}`;
    }
  }

  async openPull(targets, snapshot) {
    const plan = planUpdate(snapshot, targets);
    if (!plan.files.size) throw new Error('There is nothing to change.');
    const description = await this.describe(plan);
    const branch = this.branchName(plan);
    const sha = await this.commit(snapshot, plan.files, description.commitMessage);
    await this.github.setBranch(branch, sha);
    const meta = {
      directory: this.config.directory,
      dependencies: plan.updates.map(({ name, from, to }) => ({ name, from, to })),
      head: sha,
    };
    let note = this.needsNote(this.tokenUser);
    let body = pullBody(description, meta, { note });
    const created = await this.github.createPull({ title: description.title, body, head: branch, base: snapshot.branch });
    this.tokenUser ??= created.author;
    if (!note && this.needsNote(created.author)) {
      note = true;
      body = pullBody(description, meta, { note });
      await this.github.updatePull(created.number, { body });
    }
    const pr = { ...created, body, meta, fresh: true };
    await this.decorate(pr);
    await this.dispatch(branch);
    this.log.info(`Opened #${pr.number}: ${description.title}`);
    return pr;
  }

  // Dependabot "rebases" by recreating the update on top of the latest base.
  async recreate(pr, snapshot) {
    if (pr.baseRef !== snapshot.branch) throw new Error(`#${pr.number} targets ${pr.baseRef}, but updates are made against ${snapshot.branch}.`);
    const plan = planUpdate(snapshot, new Map(pr.meta.dependencies.map((update) => [update.name, update.to])));
    if (!plan.files.size) {
      const stale = this.staleReason(pr, snapshot) ?? { reason: 'up-to-date', message: comments.upToDate(pr.meta.dependencies.map((update) => update.name)) };
      await this.closePull(pr, stale.reason, stale.message);
      return;
    }
    const description = await this.describe(plan);
    const sha = await this.commit(snapshot, plan.files, description.commitMessage);
    await this.github.setBranch(pr.headRef, sha);
    const meta = { ...pr.meta, dependencies: plan.updates.map(({ name, from, to }) => ({ name, from, to })), head: sha, closed: undefined };
    const body = pullBody(description, meta, { note: this.needsNote(pr.author) });
    await this.github.updatePull(pr.number, { title: description.title, body });
    Object.assign(pr, { title: description.title, body, meta, headSha: sha });
    await this.dispatch(pr.headRef);
    this.actions.push(`Rebased #${pr.number}`);
    this.log.info(`Rebased #${pr.number} onto ${snapshot.branch}.`);
  }

  async describe(plan) {
    const style = await this.commitStyle();
    const updates = [];
    const quoted = new Set();
    for (const update of plan.updates) {
      const repository = sourceRepository(update.name);
      let notes = '';
      // Artifacts of one project share its release notes; quote them once.
      if (repository && !quoted.has(repository)) {
        notes = releaseNotesHtml(update.name, repository, selectReleases(await this.releases(repository), update.from, update.to));
        if (notes) quoted.add(repository);
      }
      updates.push({ ...update, repository, notes });
    }
    const description = { updates, property: plan.property };
    const title = pullTitle(description, this.config.directory, style);
    return { ...description, title, commitMessage: commitMessage(description, title) };
  }

  releases(repository) {
    if (!this.releaseCache.has(repository)) {
      this.releaseCache.set(
        repository,
        this.github.releases(repository).catch((error) => {
          this.log.info(`Could not read the releases of ${repository}: ${error.message}`);
          return [];
        }),
      );
    }
    return this.releaseCache.get(repository);
  }

  // Mirrors Dependabot: an explicit prefix wins; otherwise follow the
  // repository's own commit style.
  async commitStyle() {
    if (this.style) return this.style;
    const { prefix, includeScope } = this.config.commitMessage;
    if (prefix) {
      const full = includeScope ? `${prefix}(deps)` : prefix;
      this.style = { prefix: /[\w)\]]$/.test(full) ? `${full}: ` : `${full} `, capitalize: !/^[a-z]/.test(prefix) };
      return this.style;
    }
    let subjects = [];
    try {
      const commits = await this.github.recentCommits((await this.base()).branch);
      subjects = commits.filter((commit) => commit.parents < 2 && !/\[bot\]$/.test(commit.author ?? '')).map((commit) => commit.message.split('\n')[0]);
    } catch (error) {
      this.log.info(`Could not read recent commits to match their style: ${error.message}`);
    }
    const share = (pattern) => (subjects.length ? subjects.filter((subject) => pattern.test(subject)).length / subjects.length : 0);
    if (share(CONVENTIONAL_COMMIT) >= 0.3) this.style = { prefix: 'build(deps): ', capitalize: false };
    else if (share(GITMOJI) >= 0.3) this.style = { prefix: '⬆️ ', capitalize: true };
    else this.style = { prefix: '', capitalize: true };
    return this.style;
  }

  branchName(plan) {
    const directory = this.config.directory === '/' ? [] : this.config.directory.slice(1).split('/');
    const name = plan.property ?? plan.updates.map((update) => update.name).join('-and-');
    const leaf = `${name}-${plan.updates[0].to}`
      .replace(/[^\w.-]+/g, '-')
      .replace(/\.{2,}/g, '.')
      .replace(/^[.-]+|[.-]+$/g, '');
    return [this.config.branchPrefix, 'gradle', ...directory, leaf].join(this.config.branchSeparator);
  }

  commit(snapshot, files, message) {
    const entries = new Map([...files].map(([path, content]) => [path, { content, mode: snapshot.modes.get(path) ?? '100644' }]));
    return this.github.createCommit({ parent: snapshot.sha, baseTree: snapshot.treeSha, files: entries, message });
  }

  async labels() {
    this.labelList ??= (async () => {
      const usable = [];
      for (const name of this.config.labels) {
        await this.soft(`Label "${name}"`, async () => {
          if (await this.github.labelExists(name)) {
            usable.push(name);
          } else if (DEFAULT_LABELS[name]) {
            await this.github.createLabel(name, DEFAULT_LABELS[name].color, DEFAULT_LABELS[name].description);
            usable.push(name);
          } else {
            this.log.warning(`The label "${name}" does not exist in this repository, so it is not added.`);
          }
        });
      }
      return usable;
    })();
    return this.labelList;
  }

  async decorate(pr) {
    const labels = await this.labels();
    if (labels.length) await this.soft(`Labelling #${pr.number}`, () => this.github.addLabels(pr.number, labels));
    if (this.config.assignees.length) await this.soft(`Assigning #${pr.number}`, () => this.github.addAssignees(pr.number, this.config.assignees));
    if (this.config.reviewers.length) {
      const teams = this.config.reviewers.filter((reviewer) => reviewer.includes('/')).map((reviewer) => reviewer.split('/').pop());
      const users = this.config.reviewers.filter((reviewer) => !reviewer.includes('/'));
      await this.soft(`Requesting reviews on #${pr.number}`, () => this.github.requestReviewers(pr.number, users, teams));
    }
    if (this.config.milestone) await this.soft(`Setting the milestone of #${pr.number}`, () => this.github.setMilestone(pr.number, this.config.milestone));
  }

  // PRs opened with GITHUB_TOKEN don't trigger workflows, but workflow_dispatch does.
  async dispatch(branch) {
    for (const workflow of this.config.dispatchWorkflows) {
      await this.soft(`Starting ${workflow} on ${branch}`, async () => {
        await this.github.dispatchWorkflow(workflow, branch);
        this.log.info(`Started ${workflow} on ${branch}.`);
      });
    }
  }

  async onPush(payload) {
    const base = await this.base();
    if (payload.ref && payload.ref !== `refs/heads/${base.branch}`) {
      this.log.info(`${payload.ref} is not ${base.branch}; nothing to do.`);
      return;
    }
    await this.reconcile({ checkForUpdates: false });
  }

  async onPullRequest(payload) {
    const number = payload.pull_request?.number;
    if (!number || !['closed', 'reopened'].includes(payload.action)) return;
    const pr = await this.loadPull(number);
    if (!pr) {
      this.log.info(`#${number} was not opened by ${NAME}; nothing to do.`);
      return;
    }
    if (payload.action === 'closed') {
      if (!pr.merged && !pr.meta.closed) {
        await this.saveMeta(pr, { ...pr.meta, closed: 'user', automerge: undefined });
        await this.github.comment(pr.number, comments.closed());
      }
      await this.github.deleteBranch(pr.headRef);
      return;
    }
    await this.saveMeta(pr, { ...pr.meta, closed: undefined, ignore: undefined });
    if (!this.isEdited(pr)) await this.recreate(pr, await this.snapshot());
  }

  async onComment(payload) {
    if ((payload.action && payload.action !== 'created') || !payload.issue?.pull_request) return;
    const command = parseCommand(payload.comment?.body);
    if (!command || payload.comment.user?.type === 'Bot') return;
    const pr = await this.loadPull(payload.issue.number);
    if (!pr) {
      this.log.info(`#${payload.issue.number} was not opened by ${NAME}; ignoring the command.`);
      return;
    }
    const user = payload.comment.user.login;
    if (!(await this.canPush(user, payload.comment.author_association))) {
      await this.github.comment(pr.number, comments.noPermission());
      return;
    }
    if (command.type === 'unknown') {
      await this.soft('Reacting to the comment', () => this.github.react(payload.comment.id, 'confused'));
      await this.github.comment(pr.number, comments.unknown());
      return;
    }
    await this.soft('Reacting to the comment', () => this.github.react(payload.comment.id, '+1'));
    this.log.info(`@${user} asked for "${command.type}" on #${pr.number}.`);
    await this.execute(command, pr, user);
  }

  async canPush(user, association) {
    try {
      return ['admin', 'write'].includes(await this.github.permission(user));
    } catch (error) {
      this.log.warning(`Could not read ${user}'s permission (${error.message}); using their association with the repository instead.`);
      return ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association);
    }
  }

  async execute(command, pr, user) {
    switch (command.type) {
      case 'rebase':
      case 'recreate':
        if (pr.state !== 'open') return this.github.comment(pr.number, pr.merged ? comments.alreadyMerged() : comments.notOpen());
        if (command.type === 'rebase' && this.isEdited(pr)) return this.github.comment(pr.number, comments.edited());
        return this.recreate(pr, await this.snapshot());
      case 'merge':
      case 'squash and merge':
        return this.requestMerge(pr, user, command.type === 'merge' ? 'merge' : 'squash');
      case 'cancel merge':
        if (pr.autoMerge) await this.github.disableAutoMerge(pr.id);
        return this.saveMeta(pr, { ...pr.meta, automerge: undefined });
      case 'reopen':
        return this.reopen(pr);
      case 'close':
        if (pr.state === 'open') await this.closePull(pr, 'user', comments.closed());
        return undefined;
      case 'ignore':
        return this.ignore(pr, command);
      case 'unignore':
        return this.unignore(pr, command);
      case 'show':
        return this.showIgnores(pr, command.dependency);
    }
    return undefined;
  }

  async requestMerge(pr, user, method) {
    if (pr.state !== 'open') return this.github.comment(pr.number, pr.merged ? comments.alreadyMerged() : comments.notOpen());
    const { repo } = await this.base();
    if (method === 'merge' && repo.allowMergeCommit === false) method = repo.allowSquashMerge === false ? 'rebase' : 'squash';
    try {
      await this.github.enableAutoMerge(pr.id, method);
    } catch (error) {
      // Nothing left to wait for: GitHub won't queue it, so merge right away.
      if (/clean status/i.test(error.message)) return this.github.mergePull(pr.number, method);
      return this.github.comment(pr.number, comments.autoMergeFailed(error.message));
    }
    return this.saveMeta(pr, { ...pr.meta, automerge: { by: user, method } });
  }

  async reopen(pr) {
    if (pr.state === 'open') return;
    if (pr.merged) {
      await this.github.comment(pr.number, comments.alreadyMerged());
      return;
    }
    if (!(await this.github.branchExists(pr.headRef))) await this.github.setBranch(pr.headRef, pr.headSha);
    await this.github.updatePull(pr.number, { state: 'open' });
    pr.state = 'open';
    await this.saveMeta(pr, { ...pr.meta, closed: undefined, ignore: undefined });
    if (!this.isEdited(pr)) await this.recreate(pr, await this.snapshot());
  }

  async ignore(pr, command) {
    if (pr.merged) {
      await this.github.comment(pr.number, comments.alreadyMerged());
      return;
    }
    const updates = command.dependency
      ? pr.meta.dependencies.filter((update) => update.name.toLowerCase() === command.dependency.toLowerCase())
      : pr.meta.dependencies;
    if (!updates.length) {
      await this.github.comment(pr.number, comments.notInPull(command.dependency));
      return;
    }
    const added = updates.map((update) =>
      command.scope === 'dependency'
        ? { name: update.name, versions: null }
        : { name: update.name, versions: ignoreRequirement(command.scope, update.to), from: update.from },
    );
    const kept = (pr.meta.ignore ?? []).filter((rule) => !added.some((add) => add.name === rule.name && add.versions === rule.versions));
    const ignore = [...kept, ...added];
    const message =
      command.scope === 'dependency'
        ? comments.ignoredDependency(updates.map((update) => update.name))
        : comments.ignoredVersion(versionLabel(command.scope, updates[0].to), command.dependency ? updates[0].name : null);
    if (pr.state === 'open') {
      await this.closePull(pr, 'user', message, { ...pr.meta, ignore });
      return;
    }
    await this.saveMeta(pr, { ...pr.meta, ignore, closed: 'user' });
    await this.github.comment(pr.number, message);
  }

  async unignore(pr, command) {
    const names = command.dependency ? [command.dependency.toLowerCase()] : pr.meta.dependencies.map((update) => update.name.toLowerCase());
    const pulls = await this.pulls();
    const removed = [];
    for (const other of pulls) {
      const rules = other.meta.ignore ?? [];
      const kept = rules.filter(
        (rule) => !(names.includes(rule.name.toLowerCase()) && (!command.condition || command.condition === (rule.versions ?? 'all versions'))),
      );
      if (kept.length === rules.length) continue;
      removed.push(...rules.filter((rule) => !kept.includes(rule)));
      // A PR closed only to ignore versions should not keep its own version skipped either.
      const closed = other.state === 'closed' && other.meta.closed === 'user' ? 'unignored' : other.meta.closed;
      await this.saveMeta(other, { ...other.meta, ignore: kept.length ? kept : undefined, closed });
    }
    if (!removed.length) {
      await this.github.comment(
        pr.number,
        `There are no ignore conditions for ${joinWords(names.map((name) => `\`${name}\``))} that were added with \`${HANDLE}\` commands. Conditions from the workflow's \`ignore\` input can only be changed in the workflow.`,
      );
      return;
    }
    const list = removed.map((rule) => `- \`${rule.name}\`: ${rule.versions ? `\`${rule.versions}\`` : 'all versions'}`).join('\n');
    await this.github.comment(pr.number, `OK, I've removed these ignore conditions:\n${list}\n\nI'll check for updates again now.`);
    await this.reconcile({ checkForUpdates: true });
  }

  async showIgnores(pr, name) {
    const rows = [];
    for (const rule of this.config.ignore) {
      if (!rule.pattern.test(name)) continue;
      const conditions = [
        ...(rule.versions ? [`[${rule.versions.join(', ')}]`] : []),
        ...(rule.updateTypes ? [`update-types: ${[...rule.updateTypes].map((type) => `version-update:semver-${type}`).join(', ')}`] : []),
      ];
      rows.push([rule.name, conditions.join('; ') || 'all versions', "the workflow's `ignore` input"]);
    }
    for (const rule of this.commentIgnores(await this.pulls())) {
      if (rule.name.toLowerCase() === name.toLowerCase()) rows.push([rule.name, rule.versions ? `[${rule.versions}]` : 'all versions', `#${rule.pr}`]);
    }
    const body = rows.length
      ? [
          `${NAME} is ignoring the following conditions for \`${name}\`:`,
          '',
          '| Dependency Name | Ignore Conditions | Set in |',
          '| --- | --- | --- |',
          ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
        ].join('\n')
      : `There are no ignore conditions for \`${name}\`.`;
    await this.github.comment(pr.number, body);
  }

  summary() {
    if (!this.report.length && !this.actions.length) return '';
    const lines = [`## ${NAME}`, ''];
    if (this.report.length) {
      lines.push('| Dependency | Current | Latest | Result |', '| --- | --- | --- | --- |');
      for (const row of this.report) lines.push(`| \`${cell(row.name)}\` | ${row.current} | ${row.latest || '-'} | ${cell(row.result)} |`);
      lines.push('');
    }
    for (const action of this.actions) lines.push(`- ${action}`);
    return lines.join('\n');
  }
}
