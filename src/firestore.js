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

// ── Generic top-level collection helpers (faculties, departments, levels,
// courses catalog, announcements) — admin-managed reference data that every
// signed-in student reads live. This was missing from this file even though
// the student app imports and relies on it (registration/profile dropdowns,
// announcements) — without it those features fail outright.
export function listenToTopCollection(collectionName, callback, onError) {
  const ref = collection(db, collectionName);
  return onSnapshot(
    ref,
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => {
      console.error(`[UHub] listenToTopCollection("${collectionName}") failed:`, err);
      if (onError) onError(err);
    }
  );
}

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
  const payload = { ...data, sharedAt: new Date().toISOString(), views: 0 };
  await setDoc(doc(db, "publicNotes", noteId), payload);
  // Create the resource's permanent share-link doc at the SAME time it's
  // first published — this runs in the uploader's own auth context, so
  // it's the one and only time this link is ever created (see
  // shareResourceLink below and firestore.rules: only the owner, or an
  // admin for admin resources, may write to /shared/{id}). Best-effort —
  // a failure here shouldn't block publishing the note itself.
  shareResourceLink(noteId, payload).catch(e => console.warn("Failed to create share link:", e));
}

export async function updatePublicNote(noteId, data) {
  await updateDoc(doc(db, "publicNotes", noteId), data);
  // Keep the permanent share-link copy's content in sync with edits —
  // still the owner's own write, same as the publicNotes update above.
  updateDoc(doc(db, "shared", noteId), data).catch(() => {});
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

// ── SAVED RESOURCES (student's personal bookmarks into the Public Library) ──
// Stored as a lightweight REFERENCE only — never a copy of the resource
// itself. The doc ID is deliberately the SAME as the publicNotes doc it
// points to, which makes "is this already saved" and "remove this save"
// both simple id lookups, and means every render re-reads the live
// publicNotes data by that id — so any edit to the original (by the
// original uploader, admin or student) is exactly what every saver sees,
// with nothing to keep in sync manually. Lives under
// students/{uid}/savedResources/{noteId}, covered by the existing
// students/{uid}/{subcollection}/{docId} security rule (owner-only) —
// no rules changes needed.
export async function saveResource(uid, noteId) {
  await setDoc(doc(db, "students", uid, "savedResources", noteId), {
    noteId,
    savedAt: new Date().toISOString(),
  });
}

export async function unsaveResource(uid, noteId) {
  await deleteDoc(doc(db, "students", uid, "savedResources", noteId));
}

// ── NOTIFICATION READ STATUS ────────────────────────────────────────────────
// Powers the unread badges across the app (Announcements, Assignments,
// Exams, and any future notification type). Tracked PER USER, PER TYPE —
// never a global "read" flag on the item itself, since that would mark it
// read for every student at once. A single doc holds one lastReadAt
// timestamp per type (e.g. { announcements: "...", assignments: "..." });
// unread count for a type = items of that type newer than its lastReadAt.
// Adding a new notification type later is just a new field here — nothing
// else about this system needs to change.
// Lives at students/{uid}/notificationReadStatus/status, already covered
// by the existing students/{uid}/{subcollection}/{docId} rule (owner-only).
export function listenToReadStatus(uid, callback) {
  return onSnapshot(doc(db, "students", uid, "notificationReadStatus", "status"), (snap) => {
    callback(snap.exists() ? snap.data() : {});
  });
}

export async function markNotificationsRead(uid, type) {
  await setDoc(doc(db, "students", uid, "notificationReadStatus", "status"), {
    [type]: new Date().toISOString(),
  }, { merge: true });
}

// ── ANNOUNCEMENTS (read-only here — published by the admin dashboard) ──────
export function listenToAnnouncements(callback, onError) {
  const ref = collection(db, "announcements");
  return onSnapshot(
    ref,
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    (err) => {
      console.error("[UHub] listenToAnnouncements failed:", err);
      if (onError) onError(err);
    }
  );
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
    kind: subcollection, // "flashcards" — which shared-item kind this is; deliberately NOT named `type`, since flashcard/note data can have its own unrelated `type` field
    views: 0,
    sharedAt: new Date().toISOString(),
  });

  return `${window.location.origin}/share/${itemId}`;
}

// ── PUBLIC RESOURCE SHARE LINKS ─────────────────────────────────────────────
// Extends the SAME top-level "shared" collection already used for flashcard
// share links (see makeShareable/getSharedItem above) to public Library
// resources. Unlike makeShareable, there's no "mark the original public"
// step here — a public Library resource (publicNotes doc) is already public
// by definition; this just creates (or refreshes) the ONE permanent public
// copy under /shared/{noteId} that anyone can read WITHOUT signing in.
//
// OWNERSHIP: this is called automatically, exactly once, by addPublicNote
// at publish time (in the owner's own auth context) — that's the normal
// path, so a permanent link exists from the moment a resource goes public.
// It's also called lazily by the student app's ShareButtons, but ONLY when
// the current viewer IS the resource's owner (a legacy-data self-heal for
// resources published before this existed). Firestore rules enforce this
// server-side too: only the owner (ownerUid) or an admin may create/update
// this doc beyond its `views` counter — every other signed-in student who
// clicks Copy Link/Share on someone else's resource only ever READS this
// same doc/URL, never writes to it. This guarantees exactly one permanent
// share URL per resource for its whole lifetime, with no redundant writes.
export async function shareResourceLink(noteId, noteData) {
  await setDoc(doc(db, "shared", noteId), {
    ...noteData,
    ownerUid: noteData.uploaderUid || null,
    // "notes" — which shared-item kind this is (vs. "flashcards" from
    // makeShareable). Deliberately named `kind`, NOT `type` — a Library
    // resource's `type` field already means its file format (Image/PDF/
    // PPTX/DOCX/Other), which ResourceViewer/SharedResourcePreview rely on
    // to decide whether to render a plain <img> or the Google Docs Viewer
    // iframe. Overwriting it here previously caused every shared IMAGE to
    // wrongly fall into the iframe branch (which can't preview images
    // reliably) and show "Couldn't preview file." — the file/URL was never
    // the problem, this field collision was.
    kind: "notes",
    views: noteData.views || 0,
    sharedAt: noteData.sharedAt || new Date().toISOString(),
  });
  return `${window.location.origin}/share/${noteId}`;
}

// Bump the view count on a /shared/{id} doc. Firestore rules let ANYONE —
// even signed out — touch only the `views` field here, so this works for
// an anonymous visitor following a share link, exactly like
// incrementPublicNoteViews does for the live publicNotes doc.
export async function incrementSharedViews(itemId) {
  await updateDoc(doc(db, "shared", itemId), { views: increment(1) });
}

// Removes a resource's public share-link copy. Called whenever the
// original is deleted or unpublished (made private), so a link that's
// already gone out shows "This resource is no longer available" instead of
// stale content. Safe to call even if no share link was ever created —
// deleting a non-existent doc is a no-op, not an error.
export async function deleteSharedItem(itemId) {
  await deleteDoc(doc(db, "shared", itemId));
}

// Read a shared item (public, no auth required) — used on /share/:id page.
// Deliberately a PURE read with no side-effect write: anonymous visitors
// must never trigger a write to `shared`, even an implicit one like a view
// counter (see firestore.rules — every write path requires request.auth).
// View counting for signed-in visitors is handled separately by
// incrementSharedViews, called explicitly (and only) when a signed-in user
// is present — see the useEffect in App().
export async function getSharedItem(itemId) {
  const ref = doc(db, "shared", itemId);
  const { getDoc } = await import("firebase/firestore");
  const snap = await getDoc(ref);
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() };
}
