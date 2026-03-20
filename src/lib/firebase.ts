import admin from "firebase-admin";

let initialized = false;

export function initFirebase(): void {
  if (initialized) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!projectId || !clientEmail || !privateKey) {
    console.warn(
      "⚠️  Firebase env vars missing (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY). Auth endpoints will be unavailable."
    );
    return;
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });

  initialized = true;
  console.log(`✓ Firebase Admin initialized (project: ${projectId})`);
}

export function getFirebaseAdmin(): typeof admin {
  return admin;
}

export function isFirebaseInitialized(): boolean {
  return initialized;
}
