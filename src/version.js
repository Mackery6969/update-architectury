// Version ordering follows Gradle's rules, because the versions being compared
// are the ones Gradle resolves: https://docs.gradle.org/current/userguide/dependency_versions.html#sec:version-ordering

const SPECIAL_MEANINGS = new Map([
  ['dev', -1],
  ['rc', 1],
  ['snapshot', 2],
  ['final', 3],
  ['ga', 4],
  ['release', 5],
  ['sp', 6],
]);

// Qualifiers that still mean "a release"; any other qualifier (beta, SNAPSHOT,
// PR, rc, ...) makes a version a pre-release.
const RELEASE_QUALIFIERS = new Set(['final', 'ga', 'release', 'sp']);

const isNumeric = (part) => /^\d+$/.test(part);

export function versionParts(version) {
  const parts = [];
  for (const segment of String(version).split(/[.\-_+]/)) {
    for (const [part] of segment.matchAll(/\d+|\D+/g)) parts.push(part);
  }
  return parts;
}

function compareNumbers(a, b) {
  const x = a.replace(/^0+(?=\d)/, '');
  const y = b.replace(/^0+(?=\d)/, '');
  if (x.length !== y.length) return Math.sign(x.length - y.length);
  return x < y ? -1 : x > y ? 1 : 0;
}

function compareStrings(a, b) {
  const x = SPECIAL_MEANINGS.get(a.toLowerCase());
  const y = SPECIAL_MEANINGS.get(b.toLowerCase());
  if (x !== undefined || y !== undefined) return Math.sign((x ?? 0) - (y ?? 0));
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareVersions(a, b) {
  const x = versionParts(a);
  const y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    // An extra numeric part makes a version higher (1.1 < 1.1.0); an extra
    // qualifier makes it lower (1.1-rc < 1.1).
    if (i >= x.length) return isNumeric(y[i]) ? -1 : 1;
    if (i >= y.length) return isNumeric(x[i]) ? 1 : -1;
    const xn = isNumeric(x[i]);
    const yn = isNumeric(y[i]);
    const result = xn && yn ? compareNumbers(x[i], y[i]) : xn ? 1 : yn ? -1 : compareStrings(x[i], y[i]);
    if (result) return result;
  }
  return 0;
}

// The first version for which `sign` agrees with the comparison against the best so far.
function pickVersion(versions, sign) {
  let best = null;
  for (const version of versions) {
    if (best === null || Math.sign(compareVersions(version, best)) === sign) best = version;
  }
  return best;
}

export function maxVersion(versions) {
  return pickVersion(versions, 1);
}

export function minVersion(versions) {
  return pickVersion(versions, -1);
}

export function isPrerelease(version) {
  return versionParts(version).some((part) => !isNumeric(part) && !RELEASE_QUALIFIERS.has(part.toLowerCase()));
}

// Dynamic versions are resolved by Gradle at build time; like Dependabot, leave them alone.
export function isDynamic(version) {
  const value = version.trim();
  return !value || /\s/.test(value) || /(^|\.)\+$/.test(value) || /^latest\./i.test(value) || /[\[\](),]/.test(value);
}

function numericPrefix(version) {
  const numbers = [];
  for (const part of versionParts(version)) {
    if (!isNumeric(part)) break;
    numbers.push(Number(part));
  }
  return numbers;
}

export function updateType(from, to) {
  const f = numericPrefix(from);
  const t = numericPrefix(to);
  if ((t[0] ?? 0) !== (f[0] ?? 0)) return 'major';
  if ((t[1] ?? 0) !== (f[1] ?? 0)) return 'minor';
  return 'patch';
}

// The requirement Dependabot records for "ignore this major/minor version".
export function ignoreRequirement(kind, version) {
  const [major = 0, minor = 0] = numericPrefix(version);
  if (kind === 'major') return `>= ${major}.a, < ${major + 1}`;
  return `>= ${major}.${minor}.a, < ${major}.${minor + 1}`;
}

