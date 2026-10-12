/* server/burst.js — "this keeps happening" for alerts.
 *
 * burst(threshold, windowMs)(nowMs) counts an occurrence and answers the
 * count when `threshold` of them fell within `windowMs`, at most once per
 * window; otherwise 0. For things one of is normal (a hard bounce, a probe
 * with a bad signature) but many in a row means something's broken.
 */
export function burst(threshold, windowMs) {
  let times = [];
  let alertedAt = -Infinity;
  return now => {
    times = times.filter(t => now - t < windowMs);
    times.push(now);
    if (times.length >= threshold && now - alertedAt >= windowMs) {
      alertedAt = now;
      return times.length;
    }
    return 0;
  };
}
