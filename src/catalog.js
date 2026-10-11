// Reads the parts of a Gradle version catalog (gradle/libs.versions.toml)
// that declare versions, keeping the offset of every version string.

export function parseCatalog(src) {
  const versions = new Map();
  const libraries = [];
  const plugins = [];
  let section = null;
  let offset = 0;
  let lineNumber = 0;
  for (const raw of src.split('\n')) {
    const lineStart = offset;
    offset += raw.length + 1;
    lineNumber++;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const header = /^\s*\[\s*([A-Za-z0-9_.\-]+)\s*\]\s*(?:#.*)?$/.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    if (section !== 'versions' && section !== 'libraries' && section !== 'plugins') continue;
    const entry = parseEntry(line, lineStart);
    if (!entry) continue;
    const { key, value } = entry;

    if (section === 'versions') {
      const node = value.type === 'string' ? value : value.type === 'table' ? richVersion(value.fields, '') : null;
      if (node) versions.set(key, { key, value: node.value, start: node.start, end: node.end, line: lineNumber });
      continue;
    }

    let name = null;
    let version = null;
    let versionRef = null;
    if (value.type === 'string') {
      const separator = section === 'plugins' ? value.value.indexOf(':') : nthIndexOf(value.value, ':', 2);
      const coordinates = separator < 0 ? value.value : value.value.slice(0, separator);
      name = coordinates;
      if (separator >= 0) {
        version = { value: value.value.slice(separator + 1), start: value.start + separator + 1, end: value.end };
      }
    } else if (value.type === 'table') {
      const { fields } = value;
      if (section === 'plugins') {
        name = fields.get('id')?.value ?? null;
      } else {
        name = fields.get('module')?.value ?? null;
        if (!name && fields.get('group') && fields.get('name')) name = `${fields.get('group').value}:${fields.get('name').value}`;
      }
      versionRef = fields.get('version.ref')?.value ?? null;
      version = fields.get('version')?.type === 'string' ? fields.get('version') : richVersion(fields, 'version.');
    }
    if (!name) continue;
    const entryInfo = { alias: key, name, version, versionRef, line: lineNumber };
    (section === 'plugins' ? plugins : libraries).push(entryInfo);
  }
  return { versions, libraries, plugins };
}

function nthIndexOf(text, char, n) {
  let index = -1;
  for (let i = 0; i < n; i++) {
    index = text.indexOf(char, index + 1);
    if (index < 0) return -1;
  }
  return index;
}

// { strictly = "1.0" } and friends. Only a single constraint is editable safely.
function richVersion(fields, prefix) {
  const present = ['strictly', 'require', 'prefer'].filter((key) => fields.has(prefix + key));
  if (present.length !== 1) return null;
  const node = fields.get(prefix + present[0]);
  return node.type === 'string' ? node : null;
}

function parseEntry(line, base) {
  const tokens = tokenize(line, base);
  if (!tokens?.length) return null;
  const reader = { tokens, pos: 0 };
  const key = readKey(reader);
  if (!key || reader.tokens[reader.pos++]?.type !== '=') return null;
  const value = readValue(reader);
  return value ? { key: key.join('.'), value } : null;
}

function tokenize(line, base) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === '#') break;
    if (c === ' ' || c === '\t') {
      i++;
    } else if ('{}=,.[]'.includes(c)) {
      tokens.push({ type: c });
      i++;
    } else if (c === '"' || c === "'") {
      if (line.startsWith(c.repeat(3), i)) return null;
      let j = i + 1;
      let value = '';
      while (j < line.length && line[j] !== c) {
        if (c === '"' && line[j] === '\\') {
          value += line[j + 1] ?? '';
          j += 2;
        } else {
          value += line[j++];
        }
      }
      if (j >= line.length) return null;
      tokens.push({ type: 'string', value, start: base + i + 1, end: base + j });
      i = j + 1;
    } else {
      const bare = /^[A-Za-z0-9_\-+]+/.exec(line.slice(i));
      if (!bare) return null;
      tokens.push({ type: 'bare', value: bare[0] });
      i += bare[0].length;
    }
  }
  return tokens;
}

function readKey(reader) {
  const parts = [];
  for (;;) {
    const token = reader.tokens[reader.pos];
    if (!token || (token.type !== 'bare' && token.type !== 'string')) return null;
    parts.push(token.value);
    reader.pos++;
    if (reader.tokens[reader.pos]?.type !== '.') return parts;
    reader.pos++;
  }
}

function readValue(reader) {
  const token = reader.tokens[reader.pos++];
  if (!token) return null;
  if (token.type === 'string') return { type: 'string', value: token.value, start: token.start, end: token.end };
  if (token.type === 'bare') return { type: 'other' };
  if (token.type === '[') {
    let depth = 1;
    while (depth && reader.pos < reader.tokens.length) {
      const type = reader.tokens[reader.pos++].type;
      if (type === '[') depth++;
      else if (type === ']') depth--;
    }
    return depth ? null : { type: 'other' };
  }
  if (token.type !== '{') return null;
  const fields = new Map();
  if (reader.tokens[reader.pos]?.type === '}') {
    reader.pos++;
    return { type: 'table', fields };
  }
  for (;;) {
    const key = readKey(reader);
    if (!key || reader.tokens[reader.pos++]?.type !== '=') return null;
    const value = readValue(reader);
    if (!value) return null;
    if (value.type === 'table') {
      for (const [name, nested] of value.fields) fields.set(`${key.join('.')}.${name}`, nested);
    } else {
      fields.set(key.join('.'), value);
    }
    const separator = reader.tokens[reader.pos++]?.type;
    if (separator === '}') return { type: 'table', fields };
    if (separator !== ',') return null;
  }
}
