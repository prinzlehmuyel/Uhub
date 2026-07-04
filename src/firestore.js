// src/firestore.js
// All Firestore read/write functions for student data
// Structure: students/{uid}/courses/{id}, students/{uid}/assignments/{id}, etc.

import { db } from "./firebase";
import {
  collection,
  doc,
  addDoc,
  setDoc,
  deleteDoc,
  getDocs,
  onSnapshot,
  query,
  where,
  increment,
  updateDoc,
} from "firebase/firestore";

// ── Generic helpers for any subcollection ──────────────────────
// subcollection: "courses" | "assignments" | "notes" | "flashcards" | "studyPlans" | "examDates" | "gpaRecords"

export function listenToCollection(uid, subcollection, callback) {
  const ref = collection(db, "students", uid, subcollection);
  // onSnapshot gives real-time updates AND works offline (reads from cache)
  return onSnapshot(ref, (snap) => {
    const items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    callback(items);
  });
}

export async function addItem(uid, subcollection, data) {
  const ref = collection(db, "students", uid, subcollection);
  const docRef = await addDoc(ref, { ...data, createdAt: new Date().toISOString() });
  return docRef.id;
}

export async function updateItem(uid, subcollection, itemId, data) {
  const ref = doc(db, "students", uid, subcollection, itemId);
  await updateDoc(ref, data);
}

export async function deleteItem(uid, subcollection, itemId) {
  const ref = doc(db, "students", uid, subcollection, itemId);
  await deleteDoc(ref);
}

// Increment a view counter on any item in a student's own subcollection.
// Used for purely PRIVATE notes, where only the owner can ever view them,
// so only the owner ever needs (or is allowed) to write this field.
export async function incrementItemViews(uid, subcollection, itemId) {
  const ref = doc(db, "students", uid, subcollection, itemId);
  await updateDoc(ref, { views: increment(1) });
}

// ── PUBLIC NOTES ────────────────────────────────────────────────
// A top-level collection (NOT nested under students/{uid}) so that any
// signed-in student can query across everyone's shared notes — this is
// what makes cross-user search in the Library's Public tab actually work.
// Document ID matches the note's private students/{uid}/notes/{id} doc,
// so the two stay easy to keep in sync.

export function listenToPublicNotes(callback) {
  const ref = collection(db, "publicNotes");
  return onSnapshot(ref, (snap) => {
    callback(snap.docs.map((d) => ({ id: d.id, ...d.data() })));
  });
}

export async function addPublicNote(noteId, data) {
  await setDoc(doc(db, "publicNotes", noteId), {
    ...data,
    sharedAt: new Date().toISOString(),
    views: 0,
  });
}

export async function updatePublicNote(noteId, data) {
  await updateDoc(doc(db, "publicNotes", noteId), data);
}

export async function deletePublicNote(noteId) {
  await deleteDoc(doc(db, "publicNotes", noteId));
}

// Any signed-in student can call this (not just the uploader) — Firestore
// rules specifically allow anyone to touch ONLY the `views` field on a
// publicNotes document, so viewing someone else's shared note still works.
export async function incrementPublicNoteViews(noteId) {
  await updateDoc(doc(db, "publicNotes", noteId), { views: increment(1) });
}

// ── SHARE LINKS ─────────────────────────────────────────────────
// Marks a note or flashcard deck as public, copies it into a top-level
// "shared" collection so it can be read WITHOUT login from the share page.

export async function makeShareable(uid, subcollection, itemId, itemData) {
  // 1. Mark the original as public
  await updateItem(uid, subcollection, itemId, { public: true });

  // 2. Create a public copy in /shared/{itemId} — readable by anyone
  //    per your Firestore security rules (see firestore.rules)
  await setDoc(doc(db, "shared", itemId), {
    ...itemData,
    ownerUid: uid,
    type: subcollection,
    views: 0,
    sharedAt: new Date().toISOString(),
  });

  return `${window.location.origin}/share/${itemId}`;
}

// Read a shared item (public, no auth required) — used on /share/:id page
export async function getSharedItem(itemId) {
  const ref = doc(db, "shared", itemId);
  const { getDoc } = await import("firebase/firestore");
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;

  // increment view count
  await updateDoc(ref, { views: increment(1) });

  return snap.data();
    }
