import jwt from "jsonwebtoken";

const getAdminSecret = () => {
  const secret = process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is missing.");
  return secret;
};

const getUserSecret = () => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET environment variable is missing.");
  return secret;
};

export const userAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ success: false, message: "Login required" });
  }
  try {
    req.user = jwt.verify(token, getUserSecret());
    next();
  } catch (_) {
    try {
      const decoded = jwt.verify(token, getAdminSecret());
      req.user = decoded;
      req.user.is_admin = true;
      next();
    } catch {
      return res.status(401).json({ success: false, message: "Invalid or expired token" });
    }
  }
};

export const adminAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ success: false, message: "Admin login required" });
  }
  try {
    const decoded = jwt.verify(token, getAdminSecret());
    req.admin = decoded;
    req.user = decoded;
    next();
  } catch (_) {
    return res.status(401).json({ success: false, message: "Invalid or expired admin token" });
  }
};

export const verifyUserToken = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "No token provided" });
  }
  const token = auth.split(" ")[1];
  try {
    req.user = jwt.verify(token, getUserSecret());
    return next();
  } catch (_) {
    try {
      const decoded = jwt.verify(token, getAdminSecret());
      req.user = decoded;
      req.user.is_admin = true;
      return next();
    } catch {
      return res.status(401).json({ success: false, message: "Invalid or expired token" });
    }
  }
};

export const verifyAdminToken = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, message: "No admin token provided" });
  }
  const token = auth.split(" ")[1];
  try {
    req.admin = jwt.verify(token, getAdminSecret());
    return next();
  } catch (e1) {
    return res.status(401).json({ success: false, message: "Invalid or expired admin token" });
  }
};

export const role = (...allowed) => (req, res, next) => {
  const currentRole = req.admin?.role;
  if (!currentRole) return res.status(403).json({ success: false, message: "Forbidden — insufficient role" });
  if (currentRole === "SuperAdmin" || currentRole === "Admin") return next();
  if (allowed.some(a => String(a).toLowerCase() === String(currentRole).toLowerCase())) {
    return next();
  }
  return res.status(403).json({ success: false, message: "Forbidden — insufficient role" });
};

/**
 * Task C2 Helper: Resolve effective user panel.
 * 'team-member' is accepted ONLY when issued with impersonated_by_admin_id (admin impersonation)
 * or when the user's primary database role is Team Member. Normal logins never receive this claim.
 */
export const resolveEffectivePanel = (user) => {
  if (!user) return null;
  if (user.acting_panel === 'team-member' && Boolean(user.impersonated_by_admin_id)) {
    return 'team-member';
  }
  const roleStr = String(user.user_type || user.role || '').toLowerCase().trim();
  if (roleStr === 'team member' || roleStr === 'teammember') {
    return 'team-member';
  }
  if (roleStr === 'associate') {
    return 'associate';
  }
  if (roleStr === 'customer') {
    return 'customer';
  }
  if (roleStr === 'investor') {
    return 'investor';
  }
  if (['superadmin', 'admin', 'financemanager'].includes(roleStr)) {
    return 'admin';
  }
  return null;
};

export const requireAssociate = (req, res, next) => {
  const panel = resolveEffectivePanel(req.user);
  if (panel === 'team-member') {
    return res.status(403).json({ success: false, message: "Forbidden — Associate access required (current session is acting as Team Member)" });
  }
  const isAssoc = req.user?.user_type === "Associate" ||
                  req.user?.role === "Associate" ||
                  Boolean(req.user?.is_associate) ||
                  Boolean(req.user?.is_admin || req.user?.admin_id);
  if (!isAssoc) {
    return res.status(403).json({ success: false, message: "Associate access required" });
  }
  return next();
};

export const requireSalesEntity = (req, res, next) => {
  const panel = resolveEffectivePanel(req.user);
  const isSales = (panel === 'team-member') ||
                  ["Associate", "Team Member"].includes(req.user?.user_type) ||
                  req.user?.role === "Associate" ||
                  req.user?.role === "Team Member" ||
                  Boolean(req.user?.is_associate) ||
                  Boolean(req.user?.is_admin || req.user?.admin_id);
  if (!isSales) {
    return res.status(403).json({ success: false, message: "Sales entity access required" });
  }
  return next();
};

export const optionalAuth = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    req.user = null;
    return next();
  }
  const token = auth.split(" ")[1];
  if (!token) {
    req.user = null;
    return next();
  }
  try {
    req.user = jwt.verify(token, getUserSecret());
    return next();
  } catch (_) {
    try {
      const decoded = jwt.verify(token, getAdminSecret());
      req.user = decoded;
      req.user.is_admin = true;
      return next();
    } catch {
      req.user = null;
      return next();
    }
  }
};

