import jwt from "jsonwebtoken";

const getAdminSecret = () => process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET || "mmr_constructions_jwt_secret_2026_key";
const getUserSecret = () => process.env.JWT_SECRET || "mmr_constructions_jwt_secret_2026_key";

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
    try {
      const fallbackSecret = "mmr_constructions_jwt_secret_2026_key";
      const decoded = jwt.verify(token, fallbackSecret);
      req.admin = decoded;
      req.user = decoded;
      next();
    } catch {
      return res.status(401).json({ success: false, message: "Invalid or expired admin token" });
    }
  }
};

