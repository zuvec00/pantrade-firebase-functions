// File: src/firebase.ts
import * as admin from "firebase-admin";

// Avoid re-initializing if already initialized
if (!admin.apps.length) {
  admin.initializeApp();
}

const db = admin.firestore();

export {admin, db};
