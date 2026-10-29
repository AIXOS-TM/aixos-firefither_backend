// Gate a route to specific req.user.role values. Must run after verifyToken.
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Forbidden: insufficient role' });
    }
    next();
  };
}

// Like requireRole, but `selfRole` is only allowed when getTargetId(req) is the
// caller's own id (e.g. an agent reading their own stats); `otherRoles` may act on
// any id. Ids are compared as strings (JWT ids are numbers, params are strings).
// Must run after verifyToken.
function requireSelfOrRole(selfRole, getTargetId, ...otherRoles) {
  return (req, res, next) => {
    const role = req.user && req.user.role;
    if (otherRoles.includes(role)) return next();
    const target = getTargetId(req);
    if (role === selfRole && target != null && String(target) === String(req.user.id)) return next();
    return res.status(403).json({ error: 'Forbidden: you can only access your own records' });
  };
}

module.exports = { requireRole, requireSelfOrRole };
