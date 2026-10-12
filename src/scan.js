import { parseCatalog } from './catalog.js';
import { lexGradle, readTemplate } from './lexer.js';
import { isDynamic } from './version.js';

const SCRIPT = /\.gradle(\.kts)?$/;
const PLUGIN_ID = /^[A-Za-z][\w-]*(?:\.[\w-]+)*$/;
const COORDINATE = /^([\w.-]+):([\w.-]+):(.+)$/;
const EXCLUDED_DIRECTORIES = new Set(['.git', '.gradle', '.idea', 'build', 'node_modules', 'out', 'run']);

export const dirname = (path) => path.slice(0, Math.max(path.lastIndexOf('/'), 0));
const basename = (path) => path.slice(path.lastIndexOf('/') + 1);

function ancestors(directory) {
  const result = [directory];
  while (directory) {
    directory = dirname(directory);
    result.push(directory);
  }
  return result;
}

export function lineOf(content, offset) {
  let line = 1;
  for (let i = 0; i < offset; i++) if (content.charCodeAt(i) === 10) line++;
  return line;
}

// Whether a repository file can declare or hold an Architectury version for
// `directory` ("" for the repository root, otherwise "sub/dir").
export function isCandidate(path, directory) {
  const segments = path.split('/');
  if (segments.slice(0, -1).some((segment) => EXCLUDED_DIRECTORIES.has(segment))) return false;
  const name = segments.at(-1);
  const shared = name === 'gradle.properties' || name.endsWith('.versions.toml');
  if (!shared && !SCRIPT.test(name)) return false;
  if (!directory || path.startsWith(`${directory}/`)) return true;
  if (!shared) return false;
  // gradle.properties and version catalogs of an enclosing build still apply.
  let owner = dirname(path);
  if (owner === 'gradle') owner = '';
  else if (owner.endsWith('/gradle')) owner = owner.slice(0, -'/gradle'.length);
  return !owner || directory === owner || directory.startsWith(`${owner}/`);
}

