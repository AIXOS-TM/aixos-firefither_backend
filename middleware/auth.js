const jwt = require('jsonwebtoken');
const supabase = require('../supabase');
const SECRET_KEY = process.env.JWT_SECRET || 'super_secret_key_fire_marketplace';

const AUDITED_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

const verifyToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Access denied. No token provided.' });
    }

    let decoded;
    try {
        decoded = jwt.verify(token, SECRET_KEY);
    } catch (err) {
        // An expired impersonation token needs to be distinguishable from a normal
        // one, so the frontend can auto-restore the admin's own session instead
        // of bouncing to a full logout. jwt.verify() throws before we can read
        // the payload, so peek at the unverified claims just for this check.
        if (err.name === 'TokenExpiredError') {
            const unverified = jwt.decode(token);
            if (unverified && unverified.imp) {
                return res.status(401).json({ error: 'Impersonation session expired.', code: 'IMPERSONATION_EXPIRED' });
            }
        }
        return res.status(403).json({ error: 'Invalid or expired token.' });
    }

    req.user = { id: decoded.id, role: decoded.role }; // preserved shape used across the app
    req.impersonation = decoded.imp || null;

    // Audit trail: every mutating request made while impersonating is logged
    // with both the real admin identity and the identity being acted as.
    if (req.impersonation && AUDITED_METHODS.includes(req.method)) {
        const impersonation = req.impersonation;
        const user = req.user;
        const method = req.method;
        const path = req.originalUrl;
        const resourceId = req.params && req.params.id ? String(req.params.id) : null;

        res.on('finish', () => {
            if (res.statusCode >= 400) return;
            supabase
                .from('audit_logs')
                .insert({
                    actor_user_id: impersonation.adminId,
                    actor_role: 'admin',
                    acting_as_user_id: user.id,
                    acting_as_role: user.role,
                    impersonation_session_id: impersonation.sessionId,
                    action: `${method} ${path}`,
                    method,
                    path,
                    resource_id: resourceId,
                })
                .then(({ error }) => {
                    if (error) console.error('[audit_logs] insert failed:', error);
                });
        });
    }

    next();
};

module.exports = { verifyToken };
