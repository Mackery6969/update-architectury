import { parseRequirement, updateType } from './version.js';
import { parseYaml } from './yaml.js';

export const DEFAULT_LABELS = {
  dependencies: { color: '0366d6', description: 'Pull requests that update a dependency file' },
  java: { color: 'b07219', description: 'Pull requests that update Java code' },
};

export function globPattern(pattern) {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  // Every regex metacharacter is escaped above; only `*` becomes `.*`, from the workflow's own config.
  return new RegExp(`^${source}$`, 'i'); // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
}

// Architectury's Gradle plugins and its dev.architectury artifacts.
export function isArchitectury({ kind, name }) {
  if (kind === 'plugin') return name === 'architectury-plugin' || name.startsWith('dev.architectury.');
  return name.startsWith('dev.architectury:');
}

export function normalizeDirectory(directory) {
  const trimmed = directory.trim().replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}` : '/';
}

function readList(value) {
  return (value ?? '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function readBoolean(value, name) {
  const text = (value ?? '').trim().toLowerCase();
  if (!text || text === 'false') return false;
  if (text === 'true') return true;
  throw new Error(`The ${name} input must be true or false.`);
}

function normalizeUpdateType(value) {
  const match = /^(?:version-update:semver-)?(major|minor|patch)$/.exec(String(value).trim());
  if (!match) throw new Error(`Unknown update type "${value}"; use version-update:semver-major, -minor or -patch.`);
  return match[1];
}

export function parseIgnore(text) {
  const data = parseYaml(text, 'the ignore input');
  if (data == null) return [];
  if (!Array.isArray(data)) throw new Error('The ignore input must be a list of ignore conditions.');
  return data.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || typeof entry['dependency-name'] !== 'string') {
      throw new Error(`Ignore condition ${index + 1} needs a dependency-name.`);
    }
    const unknown = Object.keys(entry).filter((key) => !['dependency-name', 'versions', 'update-types'].includes(key));
    if (unknown.length) throw new Error(`Ignore condition ${index + 1} has unknown keys: ${unknown.join(', ')}.`);
    const versions = entry.versions == null ? null : [].concat(entry.versions).map(String);
    const updateTypes = entry['update-types'] == null ? null : new Set([].concat(entry['update-types']).map(normalizeUpdateType));
    return {
      name: entry['dependency-name'],
      pattern: globPattern(entry['dependency-name']),
      versions,
      requirements: versions?.map((version) => parseRequirement(version)) ?? null,
      updateTypes,
    };
  });
}

// Whether an ignore condition from the workflow rules out moving `name`
// from `current` to `candidate`.
export function configIgnores(rule, name, current, candidate) {
  if (!rule.pattern.test(name)) return false;
  if (!rule.requirements && !rule.updateTypes) return true;
  if (rule.requirements?.some((matches) => matches(candidate))) return true;
  return Boolean(rule.updateTypes?.has(updateType(current, candidate)));
}

export function parseAllow(text) {
  const data = parseYaml(text, 'the allow input');
  if (data == null) return [];
  return [].concat(data).map((entry, index) => {
    const name = typeof entry === 'string' ? entry : entry?.['dependency-name'];
    if (typeof name !== 'string') throw new Error(`Allow entry ${index + 1} needs a dependency-name.`);
    return globPattern(name);
  });
}

export function loadConfig(env = process.env) {
  const input = (name) => env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`];
  const text = (name, fallback = '') => input(name)?.trim() || fallback;

  const limitText = text('open-pull-requests-limit', '5');
  const limit = Number(limitText);
  if (!Number.isInteger(limit) || limit < 0) throw new Error('open-pull-requests-limit must be a whole number.');

  const rebaseStrategy = text('rebase-strategy', 'auto');
  if (!['auto', 'disabled'].includes(rebaseStrategy)) throw new Error('rebase-strategy must be "auto" or "disabled".');

  const include = text('commit-message-include');
  if (include && include !== 'scope') throw new Error('commit-message-include only supports "scope".');

  const milestone = text('milestone');
  if (milestone && !/^\d+$/.test(milestone)) throw new Error('milestone must be a milestone number.');

  const separator = text('branch-separator', '/');
  const prefix = text('branch-prefix', 'architectury-updates');
  if (/[\s~^:?*[\\]/.test(prefix + separator)) throw new Error('branch-prefix and branch-separator must be valid in branch names.');

  const allow = parseAllow(input('allow'));
  return {
    token: text('token'),
    directory: normalizeDirectory(text('directory', '/')),
    targetBranch: text('target-branch'),
    registry: text('registry', 'https://maven.architectury.dev/'),
    openPullRequestsLimit: limit,
    labels: input('labels') === undefined ? Object.keys(DEFAULT_LABELS) : readList(input('labels')),
    assignees: readList(input('assignees')),
    reviewers: readList(input('reviewers')),
    milestone: milestone ? Number(milestone) : null,
    commitMessage: { prefix: input('commit-message-prefix')?.trim() || null, includeScope: include === 'scope' },
    rebaseStrategy,
    branchPrefix: prefix,
    branchSeparator: separator,
    ignore: parseIgnore(input('ignore')),
    include: (dep) => isArchitectury(dep) && (!allow.length || allow.some((pattern) => pattern.test(dep.name))),
    dispatchWorkflows: readList(input('dispatch-workflows')),
    dryRun: readBoolean(input('dry-run'), 'dry-run'),
  };
}
