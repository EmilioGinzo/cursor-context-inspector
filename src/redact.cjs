'use strict';

// Credentials never reach the history. What Cursor sends can hold them: a git remote URL as git has
// it (https://user:token@host/...), a URL or token pasted in a rule. They are replaced before
// anything is stored or shown:
//
//   https://user:token@host/path  ->  https://[redacted]@host/path
//   ghp_..., github_pat_..., sk-..., xoxb-..., AKIA...  ->  [redacted]
//
// A URL's user alone is kept only for ssh (ssh://git@host is no secret); for http and the others a
// user may be a token. The stored copy then differs from what was sent by these replacements only.

const MARK = '[redacted]';

// scheme://userinfo@ : userinfo up to the first @ before the host's path, no spaces or slashes.
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@]+)@/gi;
const SSH_SCHEMES = /^(ssh|git\+ssh|ssh\+git|sftp):\/\/$/i;

// Well-known token formats (GitHub, GitLab, OpenAI / Anthropic, Slack, AWS, Google).
const TOKENS = /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35})\b/g;

// One string: { text, count } (count: the replacements made).
function redactText(s) {
  if (typeof s !== 'string') return { text: s, count: 0 };
  let count = 0;
  let text = s.replace(URL_USERINFO, (all, scheme, userinfo) => {
    if (userinfo === MARK || (SSH_SCHEMES.test(scheme) && !userinfo.includes(':'))) return all;
    count++;
    return `${scheme}${MARK}@`;
  });
  text = text.replace(TOKENS, () => {
    count++;
    return MARK;
  });
  return { text, count };
}

// A copy of any JSON-like value with every string redacted: { value, count, paths } (paths: where).
function redactValue(value, at = '') {
  const paths = [];
  let count = 0;
  const walk = (v, p) => {
    if (typeof v === 'string') {
      const r = redactText(v);
      if (r.count) {
        count += r.count;
        paths.push(p);
      }
      return r.text;
    }
    if (Array.isArray(v)) return v.map((x, i) => walk(x, `${p}[${i}]`));
    if (v && typeof v === 'object' && !Buffer.isBuffer(v) && !(v instanceof Uint8Array)) {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, p ? `${p}.${k}` : k)]));
    }
    return v;
  };
  return { value: walk(value, at), count, paths };
}

module.exports = { MARK, redactText, redactValue };
