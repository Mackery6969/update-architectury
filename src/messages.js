// Every text the bot writes. Wording follows Dependabot's so the pull
// requests read the same as the Dependabot ones next to them.
import { minVersion, updateType } from './version.js';

export const NAME = 'Architectury Updates';
export const HANDLE = '@architectury-updates';

const METADATA = /<!-- architectury-updates:metadata (\{[\s\S]*?\}) -->/;
const AUTOMERGE = /\[\/\/\]: # \(architectury-updates-automerge-start\)[\s\S]*?\[\/\/\]: # \(architectury-updates-automerge-end\)/;

export function joinWords(words) {
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

const link = (update) => (update.repository ? `[${update.name}](https://github.com/${update.repository})` : update.name);

export function pullTitle({ updates, property }, directory, style) {
  const bump = style.capitalize ? 'Bump' : 'bump';
  let subject;
  if (updates.length === 1) subject = `${updates[0].name} from ${updates[0].from} to ${updates[0].to}`;
  else if (property) subject = `${property} from ${minVersion(updates.map((u) => u.from))} to ${updates[0].to}`;
  else subject = joinWords(updates.map((u) => u.name));
  return `${style.prefix}${bump} ${subject}${directory === '/' ? '' : ` in ${directory}`}`;
}

// The opening sentence for a pull request that moves several dependencies.
function groupHeading({ updates, property }) {
  return property
    ? `Bumps \`${property}\` from ${minVersion(updates.map((u) => u.from))} to ${updates[0].to}.`
    : `Bumps ${joinWords(updates.map(link))}. These dependencies needed to be updated together.`;
}

function intro({ updates, property }) {
  if (updates.length === 1) {
    const [update] = updates;
    return [`Bumps ${link(update)} from ${update.from} to ${update.to}.`, update.notes].filter(Boolean).join('\n');
  }
  const heading = groupHeading({ updates, property });
  const sections = updates.map((update) => [`Updates \`${update.name}\` from ${update.from} to ${update.to}`, update.notes].filter(Boolean).join('\n'));
  return [heading, sections.join('\n\n')].join('\n');
}

export function commitMessage(description, title) {
  const lines = [title, ''];
  const notes = (update) => (update.notes ? [`- [Release notes](https://github.com/${update.repository}/releases)`] : []);
  if (description.updates.length === 1) {
    const [update] = description.updates;
    lines.push(`Bumps ${link(update)} from ${update.from} to ${update.to}.`, ...notes(update));
  } else {
    lines.push(groupHeading(description));
    for (const update of description.updates) lines.push('', `Updates \`${update.name}\` from ${update.from} to ${update.to}`, ...notes(update));
  }
  lines.push('', '---', 'updated-dependencies:');
  for (const update of description.updates) {
    lines.push(
      `- dependency-name: ${update.name}`,
      `  dependency-version: ${update.to}`,
      '  dependency-type: direct:production',
      `  update-type: version-update:semver-${updateType(update.from, update.to)}`,
    );
  }
  lines.push('...', '');
  return lines.join('\n');
}

export function automergeText(meta) {
  if (!meta.automerge) return '';
  const verb = meta.automerge.method === 'squash' ? 'squash and merge' : 'merge';
  return `${NAME} will ${verb} this PR once CI passes on it, as requested by @${meta.automerge.by}.`;
}

function automergeBlock(meta) {
  const text = automergeText(meta);
  return ['[//]: # (architectury-updates-automerge-start)', ...(text ? [text, ''] : []), '[//]: # (architectury-updates-automerge-end)'].join('\n');
}

export function encodeMeta(meta) {
  const clean = Object.fromEntries(Object.entries(meta).filter(([, value]) => value !== undefined && value !== null));
  // "--" may not appear inside an HTML comment.
  return `<!-- architectury-updates:metadata ${JSON.stringify(clean).replace(/--/g, '-\\u002d')} -->`;
}

export function readMeta(body) {
  // The bot's own block is always the last one in the description.
  const match = [...(body ?? '').matchAll(new RegExp(METADATA.source, 'g'))].at(-1);
  if (!match) return null;
  try {
    const meta = JSON.parse(match[1]);
    return Array.isArray(meta.dependencies) && typeof meta.directory === 'string' ? meta : null;
  } catch {
    return null;
  }
}

// Rewrites the parts of an existing body that depend on the metadata.
export function patchBody(body, meta) {
  return body.replace(AUTOMERGE, () => automergeBlock(meta)).replace(METADATA, () => encodeMeta(meta));
}

export const ciNote = [
  '> [!NOTE]',
  "> This PR was opened with the default `GITHUB_TOKEN`, so GitHub won't start your other workflows (such as CI) for it. List them in the action's `dispatch-workflows` input to have them started on every update.",
].join('\n');

export const commandsHelp = [
  '<details>',
  `<summary>${NAME} commands and options</summary>`,
  '<br />',
  '',
  `You can trigger ${NAME} actions by commenting on this PR:`,
  `- \`${HANDLE} rebase\` will rebase this PR`,
  `- \`${HANDLE} recreate\` will recreate this PR, overwriting any edits that have been made to it`,
  `- \`${HANDLE} merge\` will merge this PR after your CI passes on it`,
  `- \`${HANDLE} squash and merge\` will squash and merge this PR after your CI passes on it`,
  `- \`${HANDLE} cancel merge\` will cancel a previously requested merge and block automerging`,
  `- \`${HANDLE} reopen\` will reopen this PR if it is closed`,
  `- \`${HANDLE} close\` will close this PR and stop ${NAME} recreating it. You can achieve the same result by closing it manually`,
  `- \`${HANDLE} show <dependency name> ignore conditions\` will show all of the ignore conditions of the specified dependency`,
  `- \`${HANDLE} ignore this major version\` will close this PR and stop ${NAME} creating any more for this major version (unless you reopen the PR or upgrade to it yourself)`,
  `- \`${HANDLE} ignore this minor version\` will close this PR and stop ${NAME} creating any more for this minor version (unless you reopen the PR or upgrade to it yourself)`,
  `- \`${HANDLE} ignore this dependency\` will close this PR and stop ${NAME} creating any more for this dependency (unless you reopen the PR or upgrade to it yourself)`,
  '',
  '</details>',
].join('\n');

export function pullBody(description, meta, { note = false } = {}) {
  const top = intro(description);
  return [
    top,
    ...(top.includes('</details>') ? ['<br />'] : []),
    '',
    '',
    ...(note ? [ciNote, ''] : []),
    `${NAME} will resolve any conflicts with this PR as long as you don't alter it yourself. You can also trigger a rebase manually by commenting \`${HANDLE} rebase\`.`,
    '',
    automergeBlock(meta),
    '',
    '---',
    '',
    commandsHelp,
    '',
    encodeMeta(meta),
  ].join('\n');
}

const subject = (names) => (names.length === 1 ? `${names[0]} is` : 'these dependencies are');

export const comments = {
  superseded: (number) => `Superseded by #${number}.`,
  upToDate: (names) => `Looks like ${subject(names)} up-to-date now, so this is no longer needed.`,
  removed: (names) => `Looks like ${subject(names)} no longer ${names.length === 1 ? 'a dependency' : 'dependencies'}, so this is no longer needed.`,
  notUpdatable: (names) => `Looks like ${subject(names)} no longer updatable, so this is no longer needed.`,
  closed: () =>
    [
      `OK, I won't notify you again about this release, but will get in touch when a new version is available. If you'd rather skip all updates until the next major or minor version, let me know by commenting \`${HANDLE} ignore this major version\` or \`${HANDLE} ignore this minor version\`. You can also ignore all major, minor, or patch releases for a dependency by adding an \`ignore\` condition with the desired \`update-types\` to your workflow.`,
      '',
      `If you change your mind, just re-open this PR (or comment \`${HANDLE} reopen\`) and I'll resolve any conflicts on it.`,
    ].join('\n'),
  ignoredVersion: (label, name) => `OK, I won't notify you about ${name ? `${name} ` : ''}version ${label} again, unless you re-open this PR.`,
  ignoredDependency: (names) => `OK, I won't notify you about ${joinWords(names)} again, unless you re-open this PR.`,
  edited: () =>
    `Looks like this PR has been edited by someone other than ${NAME}. That means ${NAME} can't rebase it - sorry! If you're happy for ${NAME} to recreate it from scratch, overwriting any edits, you can request \`${HANDLE} recreate\`.`,
  noPermission: () => 'Sorry, only users with push access can use that command.',
  unknown: () => `Sorry, I don't know how to do that. The commands I understand are listed under "${NAME} commands and options" in the PR description.`,
  notOpen: () => `This PR is closed, so I can't do that. Comment \`${HANDLE} reopen\` to reopen it first.`,
  alreadyMerged: () => 'This PR has already been merged.',
  notInPull: (name) => `Sorry, \`${name}\` isn't updated by this PR.`,
  autoMergeFailed: (reason) =>
    [
      `I couldn't set this PR to merge once CI passes: ${reason}`,
      '',
      `${NAME} uses GitHub's auto-merge for this, so "Allow auto-merge" has to be enabled in the repository settings and the target branch needs at least one required status check.`,
    ].join('\n'),
};
