/**
 * Minimal in-memory fixed-window rate limiter (no extra dependency). Per server
 * instance — enough to blunt brute force / mail spam on a single backend; use a shared
 * store if the backend is ever scaled out.
 *
 * Keyed by `keyFn(req)` (default: client IP). Behind a reverse proxy, set Express
 * `trust proxy` so req.ip is the real client and not the proxy.
 */
function rateLimit({ windowMs, max, keyFn = (req) => req.ip, message = 'Too many requests. Please try again later.' }) {
    const hits = new Map();
    const sweep = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits) if (entry.resetAt <= now) hits.delete(key);
    }, windowMs);
    sweep.unref();

    return (req, res, next) => {
        const key = keyFn(req) || 'unknown';
        const now = Date.now();
        let entry = hits.get(key);
        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(key, entry);
        }
        entry.count += 1;
        if (entry.count > max) {
            res.set('Retry-After', String(Math.ceil((entry.resetAt - now) / 1000)));
            return res.status(429).json({ error: message, code: 'RATE_LIMITED' });
        }
        next();
    };
}

module.exports = { rateLimit };
