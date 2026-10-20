import { compareVersions, isPrerelease, versionParts } from './version.js';

// Architectury publishes no <scm> in its POMs, so the source repositories
// are known up front.
const SOURCES = [
  [/^dev\.architectury\.loom(?:[.-].*)?$/, 'architectury/architectury-loom'],
  [/^dev\.architectury:architectury-loom$/, 'architectury/architectury-loom'],
  [/^architectury-plugin$/, 'architectury/architectury-plugin'],
  [/^dev\.architectury:architectury(?:-common|-fabric|-forge|-neoforge)?$/, 'architectury/architectury-api'],
  [/^dev\.architectury:architectury-transformer$/, 'architectury/architectury-transformer'],
];

export function sourceRepository(name) {
  return SOURCES.find(([pattern]) => pattern.test(name))?.[1] ?? null;
}

const tagVersion = (tag) => tag.replace(/^v(?=\d)/i, '');

function truncate(version, parts) {
  const numbers = [];
  for (const part of versionParts(version)) {
    if (!/^\d+$/.test(part) || numbers.length === parts) break;
    numbers.push(part);
  }
  return numbers.join('.');
}

// Releases between `from` (exclusive) and `to` (inclusive). Architectury
// tags releases per line ("1.17" covers every 1.17.x build), so a tag is
// compared with the versions cut down to the tag's precision.
export function selectReleases(releases, from, to) {
  return releases
    .filter((release) => !release.draft && (!release.prerelease || isPrerelease(to)))
    .filter((release) => {
      const version = tagVersion(release.tag);
      if (!/^\d+(\.\d+)*$/.test(version)) return false;
      const parts = version.split('.').length;
      return compareVersions(version, truncate(from, parts)) > 0 && compareVersions(version, truncate(to, parts)) <= 0;
    })
    .sort((a, b) => compareVersions(tagVersion(b.tag), tagVersion(a.tag)))
    .slice(0, 5);
}

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Release notes are quoted the way Dependabot quotes them: mentions can't
// ping anyone, and issue links go through redirect.github.com so they don't
// add "mentioned this" events to the upstream issues. Hidden markdown
// (comments, link definitions) is escaped so it can't pose as the bot's metadata.
export function sanitizeNotes(text, repository) {
  return text
    .replace(/<!--/g, '&lt;!--')
    .replace(/\[\/\/\]:/g, '\\[//\\]:')
    .replace(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+\/(?:issues|pull|discussions)\/\d+)/g, 'https://redirect.github.com/$1')
    .replace(/(^|[^\w/`[])([\w.-]+\/[\w.-]+)#(\d+)\b/g, (match, before, repo, number) => `${before}[${repo}#${number}](https://redirect.github.com/${repo}/issues/${number})`)
    .replace(/(^|[^\w/&`[])#(\d+)\b/g, (match, before, number) => `${before}[#${number}](https://redirect.github.com/${repository}/issues/${number})`)
    .replace(/(^|[^\w`])@([A-Za-z0-9][A-Za-z0-9-]{0,38})\b/g, '$1@​$2');
}

function clip(notes, budget) {
  if (notes.length <= budget) return notes;
  let clipped = notes.slice(0, Math.max(budget, 0));
  clipped = clipped.slice(0, Math.max(clipped.lastIndexOf('\n'), 0));
  if ((clipped.match(/^\s*```/gm) ?? []).length % 2) clipped += '\n```';
  return `${clipped}\n\n... (truncated)`;
}

export function releaseNotesHtml(name, repository, releases) {
  if (!releases.length) return '';
  const parts = [
    '<details>',
    '<summary>Release notes</summary>',
    `<p><em>Sourced from <a href="https://github.com/${repository}/releases">${escapeHtml(name)}'s releases</a>.</em></p>`,
    '<blockquote>',
  ];
  let budget = 12_000;
  for (const release of releases) {
    if (budget <= 0) break;
    const notes = clip(sanitizeNotes(release.body, repository).trim(), budget);
    budget -= notes.length;
    parts.push(`<h2>${escapeHtml(release.name || release.tag)}</h2>`, '', notes || '<em>No release notes.</em>', '');
  }
  parts.push('</blockquote>', '</details>');
  return parts.join('\n');
}
