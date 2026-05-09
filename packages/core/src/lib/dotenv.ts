/**
 * Minimal dotenv reader/writer. Just enough for `~/.pihub/env` and
 * `~/.pihub/agents/<id>/env`: KEY=value per line, optional surrounding
 * single/double quotes, `#` comments, blank lines ignored. No interpolation,
 * no multiline values — those land if a real use case appears.
 */

const stripQuotes = (raw: string): string => {
  if (raw.length >= 2) {
    const first = raw.charAt(0);
    const last = raw.charAt(raw.length - 1);
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1);
    }
  }
  return raw;
};

export const parseDotenv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = stripQuotes(line.slice(eq + 1).trim());
    if (key.length === 0) continue;
    out[key] = value;
  }
  return out;
};

const VALUE_NEEDS_QUOTES = /[\s"'#=]/;

export const formatDotenv = (env: Record<string, string>): string => {
  const keys = Object.keys(env).sort();
  const lines = keys.map((k) => {
    const v = env[k] ?? "";
    if (VALUE_NEEDS_QUOTES.test(v) || v.length === 0) {
      return `${k}="${v.replace(/"/g, '\\"')}"`;
    }
    return `${k}=${v}`;
  });
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
};
