import type { Request, Response, NextFunction } from "express";
import { getFirebaseAdmin, isFirebaseInitialized } from "../lib/firebase.js";

// Extend Express Request to carry Firebase auth info
declare global {
  namespace Express {
    interface Request {
      uid?: string;
      user?: {
        uid: string;
        email?: string;
        name?: string;
      };
    }
  }
}

async function verifyToken(
  req: Request
): Promise<{ uid: string; email?: string; name?: string } | null> {
  if (!isFirebaseInitialized()) return null;

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;

  const token = authHeader.slice(7);
  if (!token) return null;

  try {
    const admin = getFirebaseAdmin();
    const decoded = await admin.auth().verifyIdToken(token);
    return {
      uid: decoded.uid,
      email: decoded.email,
      name: decoded.name,
    };
  } catch {
    return null;
  }
}

/** Strict auth — returns 401 if token is missing or invalid */
export async function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (!isFirebaseInitialized()) {
    res.status(503).json({ error: "Auth service not configured" });
    return;
  }

  const user = await verifyToken(req);
  if (!user) {
    res.status(401).json({ error: "Unauthorized: missing or invalid token" });
    return;
  }

  req.uid = user.uid;
  req.user = user;
  next();
}

/** Optional auth — sets uid/user if token is valid, always continues */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const user = await verifyToken(req);
  if (user) {
    req.uid = user.uid;
    req.user = user;
  }
  next();
}
