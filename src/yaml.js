// A small YAML reader for the `ignore` and `allow` inputs. It covers what
// those lists use in dependabot.yml: block sequences and mappings, plain and
// quoted scalars, flow sequences/mappings and comments. JSON also works.

export function parseYaml(text, label = 'input') {
  const source = String(text ?? '');
  if (!source.trim()) return null;
  if (/^\s*[\[{]/.test(source)) {
    try {
      return JSON.parse(source);
    } catch {
      // Not JSON; fall through to the YAML reader (flow collections are YAML too).
    }
  }
  const lines = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const content = stripComment(raw).replace(/\s+$/, '');
    if (!content.trim()) return;
    const indentation = /^[ \t]*/.exec(content)[0];
    if (indentation.includes('\t')) throw yamlError(label, index + 1, 'tabs are not allowed for indentation');
    lines.push({ indent: indentation.length, text: content.slice(indentation.length), line: index + 1 });
  });
  const state = { lines, index: 0, label };
  const value = parseNode(state, lines[0].indent);
  if (state.index < lines.length) throw yamlError(label, lines[state.index].line, 'unexpected indentation');
  return value;
}

function yamlError(label, line, message) {
  return new Error(`Could not parse ${label} (line ${line}): ${message}`);
}

function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

const isSequenceItem = (text) => text === '-' || text.startsWith('- ');

function parseNode(state, indent) {
  const line = state.lines[state.index];
  if (isSequenceItem(line.text)) return parseSequence(state, indent);
  if (splitEntry(line.text, state, line.line)) return parseMapping(state, indent);
  state.index++;
  return parseValue(line.text, state, line.line);
}

function parseSequence(state, indent) {
  const items = [];
  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    if (line.indent !== indent || !isSequenceItem(line.text)) break;
    const rest = line.text.slice(1).trimStart();
    if (!rest) {
      state.index++;
      const next = state.lines[state.index];
      if (next && next.indent > indent) items.push(parseNode(state, next.indent));
      else items.push(null);
    } else if (!/^[\[{"']/.test(rest) && splitEntry(rest, state, line.line)) {
      // "- key: value" starts a mapping indented to the key's column.
      const childIndent = indent + (line.text.length - rest.length);
      state.lines[state.index] = { ...line, indent: childIndent, text: rest };
      items.push(parseMapping(state, childIndent));
    } else {
      state.index++;
      items.push(parseValue(rest, state, line.line));
    }
  }
  return items;
}

function parseMapping(state, indent) {
  const mapping = {};
  while (state.index < state.lines.length) {
    const line = state.lines[state.index];
    if (line.indent !== indent || isSequenceItem(line.text)) break;
    const entry = splitEntry(line.text, state, line.line);
    if (!entry) throw yamlError(state.label, line.line, `expected "key: value", got "${line.text}"`);
    state.index++;
    if (entry.rest) {
      mapping[entry.key] = parseValue(entry.rest, state, line.line);
      continue;
    }
    const next = state.lines[state.index];
    if (next && (next.indent > indent || (next.indent === indent && isSequenceItem(next.text)))) {
      mapping[entry.key] = parseNode(state, next.indent);
    } else {
      mapping[entry.key] = null;
    }
  }
  return mapping;
}

function splitEntry(text, state, line) {
  if (/^[\[{]/.test(text)) return null;
  if (text.startsWith('"') || text.startsWith("'")) {
    const { value, end } = readQuoted(text, 0, state, line);
    const after = text.slice(end);
    const match = /^\s*:(\s+|$)/.exec(after);
    return match ? { key: value, rest: after.slice(match[0].length).trim() } : null;
  }
  const match = /^([^:]+?)\s*:(\s+|$)/.exec(text);
  return match ? { key: match[1], rest: text.slice(match[0].length).trim() } : null;
}

function parseValue(text, state, line) {
  const reader = { text, pos: 0 };
  const value = readFlow(reader, state, line, false);
  if (reader.text.slice(reader.pos).trim()) throw yamlError(state.label, line, `unexpected "${reader.text.slice(reader.pos).trim()}"`);
  return value;
}

function readFlow(reader, state, line, nested) {
  skipSpace(reader);
  const c = reader.text[reader.pos];
  if (c === '[') {
    reader.pos++;
    const items = [];
    skipSpace(reader);
    if (reader.text[reader.pos] === ']') {
      reader.pos++;
      return items;
    }
    for (;;) {
      items.push(readFlow(reader, state, line, true));
      skipSpace(reader);
      const sep = reader.text[reader.pos++];
      if (sep === ']') return items;
      if (sep !== ',') throw yamlError(state.label, line, 'expected "," or "]"');
    }
  }
  if (c === '{') {
    reader.pos++;
    const mapping = {};
    skipSpace(reader);
    if (reader.text[reader.pos] === '}') {
      reader.pos++;
      return mapping;
    }
    for (;;) {
      skipSpace(reader);
      let key;
      if (reader.text[reader.pos] === '"' || reader.text[reader.pos] === "'") {
        const quoted = readQuoted(reader.text, reader.pos, state, line);
        key = quoted.value;
        reader.pos = quoted.end;
      } else {
        const match = /^[^:,{}\[\]]+?(?=\s*:)/.exec(reader.text.slice(reader.pos));
        if (!match) throw yamlError(state.label, line, 'expected a key');
        key = match[0].trim();
        reader.pos += match[0].length;
      }
      skipSpace(reader);
      if (reader.text[reader.pos++] !== ':') throw yamlError(state.label, line, 'expected ":"');
      mapping[key] = readFlow(reader, state, line, true);
      skipSpace(reader);
      const sep = reader.text[reader.pos++];
      if (sep === '}') return mapping;
      if (sep !== ',') throw yamlError(state.label, line, 'expected "," or "}"');
    }
  }
  if (c === '"' || c === "'") {
    const quoted = readQuoted(reader.text, reader.pos, state, line);
    reader.pos = quoted.end;
    return quoted.value;
  }
  const rest = reader.text.slice(reader.pos);
  const match = nested ? /^[^,\]}]*/.exec(rest) : /^.*/.exec(rest);
  reader.pos += match[0].length;
  const scalar = match[0].trim();
  return scalar === '' || scalar === '~' || scalar === 'null' ? null : scalar;
}

function skipSpace(reader) {
  while (/\s/.test(reader.text[reader.pos] ?? '')) reader.pos++;
}

function readQuoted(text, start, state, line) {
  const quote = text[start];
  let value = '';
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (quote === "'") {
      if (c === "'") {
        if (text[i + 1] === "'") {
          value += "'";
          i++;
          continue;
        }
        return { value, end: i + 1 };
      }
      value += c;
      continue;
    }
    if (c === '"') return { value, end: i + 1 };
    if (c === '\\') {
      const next = text[++i];
      const escapes = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/', '0': '\0' };
      if (next === 'u') {
        value += String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16));
        i += 4;
      } else {
        value += escapes[next] ?? next;
      }
      continue;
    }
    value += c;
  }
  throw yamlError(state.label, line, 'unterminated string');
}
