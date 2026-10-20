/* server/mailDomain.js — Can this domain receive mail at all?
 *
 * Why: an address on a domain that doesn't exist passes every format check,
 * goes on the list, and bounces on the first issue (a bounce Resend counts
 * against the account). /api/subscribe asks DNS first: an MX record, or
 * failing that an A/AAAA record (mail falls back to it, RFC 5321). Only a
 * clear "no such domain / no records" says no; a timeout or any other DNS
 * error says "don't know", and the signup goes through. A null MX ("."),
 * a domain saying it takes no mail, is a no too.
 */

import dns from 'node:dns';

const NONE = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

// resolver: { resolveMx, resolve4, resolve6 } (dns.promises shape), for tests.
// Answers true (takes mail), false (can't), or null (couldn't tell).
export function createMailDomainCheck({ resolver = dns.promises, timeoutMs = 2000, cacheMs = 24 * 60 * 60 * 1000, now = () => Date.now() } = {}) {
  const cache = new Map();
  const ask = (fn, domain) => Promise.race([
    fn.call(resolver, domain),
    new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('dns timeout'), { code: 'ETIMEOUT' })), timeoutMs).unref())
  ]);
  async function lookup(domain) {
    try {
      const mx = await ask(resolver.resolveMx, domain);
      if (mx && mx.length) return !(mx.length === 1 && (mx[0].exchange === '' || mx[0].exchange === '.'));
    } catch (err) {
      if (!NONE.has(err && err.code)) return null;
    }
    for (const fn of [resolver.resolve4, resolver.resolve6]) {
      try {
        const a = await ask(fn, domain);
        if (a && a.length) return true;
      } catch (err) {
        if (!NONE.has(err && err.code)) return null;
      }
    }
    return false;
  }
  return async function mailDomainOk(domain) {
    const d = String(domain || '').toLowerCase();
    if (!d) return null;
    const hit = cache.get(d);
    if (hit && now() - hit.at < cacheMs) return hit.ok;
    const ok = await lookup(d);
    // Only clear answers are kept; a "don't know" asks again next time.
    if (ok !== null) {
      if (cache.size > 5000) cache.clear();
      cache.set(d, { ok, at: now() });
    }
    return ok;
  };
}
