// Wrangler configs are JSONC. This parser is only for files we generate or the
// committed template: comments and trailing commas outside strings.

export function parseJsonc(text) {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let stripped = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (inString) {
      stripped += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      stripped += char;
      continue;
    }
    if (char === "/" && next === "/") {
      i += 1;
      while (i + 1 < source.length && source[i + 1] !== "\n") i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
      i += 1;
      continue;
    }
    stripped += char;
  }
  return JSON.parse(stripTrailingCommas(stripped));
}

function stripTrailingCommas(text) {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      out += char;
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") {
      inString = true;
      out += char;
      continue;
    }
    if (char === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j += 1;
      if (text[j] === "}" || text[j] === "]") continue;
    }
    out += char;
  }
  return out;
}
