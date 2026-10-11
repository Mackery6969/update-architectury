// Finds the string literals of a Groovy or Kotlin build script, skipping
// comments, so declarations can be located (and edited) by exact offset.
// Strings nested in ${...} templates are reported as well.

export function lexGradle(src) {
  const strings = [];
  const comments = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      comments.push([i, end < 0 ? src.length : end]);
      i = end < 0 ? src.length : end;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      comments.push([i, end < 0 ? src.length : end + 2]);
      i = end < 0 ? src.length : end + 2;
    } else if (c === '"' || c === "'") {
      i = readString(src, i, strings);
    } else {
      i++;
    }
  }
  strings.sort((a, b) => a.start - b.start);
  return {
    strings,
    byStart: new Map(strings.map((token) => [token.start, token])),
    inComment: (pos) => comments.some(([start, end]) => pos >= start && pos < end),
  };
}

function readString(src, start, strings) {
  const quote = src[start];
  const triple = src.startsWith(quote.repeat(3), start);
  const delimiter = triple ? quote.repeat(3) : quote;
  const contentStart = start + delimiter.length;
  let j = contentStart;
  while (j < src.length) {
    if (src.startsWith(delimiter, j)) {
      strings.push({
        start,
        end: j + delimiter.length,
        contentStart,
        contentEnd: j,
        content: src.slice(contentStart, j),
      });
      return j + delimiter.length;
    }
    const c = src[j];
    if (c === '\\') {
      j += 2;
    } else if (c === '\n' && !triple) {
      return j; // unterminated; resume scanning on the next line
    } else if (c === '$' && src[j + 1] === '{' && quote === '"') {
      j = skipTemplate(src, j + 2, strings);
    } else {
      j++;
    }
  }
  return j;
}

function skipTemplate(src, j, strings) {
  let depth = 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'") {
      j = readString(src, j, strings);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j + 1;
    j++;
  }
  return j;
}

// Reads a ${...} or $name template at the start of `text`. Returns its source
// text, or null when `text` does not start with one.
export function readTemplate(text, kotlin) {
  if (text.startsWith('${')) {
    let depth = 0;
    let quote = null;
    for (let i = 1; i < text.length; i++) {
      const c = text[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '{') {
        depth++;
      } else if (c === '}' && --depth === 0) {
        return text.slice(0, i + 1);
      }
    }
    return null;
  }
  // Groovy GStrings interpolate dotted paths ("$rootProject.foo"); Kotlin only a name.
  const match = (kotlin ? /^\$[A-Za-z_]\w*/ : /^\$[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*/).exec(text);
  return match ? match[0] : null;
}