export function parseProperties(content) {
  const entries = new Map();
  let offset = 0;
  let lineNumber = 0;
  let continued = false;
  for (const raw of content.split('\n')) {
    const lineStart = offset;
    offset += raw.length + 1;
    lineNumber++;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const wasContinued = continued;
    continued = /(?:^|[^\\])(?:\\\\)*\\$/.test(line);
    if (wasContinued || continued) continue;
    const match = /^([ \t\f]*)([^#!\s=:][^\s=:]*)([ \t\f]*[=:][ \t\f]*|[ \t\f]+)(.*)$/.exec(line);
    if (!match) continue;
    const [, indent, key, separator, rest] = match;
    const value = rest.replace(/[ \t\f]+$/, '');
    const start = lineStart + indent.length + key.length + separator.length;
    entries.set(key, { value, start, end: start + value.length, line: lineNumber });
  }
  return entries;
}

// Finds every Architectury dependency declared in `files` (path -> content)
// and the exact place each declaration's version is written.
export function scanFiles(files, { include = () => true } = {}) {
  const properties = new Map();
  const catalogs = [];
  const scripts = [];
  for (const [path, content] of files) {
    const name = basename(path);
    if (name === 'gradle.properties') properties.set(dirname(path), { path, entries: parseProperties(content) });
    else if (name.endsWith('.versions.toml')) catalogs.push({ path, ...parseCatalog(content) });
    else if (SCRIPT.test(name)) scripts.push({ path, src: content, kotlin: name.endsWith('.kts'), ...lexGradle(content) });
  }
  const conventional = (path) => (path === 'gradle/libs.versions.toml' || path.endsWith('/gradle/libs.versions.toml') ? 0 : 1);
  catalogs.sort((a, b) => conventional(a.path) - conventional(b.path) || a.path.localeCompare(b.path));

  const deps = new Map();
  const warnings = [];
  const notices = [];

  const source = (kind, file, start, value, name) => ({
    key: kind === 'property' || kind === 'catalog' ? `${file}#${name}` : `${file}@${start}`,
    kind,
    name: name ?? null,
    file,
    start,
    end: start + value.length,
    value,
  });

  function record(kind, name, file, offset, versionSource, expression) {
    const where = `${file}:${lineOf(files.get(file), offset)}`;
    if (!versionSource) {
      warnings.push(`Could not work out the version of ${name} declared at ${where} (${expression}); that declaration is skipped.`);
      return;
    }
    if (versionSource.value.includes('$') || isDynamic(versionSource.value)) {
      notices.push(`${name} at ${where} uses "${versionSource.value}", which is not a fixed version; that declaration is skipped.`);
      return;
    }
    let dep = deps.get(name);
    if (!dep) deps.set(name, (dep = { name, kind, occurrences: [] }));
    dep.occurrences.push({ file, line: lineOf(files.get(file), offset), source: versionSource });
  }

  function propertySource(name, fromFile) {
    for (const directory of ancestors(dirname(fromFile))) {
      const file = properties.get(directory);
      const entry = file?.entries.get(name);
      if (entry) return source('property', file.path, entry.start, entry.value, name);
    }
    return null;
  }

  function catalogSource(accessor) {
    const wanted = normalizeAccessor(accessor);
    for (const catalog of catalogs) {
      for (const [key, entry] of catalog.versions) {
        if (normalizeAccessor(key) === wanted) return source('catalog', catalog.path, entry.start, entry.value, key);
      }
    }
    return null;
  }

  function variableSource(name, fromFile) {
    const fromDirectories = ancestors(dirname(fromFile));
    const rank = (script) => {
      if (script.path === fromFile) return -1;
      const index = fromDirectories.indexOf(dirname(script.path));
      return index < 0 ? fromDirectories.length : index;
    };
    for (const script of [...scripts].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path))) {
      const token = findDefinition(script, name);
      if (token) return source('variable', script.path, token.contentStart, token.content, name);
    }
    return null;
  }

  function resolveReference(expression, fromFile) {
    let expr = expression.trim();
    if (expr.startsWith('${') && expr.endsWith('}')) expr = expr.slice(2, -1).trim();
    else if (expr.startsWith('$')) expr = expr.slice(1);
    expr = expr
      .replace(/\s+as\s+String\??$/, '')
      .replace(/(?:\s*\.\s*(?:get|getOrNull|orNull|toString)\s*\(\s*\)|\s*!!)+$/, '')
      .trim();
    const catalogReference = /^[A-Za-z_]\w*\s*\.\s*versions\s*\.\s*([\w.]+)$/.exec(expr);
    if (catalogReference) return catalogSource(catalogReference[1]);
    const quoted = /["']([^"'$]+)["']/.exec(expr);
    const name = quoted ? quoted[1] : /([A-Za-z_]\w*)$/.exec(expr)?.[1];
    if (!name) return null;
    return propertySource(name, fromFile) ?? variableSource(name, fromFile);
  }

  // A string literal holding a version: either the version itself or a
  // "${...}"/"$name" template that points at where it lives.
  function tokenSource(token, script) {
    if (token.content.startsWith('$') && readTemplate(token.content, script.kotlin) === token.content) {
      return resolveReference(token.content, script.path);
    }
    return source('inline', script.path, token.contentStart, token.content);
  }

  function expressionSource(script, position) {
    const literal = script.byStart.get(position);
    if (literal) return { text: literal.content, versionSource: tokenSource(literal, script) };
    const expression = bareExpression(script.src, position);
    return expression ? { text: expression, versionSource: resolveReference(expression, script.path) } : null;
  }

  for (const script of scripts) {
    for (const token of script.strings) {
      const coordinate = parseCoordinate(token.content, script.kotlin);
      if (coordinate) {
        const name = `${coordinate.group}:${coordinate.artifact}`;
        if (!include({ kind: 'library', name })) continue;
        const versionSource = coordinate.mixed
          ? null
          : coordinate.template
            ? resolveReference(coordinate.version, script.path)
            : source('inline', script.path, token.contentStart + coordinate.offset, coordinate.version);
        record('library', name, script.path, token.start, versionSource, coordinate.version);
        continue;
      }

      if (PLUGIN_ID.test(token.content) && include({ kind: 'plugin', name: token.content })) {
        const before = script.src.slice(Math.max(0, token.start - 40), token.start);
        if (!/\bid\s*\(?\s*$/.test(before)) continue;
        const after = /^\s*\)?\s*(?:\.\s*version\s*\(\s*|version\s*\(\s*|version\s+)/.exec(script.src.slice(token.end, token.end + 400));
        if (!after) continue; // applied without a version; it is declared elsewhere
        const version = expressionSource(script, token.end + after[0].length);
        if (version) record('plugin', token.content, script.path, token.start, version.versionSource, version.text);
        continue;
      }

      // Map notation: group: 'dev.architectury', name: 'architectury', version: '...'
      if (!/\bgroup\s*[:=]\s*$/.test(script.src.slice(Math.max(0, token.start - 30), token.start))) continue;
      const rest = script.src.slice(token.end, token.end + 400);
      const statement = rest.slice(0, rest.indexOf('\n') < 0 ? rest.length : rest.indexOf('\n'));
      const nameMatch = /\bname\s*[:=]\s*/.exec(statement);
      const nameToken = nameMatch && script.byStart.get(token.end + nameMatch.index + nameMatch[0].length);
      if (!nameToken) continue;
      const name = `${token.content}:${nameToken.content}`;
      if (!include({ kind: 'library', name })) continue;
      const versionMatch = /\bversion\s*[:=]\s*/.exec(statement);
      if (!versionMatch) continue;
      const version = expressionSource(script, token.end + versionMatch.index + versionMatch[0].length);
      if (version) record('library', name, script.path, token.start, version.versionSource, version.text);
    }
  }

  for (const catalog of catalogs) {
    const content = files.get(catalog.path);
    for (const [kind, entries] of [['library', catalog.libraries], ['plugin', catalog.plugins]]) {
      for (const entry of entries) {
        if (!include({ kind, name: entry.name })) continue;
        const offset = offsetOfLine(content, entry.line);
        if (entry.version) {
          record(kind, entry.name, catalog.path, offset, source('inline', catalog.path, entry.version.start, entry.version.value), entry.version.value);
        } else if (entry.versionRef) {
          const version = catalog.versions.get(entry.versionRef);
          const versionSource = version ? source('catalog', catalog.path, version.start, version.value, entry.versionRef) : null;
          record(kind, entry.name, catalog.path, offset, versionSource, `version.ref = "${entry.versionRef}"`);
        }
      }
    }
  }

  return { deps: [...deps.values()].sort((a, b) => a.name.localeCompare(b.name)), warnings, notices };
}

function offsetOfLine(content, line) {
  let offset = 0;
  for (let i = 1; i < line; i++) offset = content.indexOf('\n', offset) + 1;
  return offset;
}

function normalizeAccessor(name) {
  return name.replace(/[-_]/g, '.').toLowerCase();
}

function parseCoordinate(content, kotlin) {
  const match = COORDINATE.exec(content);
  if (!match) return null;
  const [, group, artifact, rest] = match;
  const offset = group.length + artifact.length + 2;
  if (rest.startsWith('$')) {
    const template = readTemplate(rest, kotlin);
    const after = template ? rest.slice(template.length) : null;
    if (!template || (after && !/^[:@]/.test(after))) return { group, artifact, version: rest, mixed: true, offset };
    return { group, artifact, version: template, template: true, offset };
  }
  const version = /^[^:@\s]+/.exec(rest)?.[0];
  return version ? { group, artifact, version, template: false, offset } : null;
}

function bareExpression(src, position) {
  const match = /^[A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*|\s*\([^()\n]*\)|\s*\[[^\]\n]*\])*/.exec(src.slice(position, position + 300));
  return match ? match[0] : null;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// The string literal a script assigns to `name`, in the forms build scripts
// use to share versions (ext/extra properties and local variables).
function findDefinition(script, name) {
  const n = escapeRegExp(name);
  const patterns = [
    String.raw`\b(?:val|var|def|final\s+String|String)\s+${n}\s*(?::\s*String\s*)?=\s*`,
    String.raw`\b(?:ext|extra)\s*\[\s*["']${n}["']\s*\]\s*=\s*`,
    String.raw`\b(?:ext|extra)\s*\.\s*set\s*\(\s*["']${n}["']\s*,\s*`,
    String.raw`\bext\s*\.\s*${n}\s*=\s*`,
    String.raw`\bval\s+${n}\s+by\s+extra\s*\(\s*`,
    String.raw`(?:^|[\n;{])[ \t]*${n}[ \t]*=[ \t]*`,
  ];
  for (const pattern of patterns) {
    // Fixed patterns; `name` is inserted only after escapeRegExp, so it matches literally.
    for (const match of script.src.matchAll(new RegExp(pattern, 'g'))) { // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      if (script.inComment(match.index + match[0].search(/\S/))) continue;
      const token = script.byStart.get(match.index + match[0].length);
      if (token && !token.content.includes('$')) return token;
    }
  }
  return null;
}