export function versionLabel(kind, version) {
  const [major = 0, minor = 0] = numericPrefix(version);
  return kind === 'major' ? `${major}.x.x` : `${major}.${minor}.x`;
}

// Requirements accept the syntaxes Dependabot users write for Gradle/Maven:
// "1.2.3", ">= 1.0, < 2", "1.x", "1.2.*", "~> 1.2", "^1.2", Maven ranges
// such as "[1.0,2.0)" or "(,1.0],[1.2,)", and alternatives joined by "||".
export function parseRequirement(text) {
  const source = String(text).trim();
  if (!source) throw new Error('Empty version requirement');
  const alternatives = source.split('||').map((part) => part.trim());
  if (alternatives.some((part) => !part)) throw new Error(`Invalid version requirement "${source}"`);
  const predicates = alternatives.map((part) => (/^[\[(]/.test(part) ? mavenRanges(part, source) : clauses(part, source)));
  return (version) => predicates.some((predicate) => predicate(version));
}

function mavenRanges(text, source) {
  const ranges = [];
  let rest = text;
  while (rest) {
    const match = /^\s*([\[(])([^\])]*)([\])])\s*(?:,|$)/.exec(rest);
    if (!match) throw new Error(`Invalid version range "${source}"`);
    const [, open, inner, close] = match;
    rest = rest.slice(match[0].length);
    if (!inner.includes(',')) {
      const exact = inner.trim();
      if (!exact || open !== '[' || close !== ']') throw new Error(`Invalid version range "${source}"`);
      ranges.push((v) => compareVersions(v, exact) === 0);
      continue;
    }
    const [low, high] = inner.split(',').map((part) => part.trim());
    ranges.push((v) => {
      if (low && (open === '[' ? compareVersions(v, low) < 0 : compareVersions(v, low) <= 0)) return false;
      if (high && (close === ']' ? compareVersions(v, high) > 0 : compareVersions(v, high) >= 0)) return false;
      return true;
    });
  }
  return (version) => ranges.some((range) => range(version));
}

function clauses(text, source) {
  const predicates = text.split(',').map((clause) => {
    const match = /^(~>|>=|<=|!=|==|=|>|<|\^|~)?\s*([\w*][^\s]*)$/.exec(clause.trim());
    if (!match) throw new Error(`Invalid version requirement "${source}"`);
    return clausePredicate(match[1] ?? '', match[2]);
  });
  return (version) => predicates.every((predicate) => predicate(version));
}

function clausePredicate(op, version) {
  if (version === '*' || version.toLowerCase() === 'x') return () => true;
  if (!op && /(^|[.\-])[x*]$/i.test(version)) {
    const prefix = numericPrefix(version.replace(/[.\-]?[x*]$/i, ''));
    return (v) => {
      const parts = numericPrefix(v);
      return prefix.every((n, i) => parts[i] === n);
    };
  }
  const cmp = (v) => compareVersions(v, version);
  switch (op) {
    case '':
    case '=':
    case '==':
      return (v) => cmp(v) === 0;
    case '!=':
      return (v) => cmp(v) !== 0;
    case '>':
      return (v) => cmp(v) > 0;
    case '>=':
      return (v) => cmp(v) >= 0;
    case '<':
      return (v) => cmp(v) < 0;
    case '<=':
      return (v) => cmp(v) <= 0;
    case '~>': {
      const parts = numericPrefix(version);
      const upper = parts.length > 1 ? [...parts.slice(0, -2), parts[parts.length - 2] + 1].join('.') : String(parts[0] + 1);
      return (v) => cmp(v) >= 0 && compareVersions(v, upper) < 0;
    }
    case '^': {
      const [major = 0] = numericPrefix(version);
      return (v) => cmp(v) >= 0 && compareVersions(v, String(major + 1)) < 0;
    }
    case '~': {
      const [major = 0, minor = 0] = numericPrefix(version);
      return (v) => cmp(v) >= 0 && compareVersions(v, `${major}.${minor + 1}`) < 0;
    }
  }
  throw new Error(`Unsupported operator "${op}"`);
}
