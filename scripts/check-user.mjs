import admin from "firebase-admin";

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

admin.initializeApp({
  credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
});

const user = await admin.auth().getUserByEmail("mayank.eth@gmail.com");
console.log("UID:", user.uid);
console.log("Email:", user.email);
console.log("Email verified:", user.emailVerified);
console.log("Providers:", user.providerData.map(p => p.providerId).join(", "));
console.log("Created:", new Date(Date.parse(user.metadata.creationTime)).toISOString());
console.log("Last sign-in:", user.metadata.lastSignInTime);
console.log("Disabled:", user.disabled);

process.exit(0);
