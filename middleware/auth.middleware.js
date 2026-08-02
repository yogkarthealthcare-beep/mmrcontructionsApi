import jwt from "jsonwebtoken";

export const userAuth = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ success: false, message: "Login required" });
  }
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET || "default_jwt_secret");
    next();
  } catch (_) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET || "default_jwt_secret");
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
    const decoded = jwt.verify(token, process.env.JWT_ADMIN_SECRET || process.env.JWT_SECRET || "default_jwt_secret");
    req.admin = decoded;
    req.user = decoded;
    next();
  } catch (_) {
    return res.status(401).json({ success: false, message: "Invalid or expired admin token" });
  }
};
