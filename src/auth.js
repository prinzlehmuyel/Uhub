// src/auth.js
// All authentication logic for UHub, backed entirely by Firebase Authentication:
// registration, login, sessions, email verification, and password reset.
//
// EmailJS is intentionally NOT used anywhere in this file — it is reserved
// purely for optional custom-branded emails (see sendWelcomeEmail in App.jsx).

import { auth, db } from "./firebase";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  reload,
} from "firebase/auth";
import { doc, setDoc, getDoc } from "firebase/firestore";

// ── Registration ────────────────────────────────────────────────────────────
// Creates the Firebase Auth account, writes the student's profile to
// Firestore (students/{uid}), and kicks off Firebase's built-in email
// verification flow (sends a real verification link to the student's inbox).
export async function registerStudent(email, password, profile) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  const uid = cred.user.uid;

  await setDoc(doc(db, "students", uid), {
    ...profile,
    email,
    uid,
    createdAt: new Date().toISOString(),
  });

  await sendEmailVerification(cred.user);

  return { uid, email, profile, emailVerified: cred.user.emailVerified };
}

// ── Login ────────────────────────────────────────────────────────────────────
export async function loginStudent(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  const uid = cred.user.uid;

  const snap = await getDoc(doc(db, "students", uid));
  const profile = snap.exists() ? snap.data() : null;

  return { uid, email, profile, emailVerified: cred.user.emailVerified };
}

// ── Logout ───────────────────────────────────────────────────────────────────
export function logoutStudent() {
  return signOut(auth);
}

// ── Session restore / live auth state ───────────────────────────────────────
// Call once at app startup. Fires immediately with the current state, then
// again on every login/logout/token refresh — this is what keeps a student
// signed in across page reloads without any localStorage bookkeeping.
export function watchAuthState(callback) {
  return onAuthStateChanged(auth, async (firebaseUser) => {
    if (!firebaseUser) {
      callback(null);
      return;
    }
    const snap = await getDoc(doc(db, "students", firebaseUser.uid));
    const profile = snap.exists() ? snap.data() : null;
    callback({
      uid: firebaseUser.uid,
      email: firebaseUser.email,
      profile,
      emailVerified: firebaseUser.emailVerified,
    });
  });
}

// ── Profile ──────────────────────────────────────────────────────────────────
export async function updateStudentProfile(uid, profile) {
  await setDoc(doc(db, "students", uid), profile, { merge: true });
}

// ── Email verification ──────────────────────────────────────────────────────
// Re-sends Firebase's verification link to the currently signed-in user.
export async function resendVerificationEmail() {
  if (!auth.currentUser) throw new Error("You're not signed in.");
  await sendEmailVerification(auth.currentUser);
}

// Reloads the current user from Firebase and reports whether their email
// is verified yet. Call this after the student says they've clicked the link.
export async function refreshEmailVerified() {
  if (!auth.currentUser) return false;
  await reload(auth.currentUser);
  return auth.currentUser.emailVerified;
}

// ── Password reset ──────────────────────────────────────────────────────────
// Firebase emails the student a secure reset link and hosts the "choose a
// new password" page itself — no codes or extra screens to manage here.
export async function requestPasswordReset(email) {
  await sendPasswordResetEmail(auth, email);
}
