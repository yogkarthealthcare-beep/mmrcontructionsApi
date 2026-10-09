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


