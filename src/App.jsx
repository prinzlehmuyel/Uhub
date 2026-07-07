import { useState, useEffect } from "react";
import emailjs from "@emailjs/browser";
import {
  registerStudent,
  loginStudent,
  logoutStudent,
  watchAuthState,
  updateStudentProfile,
  resendVerificationEmail,
  refreshEmailVerified,
  requestPasswordReset,
} from "./auth";
import {
  listenToCollection,
  addItem,
  updateItem,
  deleteItem,
  listenToPublicNotes,
  addPublicNote,
  updatePublicNote,
  deletePublicNote,
  incrementPublicNoteViews,
  incrementItemViews,
  listenToAnnouncements,
  makeShareable,
  listenToTopCollection,
} from "./firestore";

// ─── EMAILJS CONFIG — branded notifications ONLY ──────────────────────────────
// Firebase Authentication now handles registration, login, sessions, email
// verification, and password reset natively. EmailJS is kept purely for
// optional custom-branded emails (e.g. a welcome email) — never for auth.
const EJS_SERVICE_ID       = import.meta.env.VITE_EMAILJS_SERVICE_ID          || "";
const EJS_WELCOME_TEMPLATE = import.meta.env.VITE_EMAILJS_WELCOME_TEMPLATE_ID || "";
const EJS_PUBLIC_KEY       = import.meta.env.VITE_EMAILJS_PUBLIC_KEY          || "";

// Fire-and-forget branded welcome email sent after a successful registration.
// Non-blocking and non-critical: if it's not configured or fails, registration
// still succeeds — we just log a warning.
async function sendWelcomeEmail(toEmail, toName) {
  if (!EJS_SERVICE_ID || !EJS_WELCOME_TEMPLATE || !EJS_PUBLIC_KEY) return;
  try {
    await emailjs.send(
      EJS_SERVICE_ID,
      EJS_WELCOME_TEMPLATE,
      { to_email: toEmail, to_name: toName },
      EJS_PUBLIC_KEY
    );
  } catch (e) {
    console.warn("Welcome email failed to send (non-blocking):", e);
  }
}

// ─── CLOUDINARY CONFIG ────────────────────────────────────────────────────────
const CLD_CLOUD  = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME    || "";
const CLD_PRESET = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET || "";

// Accepted file types for the library
const ACCEPTED_TYPES = ".pdf,.doc,.docx,.ppt,.pptx,.jpg,.jpeg,.png,.gif,.webp";
const MAX_FILE_MB    = 10;

function detectFileType(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  if (ext === "pdf")                       return "PDF";
  if (["ppt","pptx"].includes(ext))        return "PPTX";
  if (["doc","docx"].includes(ext))        return "DOCX";
  if (["jpg","jpeg","png","gif","webp"].includes(ext)) return "Image";
  return "Other";
}

function uploadToCloudinary(file, onProgress) {
  if (!CLD_CLOUD || !CLD_PRESET) {
    return Promise.reject(new Error(
      "Cloudinary is not configured. Add VITE_CLOUDINARY_CLOUD_NAME and " +
      "VITE_CLOUDINARY_UPLOAD_PRESET to your .env file and Vercel settings."
    ));
  }
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("file",           file);
    fd.append("upload_preset",  CLD_PRESET);
    fd.append("folder",         "uhub_library");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `https://api.cloudinary.com/v1_1/${CLD_CLOUD}/auto/upload`);
    xhr.upload.onprogress = (e) => {
      if (onProgress && e.lengthComputable)
        onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status === 200) {
        resolve(JSON.parse(xhr.responseText).secure_url);
      } else {
        reject(new Error("Cloudinary upload failed: " + xhr.responseText));
      }
    };
    xhr.onerror = () => reject(new Error("Network error — check your connection and try again."));
    xhr.send(fd);
  });
}

// ─── THEME ───────────────────────────────────────────────────────────────────
const BLUE       = "#1A56DB";
const BLUE_LIGHT = "#EBF2FF";
const WHITE      = "#FFFFFF";
const GRAY       = "#F8FAFC";
const TEXT       = "#1E293B";
const MUTED      = "#64748B";
const BORDER     = "#E2E8F0";
const GREEN      = "#10B981";
const ORANGE     = "#F59E0B";
const RED        = "#EF4444";

// NOTE: All student data (courses, assignments, notes, flashcards,
// gpaRecords, examDates, studyPlans) now lives in real Firestore under
// students/{uid}/{collection}/{id} — see firestore.js. App() below sets up
// live onSnapshot listeners for each collection and assembles them into
// `userData`, so every component here just reads userData.<collection>
// as its source of truth and calls addItem/updateItem/deleteItem to write.

// ─── HELPERS ──────────────────────────────────────────────────────────────────
// NOTE: named genId to avoid shadowing the `uid` prop in components
const genId = () => Math.random().toString(36).slice(2, 10);
const gradePoints = { A: 5, B: 4, C: 3, D: 2, E: 1, F: 0 };
const daysUntil = (date) => Math.ceil((new Date(date) - new Date()) / 86400000);
const fmtDate   = (d) => new Date(d).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" });

// Translate Firebase Auth error codes into student-friendly messages
function authErrorMessage(e) {
  const code = e?.code || "";
  const map = {
    "auth/email-already-in-use": "That email is already registered — try logging in instead.",
    "auth/invalid-email":        "Please enter a valid email address.",
    "auth/weak-password":        "Password must be at least 6 characters.",
    "auth/user-not-found":       "Invalid email or password.",
    "auth/wrong-password":       "Invalid email or password.",
    "auth/invalid-credential":   "Invalid email or password.",
    "auth/too-many-requests":    "Too many attempts — please wait a moment and try again.",
    "auth/network-request-failed": "Network error — check your connection and try again.",
  };
  return map[code] || e?.message || "Something went wrong. Please try again.";
}

// ─── STYLES ───────────────────────────────────────────────────────────────────
const S = {
  app:        { fontFamily: "'Inter','Segoe UI',sans-serif", background: WHITE, minHeight: "100vh", color: TEXT },
  nav:        { background: BLUE, color: WHITE, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 20px", height: 60, position: "sticky", top: 0, zIndex: 100, boxShadow: "0 2px 8px rgba(26,86,219,0.3)" },
  navBrand:   { fontWeight: 800, fontSize: 22, letterSpacing: -0.5, color: WHITE, display: "flex", alignItems: "center", gap: 8 },
  navRight:   { display: "flex", alignItems: "center", gap: 12 },
  page:       { padding: "24px 16px", maxWidth: 900, margin: "0 auto" },
  card:       { background: WHITE, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 20, marginBottom: 16 },
  cardBlue:   { background: BLUE_LIGHT, border: `1px solid ${BLUE}22`, borderRadius: 12, padding: 20, marginBottom: 16 },
  grid2:      { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 14, marginBottom: 20 },
  grid3:      { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12, marginBottom: 20 },
  stat:       { background: WHITE, border: `1px solid ${BORDER}`, borderRadius: 12, padding: 16, textAlign: "center" },
  statNum:    { fontSize: 28, fontWeight: 800, color: BLUE },
  statLabel:  { fontSize: 12, color: MUTED, marginTop: 4, fontWeight: 500 },
  label:      { display: "block", fontSize: 13, fontWeight: 600, color: TEXT, marginBottom: 6 },
  input:      { width: "100%", padding: "10px 14px", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 14, color: TEXT, background: WHITE, boxSizing: "border-box", outline: "none" },
  select:     { width: "100%", padding: "10px 14px", border: `1px solid ${BORDER}`, borderRadius: 8, fontSize: 14, color: TEXT, background: WHITE, boxSizing: "border-box", outline: "none" },
  formGroup:  { marginBottom: 16 },
  row2:       { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
  btn:        { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "10px 18px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 14, fontWeight: 600, transition: "all 0.15s" },
  btnBlue:    { background: BLUE, color: WHITE },
  btnOutline: { background: WHITE, color: BLUE, border: `1.5px solid ${BLUE}` },
  btnRed:     { background: RED, color: WHITE },
  btnGreen:   { background: GREEN, color: WHITE },
  btnGray:    { background: GRAY, color: TEXT, border: `1px solid ${BORDER}` },
  btnSm:      { padding: "6px 12px", fontSize: 12, borderRadius: 6 },
  badge:      { display: "inline-flex", alignItems: "center", padding: "3px 10px", borderRadius: 20, fontSize: 12, fontWeight: 600 },
  badgeBlue:  { background: BLUE_LIGHT, color: BLUE },
  badgeGreen: { background: "#D1FAE5", color: "#065F46" },
  badgeOrange:{ background: "#FEF3C7", color: "#92400E" },
  badgeRed:   { background: "#FEE2E2", color: "#991B1B" },
  h1:         { fontSize: 24, fontWeight: 800, color: TEXT, margin: "0 0 4px" },
  h2:         { fontSize: 18, fontWeight: 700, color: TEXT, margin: "0 0 16px" },
  muted:      { color: MUTED, fontSize: 13 },
  sectionHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 },
  bottomNav:  { position: "fixed", bottom: 0, left: 0, right: 0, background: WHITE, borderTop: `1px solid ${BORDER}`, display: "flex", zIndex: 100, boxShadow: "0 -2px 12px rgba(0,0,0,0.08)" },
  bottomNavItem: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "8px 4px", cursor: "pointer", gap: 3 },
  bottomNavLabel: { fontSize: 10, fontWeight: 600 },
  listItem:   { background: WHITE, border: `1px solid ${BORDER}`, borderRadius: 10, padding: "14px 16px", marginBottom: 10, display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 },
  overlay:    { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 200, display: "flex", alignItems: "flex-end", justifyContent: "center" },
  modal:      { background: WHITE, borderRadius: "16px 16px 0 0", width: "100%", maxWidth: 500, padding: 24, maxHeight: "90vh", overflowY: "auto" },
  authWrap:   { minHeight: "100vh", background: BLUE_LIGHT, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 },
  authCard:   { background: WHITE, borderRadius: 16, padding: 32, width: "100%", maxWidth: 400, boxShadow: "0 4px 24px rgba(26,86,219,0.12)" },
  empty:      { textAlign: "center", padding: "40px 20px", color: MUTED },
  emptyIcon:  { fontSize: 40, marginBottom: 12 },
};

// ─── REUSABLE COMPONENTS ──────────────────────────────────────────────────────

function Btn({ children, onClick, style, disabled, variant = "blue", size }) {
  const varMap = { blue: S.btnBlue, outline: S.btnOutline, red: S.btnRed, green: S.btnGreen, gray: S.btnGray };
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{ ...S.btn, ...varMap[variant], ...(size === "sm" ? S.btnSm : {}), ...style, opacity: disabled ? 0.6 : 1 }}
    >
      {children}
    </button>
  );
}

function Field({ label, value, onChange, type = "text", placeholder, required, disabled }) {
  return (
    <div style={S.formGroup}>
      {label && <label style={S.label}>{label}{required && <span style={{ color: RED }}> *</span>}</label>}
      <input
        type={type} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} required={required} disabled={disabled}
        style={{ ...S.input, ...(disabled ? { background: "#F1F5F9", color: MUTED } : {}) }}
        onFocus={e => (e.target.style.borderColor = BLUE)}
        onBlur={e  => (e.target.style.borderColor = BORDER)}
      />
    </div>
  );
}

function Dropdown({ label, value, onChange, options, required, placeholder, disabled }) {
  const isEmpty = !options || options.length === 0;
  return (
    <div style={S.formGroup}>
      {label && <label style={S.label}>{label}{required && <span style={{ color: RED }}> *</span>}</label>}
      <select value={value} onChange={e => onChange(e.target.value)} style={{ ...S.select, ...(disabled ? { background: "#F1F5F9", color: MUTED } : {}) }}
        required={required} disabled={isEmpty || disabled}>
        <option value="">{isEmpty ? "No options available" : (placeholder || "Select...")}</option>
        {options.map(o => <option key={o.value ?? o} value={o.value ?? o}>{o.label ?? o}</option>)}
      </select>
    </div>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div style={S.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={S.modal}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
          <h2 style={{ ...S.h2, margin: 0 }}>{title}</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: MUTED }}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function Empty({ icon, title, subtitle, action }) {
  return (
    <div style={S.empty}>
      <div style={S.emptyIcon}>{icon}</div>
      <div style={{ fontWeight: 700, fontSize: 15, color: TEXT, marginBottom: 6 }}>{title}</div>
      <div style={S.muted}>{subtitle}</div>
      {action && <div style={{ marginTop: 16 }}>{action}</div>}
    </div>
  );
}

function Badge({ children, variant = "blue" }) {
  const varMap = { blue: S.badgeBlue, green: S.badgeGreen, orange: S.badgeOrange, red: S.badgeRed };
  return <span style={{ ...S.badge, ...varMap[variant] }}>{children}</span>;
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
// Faculties, departments, and levels are managed ENTIRELY by the Admin
// Dashboard in Firestore ("faculties" / "departments" / "levels"
// collections). There is intentionally NO built-in/fallback list anywhere
// in this app — if the admin hasn't created any yet (or has deleted all of
// them), the student simply sees "no options available" until the admin
// adds some. This is a deliberate choice: the admin is the single source
// of truth for this data, full stop.

// Live faculties (with Firestore doc ids, needed to scope departments correctly).
function useLiveFaculties() {
  const [faculties, setFaculties] = useState([]);
  useEffect(() => listenToTopCollection("faculties", setFaculties), []);
  return { faculties, names: faculties.map(f => f.name) };
}

// Live levels, sorted by admin's chosen order.
function useLiveLevels() {
  const [levels, setLevels] = useState([]);
  useEffect(() => listenToTopCollection("levels", (l) => setLevels([...l].sort((a, b) => (a.order || 0) - (b.order || 0)))), []);
  return levels.map(l => l.name);
}

// Departments scoped to a chosen faculty name (matched via facultyId, same
// as the admin dashboard, so it stays correct even with duplicate names).
function useLiveDepartments(facultyName, faculties) {
  const [departments, setDepartments] = useState([]);
  useEffect(() => listenToTopCollection("departments", setDepartments), []);
  const fac = faculties.find(f => f.name === facultyName);
  if (!fac) return [];
  return departments.filter(d => d.facultyId === fac.id).map(d => d.name);
}

// Normalizes a course code for comparison so "CSC 301", "csc301", and
// "CSC301" are all treated as the same course — students free-type these,
// so both catalog lookup and announcement targeting need to be forgiving
// of spacing/case differences.
const normalizeCode = (s) => (s || "").toUpperCase().replace(/\s+/g, "");

// Live admin-managed course catalog ("courses" top-level collection, written
// by the Admin Dashboard's Course Catalog page). Used to look up a course by
// code as the student types it, so Title/Units/Department(s) can be
// auto-filled instead of manually re-typed. Purely additive — if the admin
// hasn't catalogued a course (or catalogued none at all), the student can
// still add it manually exactly as before.
function useLiveCourseCatalog() {
  const [courses, setCourses] = useState([]);
  useEffect(() => listenToTopCollection("courses", setCourses), []);
  return courses;
}

// ─── AUTH SCREEN ──────────────────────────────────────────────────────────────
function AuthScreen({ onAuth }) {
  const [mode, setMode]           = useState("login"); // login | register | forgot
  const [email, setEmail]         = useState("");
  const [password, setPassword]   = useState("");
  const [name, setName]           = useState("");
  const [error, setError]         = useState("");
  const [loading, setLoading]     = useState(false);

  // ── Forgot password state ──────────────────────────────────────────────────
  // Firebase sends the actual reset link + handles the password change itself,
  // so we only need to track whether the request went out.
  const [resetSent, setResetSent] = useState(false);
  const [resending, setResending] = useState(false);

  // ── Register / Log in (real Firebase Auth) ──────────────────────────────────
  // Registration now ONLY collects Name, Email, and Password. Faculty,
  // Department, and Level are chosen afterwards on the "Complete Your
  // Profile" step (see CompleteProfile below) — that step is the only place
  // those three fields are ever set, and it sources its options exclusively
  // from what the admin has created in Firestore.
  const submit = async () => {
    setError(""); setLoading(true);
    try {
      if (mode === "register") {
        if (!name || !email || !password) {
          setError("Please fill in all fields"); setLoading(false); return;
        }
        if (password.length < 6) {
          setError("Password must be at least 6 characters."); setLoading(false); return;
        }
        const session = await registerStudent(email, password, { name, email });
        // Branded welcome email — purely cosmetic, never blocks registration
        sendWelcomeEmail(email, name);
        onAuth(session);
      } else {
        if (!email || !password) { setError("Please fill in all fields"); setLoading(false); return; }
        const session = await loginStudent(email, password);
        onAuth(session);
      }
    } catch (e) {
      setError(authErrorMessage(e));
      setLoading(false);
    }
  };

  // ── Forgot password: Firebase sends the reset link directly ────────────────
  const requestReset = async (isResend) => {
    setError("");
    if (!email.trim()) { setError("Please enter your email"); return; }

    isResend ? setResending(true) : setLoading(true);
    try {
      await requestPasswordReset(email);
      setResetSent(true);
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      isResend ? setResending(false) : setLoading(false);
    }
  };

  const backToLogin = () => {
    setMode("login"); setError(""); setResetSent(false); setPassword("");
  };

  // ── FORGOT PASSWORD VIEW ────────────────────────────────────────────────────
  if (mode === "forgot") {
    return (
      <div style={S.authWrap}>
        <div style={S.authCard}>
          <div style={{ textAlign: "center", marginBottom: 24 }}>
            <div style={{ fontSize: 40, marginBottom: 8 }}>🔑</div>
            <div style={{ fontSize: 22, fontWeight: 900, color: BLUE, letterSpacing: -0.5 }}>Reset your password</div>
            <div style={{ fontSize: 13, color: MUTED, marginTop: 8, lineHeight: 1.6 }}>
              {resetSent
                ? <>We've sent a password reset link to<br /><strong style={{ color: TEXT }}>{email}</strong></>
                : "Enter the email linked to your account and we'll send you a secure reset link."
              }
            </div>
          </div>

          {error && (
            <div style={{ background: "#FEE2E2", color: RED, padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
              {error}
            </div>
          )}

          {resetSent ? (
            <>
              <div style={{ background: "#D1FAE5", border: "1px solid #10B981", borderRadius: 10, padding: 20, textAlign: "center", marginBottom: 16 }}>
                <div style={{ fontSize: 32, marginBottom: 8 }}>📩</div>
                <div style={{ fontWeight: 700, color: "#065F46", fontSize: 15 }}>Check your inbox</div>
                <div style={{ color: "#065F46", fontSize: 13, marginTop: 4, lineHeight: 1.5 }}>
                  Open the email and tap the link to choose a new password, then come back and log in.
                </div>
              </div>
              <div style={{ textAlign: "center", fontSize: 13, color: MUTED }}>
                Didn't get it?{" "}
                <span
                  onClick={!resending ? () => requestReset(true) : undefined}
                  style={{ color: resending ? MUTED : BLUE, fontWeight: 700, cursor: resending ? "default" : "pointer" }}
                >
                  {resending ? "Sending..." : "Resend link"}
                </span>
              </div>
            </>
          ) : (
            <>
              <Field label="Email" value={email} onChange={setEmail} type="email" placeholder="student@unimaid.edu.ng" required />
              <Btn onClick={() => requestReset(false)} disabled={loading} style={{ width: "100%", padding: "12px 0", fontSize: 15, marginTop: 4 }}>
                {loading ? "Sending link..." : "Send Reset Link"}
              </Btn>
            </>
          )}

          <div style={{ textAlign: "center", marginTop: 20 }}>
            <span onClick={backToLogin} style={{ fontSize: 13, color: MUTED, cursor: "pointer", textDecoration: "underline" }}>
              ← Back to Log In
            </span>
          </div>
        </div>
      </div>
    );
  }

  // ── LOGIN / REGISTER VIEW ───────────────────────────────────────────────────
  return (
    <div style={S.authWrap}>
      <div style={S.authCard}>
        <div style={{ textAlign: "center", marginBottom: 28 }}>
          <div style={{ fontSize: 36, marginBottom: 4 }}>🎓</div>
          <div style={{ fontSize: 26, fontWeight: 900, color: BLUE, letterSpacing: -1 }}>UHub</div>
          <div style={{ fontSize: 13, color: MUTED, marginTop: 2 }}>Your Personal Academic Companion</div>
        </div>

        {/* Tab toggle */}
        <div style={{ display: "flex", background: GRAY, borderRadius: 8, padding: 3, marginBottom: 24 }}>
          {["login","register"].map(m => (
            <button key={m} onClick={() => { setMode(m); setError(""); }}
              style={{ flex: 1, padding: "8px 0", borderRadius: 6, border: "none", cursor: "pointer", fontWeight: 600, fontSize: 13,
                background: mode === m ? WHITE : "transparent", color: mode === m ? BLUE : MUTED,
                boxShadow: mode === m ? "0 1px 4px rgba(0,0,0,0.1)" : "none" }}>
              {m === "login" ? "Log In" : "Register"}
            </button>
          ))}
        </div>

        {error && <div style={{ background: "#FEE2E2", color: RED, padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 16 }}>{error}</div>}

        {mode === "register" && (
          <Field label="Full Name" value={name} onChange={setName} placeholder="e.g. Aisha Mohammed" required />
        )}

        <Field label="Email" value={email} onChange={setEmail} type="email" placeholder="student@unimaid.edu.ng" required />
        <Field label="Password" value={password} onChange={setPassword} type="password" placeholder="••••••••" required />

        {mode === "login" && (
          <div style={{ textAlign: "right", marginTop: -10, marginBottom: 16 }}>
            <span onClick={() => { setMode("forgot"); setError(""); setResetSent(false); }}
              style={{ fontSize: 12.5, color: BLUE, fontWeight: 600, cursor: "pointer" }}>
              Forgot password?
            </span>
          </div>
        )}

        <Btn onClick={submit} disabled={loading} style={{ width: "100%", padding: "12px 0", fontSize: 15, marginTop: 4 }}>
          {loading ? "Please wait..." : mode === "login" ? "Log In to UHub" : "Create Account"}
        </Btn>

        <div style={{ textAlign: "center", marginTop: 16, fontSize: 13, color: MUTED }}>
          University of Maiduguri · UNIMAID
        </div>
      </div>
    </div>
  );
}

// ─── COMPLETE PROFILE (required after first login) ───────────────────────────
// Registration only collects Name/Email/Password (see AuthScreen above).
// Faculty, Department, and Level are chosen HERE instead, on first login —
// and their options come EXCLUSIVELY from what the admin has created in
// Firestore. There is no built-in list to fall back on: if the admin hasn't
// added any faculties/levels yet, the student sees a clear "not set up yet"
// message and simply can't proceed until the admin does.
function CompleteProfile({ user, onComplete }) {
  const [faculty, setFaculty]   = useState("");
  const [department, setDept]  = useState("");
  const [level, setLevel]      = useState("");
  const [error, setError]      = useState("");
  const [saving, setSaving]    = useState(false);

  const { faculties, names: facultyNames } = useLiveFaculties();
  const levelNames = useLiveLevels();
  const departmentNames = useLiveDepartments(faculty, faculties);

  const noFaculties = facultyNames.length === 0;
  const noLevels     = levelNames.length === 0;

  const submit = async () => {
    if (!faculty || !department || !level) { setError("Please complete all three fields."); return; }
    setSaving(true); setError("");
    try {
      await updateStudentProfile(user.uid, { faculty, department, level });
      onComplete({ ...user.profile, faculty, department, level });
    } catch (e) {
      setError(e?.message || "Failed to save your profile. Please try again.");
      setSaving(false);
    }
  };

  return (
    <div style={S.authWrap}>
      <div style={S.authCard}>
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🎓</div>
          <div style={{ fontSize: 20, fontWeight: 900, color: BLUE, letterSpacing: -0.5 }}>Complete Your Profile</div>
          <div style={{ fontSize: 13, color: MUTED, marginTop: 8, lineHeight: 1.6 }}>
            One last step{user.profile?.name ? `, ${user.profile.name.split(" ")[0]}` : ""} — tell us your faculty, department, and level.
          </div>
        </div>

        {error && (
          <div style={{ background: "#FEE2E2", color: RED, padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
            {error}
          </div>
        )}

        {(noFaculties || noLevels) && (
          <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 14px", fontSize: 12.5, color: "#92400E", marginBottom: 16, lineHeight: 1.5 }}>
            Your school administrator hasn't set up {noFaculties && noLevels ? "faculties or levels" : noFaculties ? "faculties" : "levels"} yet.
            You won't be able to finish this step until they do — check back soon.
          </div>
        )}

        <Dropdown label="Faculty" value={faculty} onChange={v => { setFaculty(v); setDept(""); }} options={facultyNames} required />
        <Dropdown label="Department" value={department} onChange={setDept} options={departmentNames} required
          placeholder={faculty ? "Select..." : "Choose a faculty first"} />
        <Dropdown label="Level" value={level} onChange={setLevel} options={levelNames} required />

        <Btn onClick={submit} disabled={saving || !faculty || !department || !level} style={{ width: "100%", padding: "12px 0", fontSize: 15, marginTop: 4 }}>
          {saving ? "Saving..." : "Continue to UHub"}
        </Btn>
      </div>
    </div>
  );
}

// ─── EMAIL VERIFICATION SCREEN ────────────────────────────────────────────────
// Firebase already emailed a verification LINK the moment the account was
// created (see registerStudent in auth.js). This screen just waits for the
// student to click it, then re-checks their Firebase Auth status.
function EmailVerification({ user, onVerified }) {
  const [checking, setChecking]   = useState(false);
  const [resending, setResending] = useState(false);
  const [notYet, setNotYet]       = useState(false);
  const [error, setError]         = useState("");
  const [resent, setResent]       = useState(false);

  const checkNow = async () => {
    setChecking(true); setError(""); setNotYet(false);
    try {
      const verified = await refreshEmailVerified();
      if (verified) {
        onVerified({ ...user, emailVerified: true });
      } else {
        setNotYet(true);
      }
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setChecking(false);
    }
  };

  const resend = async () => {
    setResending(true); setError(""); setResent(false);
    try {
      await resendVerificationEmail();
      setResent(true);
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setResending(false);
    }
  };

  const switchAccount = async () => {
    try { await logoutStudent(); } finally { window.location.reload(); }
  };

  return (
    <div style={S.authWrap}>
      <div style={S.authCard}>

        {/* Header */}
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <div style={{ fontSize: 48, marginBottom: 8 }}>📧</div>
          <div style={{ fontSize: 22, fontWeight: 900, color: BLUE, letterSpacing: -0.5 }}>Verify your email</div>
          <div style={{ fontSize: 13, color: MUTED, marginTop: 8, lineHeight: 1.6 }}>
            We've sent a verification link to<br /><strong style={{ color: TEXT }}>{user.email}</strong>
          </div>
        </div>

        {error && (
          <div style={{ background: "#FEE2E2", color: RED, padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
            {error}
          </div>
        )}

        {notYet && (
          <div style={{ background: "#FEF3C7", color: "#92400E", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
            Still not verified — open the email and tap the link, then try again.
          </div>
        )}

        {resent && (
          <div style={{ background: "#D1FAE5", color: "#065F46", padding: "10px 14px", borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
            Verification email resent — check your inbox and spam folder.
          </div>
        )}

        <div style={{ fontSize: 13, color: MUTED, textAlign: "center", marginBottom: 16, lineHeight: 1.6 }}>
          1. Open the email from Firebase<br />
          2. Tap the verification link<br />
          3. Come back here and tap the button below
        </div>

        <Btn onClick={checkNow} disabled={checking} style={{ width: "100%", padding: "13px 0", fontSize: 15 }}>
          {checking ? "Checking..." : "I've verified my email"}
        </Btn>

        {/* Resend */}
        <div style={{ textAlign: "center", marginTop: 16, fontSize: 13, color: MUTED }}>
          Didn't receive it?{" "}
          <span
            onClick={!resending ? resend : undefined}
            style={{ color: resending ? MUTED : BLUE, fontWeight: 700, cursor: resending ? "default" : "pointer" }}
          >
            {resending ? "Sending..." : "Resend verification email"}
          </span>
        </div>

        {/* Switch account */}
        <div style={{ textAlign: "center", marginTop: 20 }}>
          <span
            onClick={switchAccount}
            style={{ fontSize: 13, color: MUTED, cursor: "pointer", textDecoration: "underline" }}
          >
            Use a different account
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── DASHBOARD ────────────────────────────────────────────────────────────────
function Dashboard({ user, userData, announcements = [], onOpenAnnouncements }) {
  const { courses = [], assignments = [], examDates = [], gpaRecords = [] } = userData;
  const pending    = assignments.filter(a => !a.done);
  const upcoming   = pending.filter(a => daysUntil(a.deadline) >= 0)
                      .sort((a, b) => new Date(a.deadline) - new Date(b.deadline)).slice(0, 3);
  const nextExam   = examDates.filter(e => daysUntil(e.date) >= 0)
                      .sort((a, b) => new Date(a.date) - new Date(b.date))[0];
  // Firestore doesn't guarantee array order matches save order, so pick the
  // most recently dated record rather than trusting array position — and
  // surface its cumulative CGPA (the whole point of tracking it) rather
  // than just that one semester's GPA.
  const latestRecord = gpaRecords.length
    ? [...gpaRecords].sort((a, b) => new Date(b.date) - new Date(a.date))[0]
    : null;
  const latestImportant = [...announcements].filter(a => a.important)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];

  return (
    <div style={S.page}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={S.h1}>Welcome back, {user.profile?.name?.split(" ")[0]} 👋</h1>
        <p style={S.muted}>{user.profile?.department} · {user.profile?.level}</p>
      </div>

      {latestImportant && (
        <div onClick={onOpenAnnouncements} style={{ ...S.card, background: "#FEF2F2", border: "1px solid #FECACA", cursor: "pointer", marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 10, alignItems: "flex-start" }}>
            <span style={{ fontSize: 20 }}>🔴</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 800, fontSize: 13.5, color: "#991B1B" }}>{latestImportant.title}</div>
              <div style={{ fontSize: 12.5, color: "#991B1B", marginTop: 2, opacity: 0.85 }}>Tap to view all announcements</div>
            </div>
          </div>
        </div>
      )}

      <div style={S.grid3}>
        <div style={S.stat}><div style={S.statNum}>{courses.length}</div><div style={S.statLabel}>Courses</div></div>
        <div style={S.stat}><div style={S.statNum}>{pending.length}</div><div style={S.statLabel}>Pending Tasks</div></div>
        <div style={S.stat}>
          <div style={{ ...S.statNum, color: GREEN }}>{latestRecord ? latestRecord.cgpa.toFixed(2) : "—"}</div>
          <div style={S.statLabel}>Current CGPA</div>
        </div>
        <div style={S.stat}>
          <div style={{ ...S.statNum, color: ORANGE }}>{nextExam ? daysUntil(nextExam.date) : "—"}</div>
          <div style={S.statLabel}>{nextExam ? `Days to ${nextExam.course}` : "No Exams Set"}</div>
        </div>
      </div>

      {upcoming.length > 0 && (
        <div style={S.card}>
          <h2 style={S.h2}>📋 Upcoming Assignments</h2>
          {upcoming.map(a => {
            const d = daysUntil(a.deadline);
            return (
              <div key={a.id} style={{ ...S.listItem, marginBottom: 8 }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>{a.title}</div>
                  <div style={S.muted}>{a.course} · Due {fmtDate(a.deadline)}</div>
                </div>
                <Badge variant={d <= 1 ? "red" : d <= 3 ? "orange" : "blue"}>
                  {d === 0 ? "Today" : d === 1 ? "Tomorrow" : `${d}d`}
                </Badge>
              </div>
            );
          })}
        </div>
      )}

      {nextExam && (
        <div style={{ ...S.cardBlue, display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ fontSize: 36 }}>⏰</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: BLUE }}>{nextExam.course} Exam</div>
            <div style={{ fontSize: 13, color: MUTED }}>
              {fmtDate(nextExam.date)} ·{" "}
              <b style={{ color: daysUntil(nextExam.date) <= 7 ? RED : BLUE }}>
                {daysUntil(nextExam.date)} days away
              </b>
            </div>
          </div>
        </div>
      )}

      {courses.length === 0 && (
        <div style={S.card}>
          <Empty icon="📚" title="Add your courses to get started" subtitle="Your dashboard updates as you add courses, assignments, and exam dates" />
        </div>
      )}
    </div>
  );
}

// ─── COURSES ──────────────────────────────────────────────────────────────────
function Courses({ uid, userData, user }) {
  const courses = userData.courses || [];
  const levelNames = useLiveLevels();
  const catalog = useLiveCourseCatalog();
  const [modal, setModal]     = useState(false);
  const [code, setCode]       = useState("");
  const [title, setTitle]     = useState("");
  const [units, setUnits]     = useState("3");
  const [level, setLevel]     = useState(user?.profile?.level || "");
  const [semester, setSem]    = useState("1st Semester");
  const [saving, setSaving]   = useState(false);
  const [error, setError]     = useState("");

  // Look up the typed code against the admin's catalog, ignoring case and
  // extra spacing. This is purely additive — if nothing matches (or the
  // admin hasn't catalogued anything at all), the student just fills in
  // Title/Units manually exactly as before.
  const matched = code.trim() ? catalog.find(c => normalizeCode(c.code) === normalizeCode(code)) : null;
  const notFound = code.trim().length > 0 && !matched;

  // When a NEW match is found, auto-fill Title/Units (locked, since the
  // catalog is authoritative) and, if the catalog entry has a level/semester
  // set, prefill those too — but leave level/semester editable, since a
  // student might be taking a carryover in a different level/semester than
  // the catalog's "typical" assignment.
  useEffect(() => {
    if (!matched) return;
    setTitle(matched.title);
    setUnits(String(matched.units));
    if (matched.level) setLevel(matched.level);
    if (matched.semester) setSem(matched.semester);
  }, [matched?.id]);

  const closeModal = () => {
    setModal(false); setCode(""); setTitle(""); setUnits("3"); setSem("1st Semester"); setError("");
  };

  const save = async () => {
    if (!code || !title || !level) return;
    setSaving(true); setError("");
    try {
      await addItem(uid, "courses", {
        code: code.toUpperCase(), title, units: Number(units), level, semester,
        // Informational only — captured when the course was matched against
        // the admin catalog at the time it was added.
        departments: matched?.departmentNames || [],
        catalogCourseId: matched?.id || null,
      });
      closeModal();
    } catch (e) {
      setError(e?.message || "Failed to save course.");
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id) => {
    try {
      await deleteItem(uid, "courses", id);
    } catch (e) {
      console.warn("Failed to remove course:", e);
    }
  };

  // Group by level (in the admin's chosen order), then by semester within
  // each level. Courses saved before the level field existed (or a level
  // the admin has since renamed/removed) fall back to "Unspecified Level".
  const levelsPresent = levelNames.filter(l => courses.some(c => (c.level || "Unspecified Level") === l));
  const otherLevels = [...new Set(courses.map(c => c.level || "Unspecified Level"))].filter(l => !levelNames.includes(l));
  const groupLevels = [...levelsPresent, ...otherLevels];

  return (
    <div style={S.page}>
      <div style={S.sectionHeader}>
        <h1 style={S.h1}>My Courses</h1>
        <Btn onClick={() => setModal(true)}>+ Add Course</Btn>
      </div>

      {courses.length === 0
        ? <Empty icon="📖" title="No courses added yet" subtitle="Add your semester courses to organise your academic life" action={<Btn onClick={() => setModal(true)}>Add First Course</Btn>} />
        : groupLevels.map(lvl => {
          const levelCourses = courses.filter(c => (c.level || "Unspecified Level") === lvl);
          const sems = [...new Set(levelCourses.map(c => c.semester))];
          return (
            <div key={lvl} style={{ marginBottom: 8 }}>
              <div style={{ fontWeight: 800, fontSize: 14, color: TEXT, marginTop: 20, marginBottom: 4 }}>{lvl}</div>
              {sems.map(sem => (
                <div key={sem}>
                  <div style={{ fontWeight: 700, fontSize: 12, color: BLUE, marginBottom: 10, marginTop: 10, textTransform: "uppercase", letterSpacing: 0.5 }}>{sem}</div>
                  {levelCourses.filter(c => c.semester === sem).map(c => (
                    <div key={c.id} style={S.listItem}>
                      <div>
                        <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 4, flexWrap: "wrap" }}>
                          <Badge>{c.code}</Badge>
                          <span style={{ fontWeight: 600, fontSize: 14 }}>{c.title}</span>
                        </div>
                        <div style={S.muted}>{c.units} unit{c.units !== 1 ? "s" : ""}</div>
                      </div>
                      <Btn variant="red" size="sm" onClick={() => remove(c.id)}>Remove</Btn>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          );
        })
      }

      {modal && (
        <Modal title="Add Course" onClose={closeModal}>
          <Field label="Course Code" value={code} onChange={v => setCode(v.toUpperCase())} placeholder="e.g. CSC 301" required />

          {matched && (
            <div style={{ background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 8, padding: "10px 12px", fontSize: 12.5, color: "#065F46", marginBottom: 14, lineHeight: 1.6 }}>
              ✓ Found in catalog — title and units filled in automatically.
              {matched.departmentNames?.length > 0 && (
                <div style={{ marginTop: 4 }}>Offered to: {matched.departmentNames.join(", ")}</div>
              )}
            </div>
          )}
          {notFound && (
            <div style={{ background: "#FFFBEB", border: "1px solid #FDE68A", borderRadius: 8, padding: "10px 12px", fontSize: 12.5, color: "#92400E", marginBottom: 14 }}>
              Course not found in catalog — you can still add it manually below.
            </div>
          )}

          <div style={S.row2}>
            <Field label="Course Title" value={title} onChange={setTitle} placeholder="e.g. Data Structures" required disabled={!!matched} />
            <Dropdown label="Units" value={units} onChange={setUnits} options={["1","2","3","4","5","6"]} required disabled={!!matched} />
          </div>
          <div style={S.row2}>
            <Dropdown label="Level" value={level} onChange={setLevel} options={levelNames} required />
            <Dropdown label="Semester" value={semester} onChange={setSem} options={["1st Semester","2nd Semester"]} required />
          </div>
          {error && <div style={{ fontSize: 13, color: RED, marginBottom: 10 }}>{error}</div>}
          <Btn onClick={save} disabled={saving} style={{ width: "100%" }}>{saving ? "Saving..." : "Save Course"}</Btn>
        </Modal>
      )}
    </div>
  );
}

// ─── ASSIGNMENTS ──────────────────────────────────────────────────────────────
function Assignments({ uid, userData }) {
  const assignments = userData.assignments || [];
  const [modal, setModal]   = useState(false);
  const [title, setTitle]   = useState("");
  const [course, setCourse] = useState("");
  const [deadline, setDL]   = useState("");
  const [notes, setNotes]   = useState("");
  const [filter, setFilter] = useState("all");
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState("");
  const courseOpts = (userData.courses || []).map(c => ({ value: c.code, label: `${c.code} - ${c.title}` }));

  const save = async () => {
    if (!title || !deadline) return;
    setSaving(true); setError("");
    try {
      await addItem(uid, "assignments", { title, course, deadline, notes, done: false });
      setModal(false); setTitle(""); setCourse(""); setDL(""); setNotes("");
    } catch (e) {
      setError(e?.message || "Failed to save assignment.");
    } finally {
      setSaving(false);
    }
  };

  const toggle = async (a) => {
    try {
      await updateItem(uid, "assignments", a.id, { done: !a.done });
    } catch (e) {
      console.warn("Failed to update assignment:", e);
    }
  };

  const remove = async (id) => {
    try {
      await deleteItem(uid, "assignments", id);
    } catch (e) {
      console.warn("Failed to remove assignment:", e);
    }
  };

  const filtered = assignments
    .filter(a => filter === "all" ? true : filter === "pending" ? !a.done : a.done)
    .sort((a, b) => new Date(a.deadline) - new Date(b.deadline));

  return (
    <div style={S.page}>
      <div style={S.sectionHeader}>
        <h1 style={S.h1}>Assignments</h1>
        <Btn onClick={() => setModal(true)}>+ Add</Btn>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {["all","pending","done"].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            style={{ padding: "6px 14px", borderRadius: 20, border: `1.5px solid ${filter === f ? BLUE : BORDER}`,
              background: filter === f ? BLUE : WHITE, color: filter === f ? WHITE : MUTED, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {filtered.length === 0
        ? <Empty icon="✅" title="No assignments here" subtitle="Add your assignments to start tracking deadlines" action={<Btn onClick={() => setModal(true)}>Add Assignment</Btn>} />
        : filtered.map(a => {
          const d = daysUntil(a.deadline);
          return (
            <div key={a.id} style={{ ...S.listItem, opacity: a.done ? 0.65 : 1 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "flex-start", flex: 1 }}>
                <input type="checkbox" checked={a.done} onChange={() => toggle(a)}
                  style={{ marginTop: 3, accentColor: BLUE, width: 16, height: 16, cursor: "pointer" }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, textDecoration: a.done ? "line-through" : "none" }}>{a.title}</div>
                  {a.course && <div style={S.muted}>{a.course}</div>}
                  <div style={{ display: "flex", gap: 8, marginTop: 6, alignItems: "center", flexWrap: "wrap" }}>
                    <Badge variant={a.done ? "green" : d < 0 ? "red" : d <= 2 ? "orange" : "blue"}>
                      {a.done ? "Done" : d < 0 ? "Overdue" : d === 0 ? "Today" : `${d}d left`}
                    </Badge>
                    <span style={S.muted}>{fmtDate(a.deadline)}</span>
                  </div>
                  {a.notes && <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>{a.notes}</div>}
                </div>
              </div>
              <Btn variant="gray" size="sm" onClick={() => remove(a.id)}>✕</Btn>
            </div>
          );
        })
      }

      {modal && (
        <Modal title="New Assignment" onClose={() => setModal(false)}>
          <Field label="Title" value={title} onChange={setTitle} placeholder="e.g. Lab Report on Titration" required />
          <Dropdown label="Course (optional)" value={course} onChange={setCourse} options={courseOpts} />
          <Field label="Deadline" value={deadline} onChange={setDL} type="date" required />
          <Field label="Notes (optional)" value={notes} onChange={setNotes} placeholder="Additional details..." />
          {error && <div style={{ fontSize: 13, color: RED, marginBottom: 10 }}>{error}</div>}
          <Btn onClick={save} disabled={saving} style={{ width: "100%" }}>{saving ? "Saving..." : "Save Assignment"}</Btn>
        </Modal>
      )}
    </div>
  );
}

// ─── LIBRARY SYSTEM ───────────────────────────────────────────────────────────
// Public sharing now lives in a real top-level Firestore "publicNotes"
// collection (see firestore.js) so notes are actually searchable across
// different students on different devices — not just within one browser.

// Profile-based access control
function canViewNote(note, viewerProfile) {
  if (!viewerProfile) return false;
  switch (note.visibility) {
    case "public":      return true;
    case "faculty":     return viewerProfile.faculty     === note.uploaderFaculty;
    case "department":  return viewerProfile.department  === note.uploaderDepartment;
    case "level":       return viewerProfile.level       === note.uploaderLevel;
    case "coursemates": return viewerProfile.department  === note.uploaderDepartment
                            && viewerProfile.level       === note.uploaderLevel;
    default:            return false;
  }
}

// (normalizeCode is defined earlier in this file, alongside useLiveCourseCatalog —
// reused here so course-code matching is consistent across the catalog lookup
// and announcement targeting.)

// Announcements are published by the Admin Dashboard into a shared
// top-level `announcements` collection. Every signed-in student receives
// all of them via Firestore rules, and this decides which ones are
// actually relevant to THIS student based on their profile + courses.
function canViewAnnouncement(a, viewerProfile, myCourses, viewerUid) {
  if (!viewerProfile) return false;
  switch (a.audienceType) {
    case "all":        return true;
    case "student":    return a.audienceStudentUid ? a.audienceStudentUid === viewerUid
                                                    : (viewerProfile.email || "").toLowerCase().trim() === (a.audienceValue || "").toLowerCase().trim();
    case "faculty":    return viewerProfile.faculty    === a.audienceValue;
    case "department": return viewerProfile.department === a.audienceValue;
    case "deptInFaculty": return viewerProfile.faculty === a.audienceFaculty
                              && viewerProfile.department === a.audienceDepartment;
    case "level":      return viewerProfile.level      === a.audienceValue;
    case "class":      return viewerProfile.faculty === a.audienceFaculty
                              && viewerProfile.department === a.audienceDepartment
                              && viewerProfile.level === a.audienceLevel;
    case "course":     return (myCourses || []).some(c => normalizeCode(c.code) === normalizeCode(a.audienceValue));
    default:           return false;
  }
}

const VISIBILITY_OPTIONS = [
  { value: "private",     label: "🔒 Private",         desc: "Only you can see this note" },
  { value: "public",      label: "🌍 Public",           desc: "Every UHub student" },
  { value: "faculty",     label: "🏛 Faculty Only",     desc: "Students in your faculty" },
  { value: "department",  label: "🎓 Department Only",  desc: "Students in your department" },
  { value: "level",       label: "📅 Level Only",       desc: "All students in your level" },
  { value: "coursemates", label: "👥 Coursemates Only", desc: "Same department + same level" },
];

const FILE_TYPES   = ["PDF", "Image", "PPTX", "DOCX", "Other"];
const TYPE_ICON    = { PDF: "📄", PPTX: "📊", DOCX: "📝", Image: "🖼️", Other: "📎" };
const VIS_VARIANT  = { private: "orange", public: "green", faculty: "blue", department: "blue", level: "blue", coursemates: "blue" };

// ─── RESOURCE VIEWER ──────────────────────────────────────────────────────────
// Opens a document/image in a full-screen in-app viewer instead of downloading
// it. Images render natively; everything else (PDF, DOCX, PPTX, other) goes
// through Google's Docs Viewer, which can render all of those formats inline
// without needing the file to leave Cloudinary or hit the device's downloads
// folder — and works consistently across desktop and mobile browsers.
function ResourceViewer({ note, onClose }) {
  const isImage = note.type === "Image";
  const embedUrl = isImage ? note.url : `https://docs.google.com/viewer?url=${encodeURIComponent(note.url)}&embedded=true`;

  return (
    <div style={{ position: "fixed", inset: 0, background: "#0B1220", zIndex: 999, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", background: "#111827", flexShrink: 0 }}>
        <div style={{ color: WHITE, fontWeight: 700, fontSize: 14, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, marginRight: 12 }}>
          {TYPE_ICON[note.type] || "📎"} {note.title}
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexShrink: 0 }}>
          <a href={note.url} target="_blank" rel="noopener noreferrer"
            style={{ color: "#93C5FD", fontSize: 12.5, fontWeight: 600, textDecoration: "none" }}>
            Open original ↗
          </a>
          <button onClick={onClose} style={{ background: "none", border: "none", color: WHITE, fontSize: 22, cursor: "pointer", lineHeight: 1 }}>✕</button>
        </div>
      </div>
      <div style={{ flex: 1, background: isImage ? "#000" : WHITE, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
        {isImage
          ? <img src={note.url} alt={note.title} style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
          : <iframe src={embedUrl} title={note.title} style={{ width: "100%", height: "100%", border: "none" }} />
        }
      </div>
    </div>
  );
}

function Library({ uid, userData, user }) {
  const profile    = user?.profile || {};
  const courseOpts = (userData.courses || []).map(c => ({ value: c.code, label: `${c.code} – ${c.title}` }));
  const levelNames = useLiveLevels();

  // ── Tab ────────────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState("private");

  // ── Private library state (live from Firestore via userData.notes) ────────
  const myNotes = userData.notes || [];
  const [privSearch, setPrivSearch] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [editTarget, setEditTarget] = useState(null);

  // ── Upload / edit form state ───────────────────────────────────────────────
  const [fTitle, setFTitle]         = useState("");
  const [fCourse, setFCourse]       = useState("");
  const [fType, setFType]           = useState("PDF");
  const [fUrl, setFUrl]             = useState("");   // set after Cloudinary upload
  const [fDesc, setFDesc]           = useState("");
  const [fVis, setFVis]             = useState("private");
  const [fFile, setFFile]           = useState(null); // the actual File object
  const [fFileName, setFFileName]   = useState("");   // display name
  const [fProgress, setFProgress]   = useState(0);
  const [fUploading, setFUploading] = useState(false);
  const [fUploadErr, setFUploadErr] = useState("");

  // ── Public library state (live from the top-level Firestore collection) ───
  const [allPubNotes, setAllPubNotes] = useState([]);
  const [pubSearch,  setPubSearch]  = useState("");
  const [fCourseQ,   setFCourseQ]   = useState("");
  const [fDept,      setFDept]      = useState("");
  const [fLevel,     setFLevel]     = useState("");
  const [fFileType,  setFFileType]  = useState("");
  const [fUploader,  setFUploader]  = useState("");
  const [showFilter, setShowFilter] = useState(false);
  const [toast, setToast]           = useState("");
  const [viewerNote, setViewerNote] = useState(null); // note currently open in the embedded viewer

  // Subscribe to public notes in real time — any student's upload/edit/
  // unpublish anywhere shows up here live, filtered to what this viewer
  // is allowed to see based on their own profile.
  useEffect(() => {
    const unsubscribe = listenToPublicNotes((notes) => setAllPubNotes(notes));
    return unsubscribe;
  }, []);

  const pubNotes = allPubNotes.filter(n => canViewNote(n, profile));

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(""), 3000); };

  const resetForm = () => {
    setFTitle(""); setFCourse(""); setFType("PDF");
    setFUrl(""); setFDesc(""); setFVis("private");
    setFFile(null); setFFileName(""); setFProgress(0);
    setFUploading(false); setFUploadErr("");
    setEditTarget(null); setShowUpload(false);
  };

  const openEdit = (note) => {
    setFTitle(note.title); setFCourse(note.course || "");
    setFType(note.type); setFUrl(note.url);
    setFDesc(note.description || ""); setFVis(note.visibility || "private");
    // Show existing filename from URL (last segment)
    setFFileName(note.originalName || note.url?.split("/").pop() || "Existing file");
    setFFile(null); setFProgress(0); setFUploadErr("");
    setEditTarget(note); setShowUpload(true);
  };

  // Handle file selection
  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > MAX_FILE_MB * 1024 * 1024) {
      setFUploadErr(`File is too large. Maximum size is ${MAX_FILE_MB}MB.`); return;
    }
    setFUploadErr("");
    setFFile(file);
    setFFileName(file.name);
    setFType(detectFileType(file.name));
    // Auto-fill title from filename if title is empty
    if (!fTitle) setFTitle(file.name.replace(/\.[^/.]+$/, "").replace(/[-_]/g, " "));
  };

  // ── Save note (upload file first, then save note to Firestore) ─────────────
  const saveNote = async () => {
    if (!fTitle.trim()) return;
    // On new note, a file must be selected
    if (!editTarget && !fFile) { setFUploadErr("Please select a file to upload."); return; }

    let finalUrl = fUrl; // reuse existing URL on edit if no new file picked

    // If a new file was selected, upload it first
    if (fFile) {
      setFUploading(true); setFProgress(0); setFUploadErr("");
      try {
        finalUrl = await uploadToCloudinary(fFile, setFProgress);
      } catch (e) {
        setFUploadErr(e.message); setFUploading(false); return;
      }
      setFUploading(false);
    }

    const noteData = {
      title: fTitle, course: fCourse, type: fType, url: finalUrl,
      description: fDesc, visibility: fVis, originalName: fFileName,
    };
    const publicPayload = {
      ...noteData,
      uploaderUid: uid, uploaderName: profile.name,
      uploaderFaculty: profile.faculty, uploaderDepartment: profile.department, uploaderLevel: profile.level,
    };

    try {
      if (editTarget) {
        await updateItem(uid, "notes", editTarget.id, noteData);

        const wasPublic = editTarget.visibility !== "private";
        const isPublic  = fVis !== "private";

        if (wasPublic && isPublic)  await updatePublicNote(editTarget.id, publicPayload);
        if (wasPublic && !isPublic) { await deletePublicNote(editTarget.id); showToast("Note moved to private library."); }
        if (!wasPublic && isPublic) { await addPublicNote(editTarget.id, publicPayload); showToast("Note is now shared!"); }
      } else {
        const noteId = await addItem(uid, "notes", noteData);
        if (fVis !== "private") {
          await addPublicNote(noteId, publicPayload);
          showToast("Note uploaded and shared!");
        } else {
          showToast("Note saved to your private library.");
        }
      }
      resetForm();
    } catch (e) {
      setFUploadErr(e?.message || "Failed to save note. Please try again.");
    }
  };

  // ── Delete note ────────────────────────────────────────────────────────────
  const deleteNote = async (id) => {
    const note = myNotes.find(n => n.id === id);
    try {
      await deleteItem(uid, "notes", id);
      if (note?.visibility !== "private") await deletePublicNote(id);
    } catch (e) {
      console.warn("Failed to delete note:", e);
    }
  };

  // ── Open a resource in the embedded viewer and record the view ─────────────
  // Shared notes: bump the PUBLIC copy's view count — any signed-in student
  // can write that field (Firestore rules allow anyone to touch only
  // `views` on publicNotes), so this works no matter who's viewing.
  // Purely private notes: bump the note's own view count directly — only
  // the owner can ever see these, and only the owner can write to their
  // own students/{uid}/notes subcollection anyway.
  const handleView = (note, fromPrivateTab) => {
    setViewerNote(note);
    if (note.visibility && note.visibility !== "private") {
      incrementPublicNoteViews(note.id).catch(() => {});
    } else if (fromPrivateTab) {
      incrementItemViews(uid, "notes", note.id).catch(() => {});
    }
  };

  // ── Unpublish from public library (own notes only) ─────────────────────────
  const unpublish = async (noteId) => {
    try {
      await deletePublicNote(noteId);
      await updateItem(uid, "notes", noteId, { visibility: "private" });
      showToast("Note moved back to private library.");
    } catch (e) {
      console.warn("Failed to unpublish note:", e);
    }
  };

  // ── Filtered lists ─────────────────────────────────────────────────────────
  const filteredMy = myNotes.filter(n => {
    const q = privSearch.toLowerCase();
    return !q || n.title.toLowerCase().includes(q)
              || (n.course || "").toLowerCase().includes(q)
              || (n.description || "").toLowerCase().includes(q);
  });

  const filteredPub = pubNotes.filter(n => {
    const q = pubSearch.toLowerCase();
    const matchQ   = !q || n.title.toLowerCase().includes(q)
                       || (n.course || "").toLowerCase().includes(q)
                       || (n.uploaderName || "").toLowerCase().includes(q);
    const matchC   = !fCourseQ  || (n.course || "").toLowerCase().includes(fCourseQ.toLowerCase());
    const matchD   = !fDept     || n.uploaderDepartment === fDept;
    const matchL   = !fLevel    || n.uploaderLevel === fLevel;
    const matchT   = !fFileType || n.type === fFileType;
    const matchU   = !fUploader || (n.uploaderName || "").toLowerCase().includes(fUploader.toLowerCase());
    return matchQ && matchC && matchD && matchL && matchT && matchU;
  });

  const visLabel = (v) => VISIBILITY_OPTIONS.find(o => o.value === v)?.label || v;
  const activeFilters = [fCourseQ, fDept, fLevel, fFileType, fUploader].filter(Boolean).length;

  // ── Visibility info line (contextual to user profile) ─────────────────────
  const visInfo = () => {
    const o = VISIBILITY_OPTIONS.find(o => o.value === fVis);
    if (!o) return "";
    let extra = "";
    if (fVis === "coursemates") extra = ` (${profile.department || "your dept"} · ${profile.level || "your level"})`;
    else if (fVis === "department") extra = ` (${profile.department || "your department"})`;
    else if (fVis === "faculty")    extra = ` (${profile.faculty    || "your faculty"})`;
    else if (fVis === "level")      extra = ` (${profile.level      || "your level"})`;
    return o.desc + extra;
  };

  // ── Upload / Edit modal ────────────────────────────────────────────────────
  const UploadModal = (
    <Modal
      title={editTarget ? "Edit Note" : "Upload Note"}
      onClose={resetForm}
    >
      <Field label="Note Title" value={fTitle} onChange={setFTitle}
        placeholder="e.g. Week 5 – Arrays & Pointers" required />

      <Dropdown label="Course (optional)" value={fCourse} onChange={setFCourse} options={courseOpts} />

      <div style={S.row2}>
        <div style={S.formGroup}>
          <label style={S.label}>File Type</label>
          <div style={{ ...S.input, background: GRAY, color: MUTED, display: "flex", alignItems: "center", gap: 6 }}>
            {TYPE_ICON[fType] || "📎"} {fType}
          </div>
        </div>
        <div style={S.formGroup}>
          <label style={S.label}>Visibility <span style={{ color: RED }}>*</span></label>
          <select value={fVis} onChange={e => setFVis(e.target.value)} style={S.select}>
            {VISIBILITY_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Visibility info */}
      <div style={{ background: fVis === "private" ? "#FEF3C7" : BLUE_LIGHT,
        borderRadius: 8, padding: "10px 14px", marginTop: -8, marginBottom: 16,
        fontSize: 13, color: fVis === "private" ? "#92400E" : BLUE, fontWeight: 500 }}>
        {visInfo()}
      </div>

      {/* File picker */}
      <div style={S.formGroup}>
        <label style={S.label}>
          {editTarget ? "Replace File (optional)" : "Select File"} <span style={{ color: RED }}>{!editTarget && "*"}</span>
        </label>

        <label htmlFor="lib-file-input" style={{
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          gap: 8, padding: "20px 16px", border: `2px dashed ${fFile ? BLUE : BORDER}`,
          borderRadius: 10, cursor: "pointer", background: fFile ? BLUE_LIGHT : GRAY,
          transition: "all 0.2s",
        }}>
          <span style={{ fontSize: 32 }}>{fFile ? TYPE_ICON[fType] || "📎" : "📂"}</span>
          {fFileName ? (
            <>
              <span style={{ fontWeight: 700, fontSize: 13, color: TEXT, textAlign: "center", wordBreak: "break-all" }}>
                {fFileName}
              </span>
              <span style={{ fontSize: 11, color: MUTED }}>Tap to change file</span>
            </>
          ) : (
            <>
              <span style={{ fontWeight: 600, fontSize: 14, color: BLUE }}>Tap to choose a file</span>
              <span style={{ fontSize: 11, color: MUTED }}>PDF, Word, PowerPoint, or Image · Max {MAX_FILE_MB}MB</span>
            </>
          )}
        </label>
        <input
          id="lib-file-input"
          type="file"
          accept={ACCEPTED_TYPES}
          onChange={handleFileSelect}
          style={{ display: "none" }}
        />
      </div>

      {/* Upload progress bar */}
      {fUploading && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: MUTED, marginBottom: 6 }}>
            <span>Uploading to Cloudinary…</span>
            <span style={{ fontWeight: 700, color: BLUE }}>{fProgress}%</span>
          </div>
          <div style={{ background: BORDER, borderRadius: 6, height: 8, overflow: "hidden" }}>
            <div style={{ background: BLUE, height: "100%", width: `${fProgress}%`, transition: "width 0.3s", borderRadius: 6 }} />
          </div>
        </div>
      )}

      {/* Upload error */}
      {fUploadErr && (
        <div style={{ background: "#FEE2E2", color: RED, padding: "10px 14px",
          borderRadius: 8, fontSize: 13, marginBottom: 16 }}>
          {fUploadErr}
        </div>
      )}

      <Field label="Description (optional)" value={fDesc} onChange={setFDesc}
        placeholder="Briefly describe what this note covers…" />

      <Btn
        onClick={saveNote}
        disabled={fUploading || (!editTarget && !fFile) || !fTitle.trim()}
        style={{ width: "100%", opacity: (fUploading || (!editTarget && !fFile) || !fTitle.trim()) ? 0.6 : 1 }}
      >
        {fUploading
          ? `Uploading… ${fProgress}%`
          : editTarget
            ? "Save Changes"
            : fVis === "private" ? "Save to My Library" : "Upload & Share"
        }
      </Btn>
    </Modal>
  );

  // ── Private Library tab ─────────────────────────────────────────────────────
  const PrivateTab = (
    <>
      <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
        <input value={privSearch} onChange={e => setPrivSearch(e.target.value)}
          placeholder="🔍 Search your notes…"
          style={{ ...S.input, flex: 1, background: GRAY }} />
        <Btn onClick={() => { resetForm(); setShowUpload(true); }}>+ Upload</Btn>
      </div>

      {/* Summary strip */}
      {myNotes.length > 0 && (
        <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
          {["All", "PDF", "Image", "PPTX", "DOCX"].map(t => {
            const count = t === "All" ? myNotes.length : myNotes.filter(n => n.type === t).length;
            if (t !== "All" && count === 0) return null;
            return (
              <div key={t} style={{ background: GRAY, border: `1px solid ${BORDER}`, borderRadius: 8,
                padding: "6px 14px", fontSize: 12, fontWeight: 600, color: MUTED }}>
                {TYPE_ICON[t] || "📚"} {t} <span style={{ color: BLUE }}>{count}</span>
              </div>
            );
          })}
        </div>
      )}

      {filteredMy.length === 0
        ? <Empty icon="📁" title="Your private library is empty"
            subtitle="Upload your first note and choose who can see it — keep it private or share with coursemates"
            action={<Btn onClick={() => { resetForm(); setShowUpload(true); }}>Upload First Note</Btn>} />
        : filteredMy.map(n => (
          <div key={n.id} style={S.listItem}>
            <div style={{ fontSize: 28, flexShrink: 0 }}>{TYPE_ICON[n.type] || "📎"}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{n.title}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 5 }}>
                {n.course && <Badge>{n.course}</Badge>}
                <Badge variant={VIS_VARIANT[n.visibility] || "blue"}>{visLabel(n.visibility)}</Badge>
                <span style={S.muted}>{fmtDate(n.created)}</span>
              </div>
              {n.description && (
                <div style={{ fontSize: 12, color: MUTED, marginTop: 4, lineHeight: 1.4 }}>{n.description}</div>
              )}
              {(() => {
                // For shared notes, the real view count lives on the public
                // copy; for purely private notes it lives on this doc itself.
                const publicCopy = allPubNotes.find(p => p.id === n.id);
                const viewCount = n.visibility !== "private" ? (publicCopy?.views ?? 0) : (n.views || 0);
                return (viewCount > 0 || n.visibility !== "private") && (
                  <div style={{ fontSize: 11, color: BLUE, fontWeight: 600, marginTop: 5 }}>👁 {viewCount} view{viewCount !== 1 ? "s" : ""}</div>
                );
              })()}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5, flexShrink: 0 }}>
              <Btn variant="outline" size="sm" onClick={() => handleView(n, true)}>View</Btn>
              <Btn variant="gray"    size="sm" onClick={() => openEdit(n)}>Edit</Btn>
              <Btn variant="red"     size="sm" onClick={() => deleteNote(n.id)}>Delete</Btn>
            </div>
          </div>
        ))
      }
    </>
  );

  // ── Public Library tab ──────────────────────────────────────────────────────
  const PublicTab = (
    <>
      {/* Search + filter toggle */}
      <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <input value={pubSearch} onChange={e => setPubSearch(e.target.value)}
          placeholder="🔍 Search notes, courses, uploaders…"
          style={{ ...S.input, flex: 1, minWidth: 160, background: GRAY }} />
        <Btn variant="outline" onClick={() => setShowFilter(!showFilter)}>
          ⚙ Filters{activeFilters > 0 ? ` (${activeFilters})` : ""}
        </Btn>
      </div>

      {/* Filter panel */}
      {showFilter && (
        <div style={{ ...S.card, padding: 16, marginBottom: 16, background: GRAY }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: TEXT, marginBottom: 12 }}>Filter Notes</div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
            <div>
              <label style={S.label}>Course Code</label>
              <input value={fCourseQ} onChange={e => setFCourseQ(e.target.value)}
                placeholder="e.g. CSC 301" style={S.input} />
            </div>
            <div>
              <label style={S.label}>Department</label>
              <input value={fDept} onChange={e => setFDept(e.target.value)}
                placeholder="e.g. Computer Science" style={S.input} />
            </div>
            <div>
              <label style={S.label}>Level</label>
              <select value={fLevel} onChange={e => setFLevel(e.target.value)} style={S.select}>
                <option value="">All Levels</option>
                {levelNames.map(l => <option key={l}>{l}</option>)}
              </select>
            </div>
            <div>
              <label style={S.label}>File Type</label>
              <select value={fFileType} onChange={e => setFFileType(e.target.value)} style={S.select}>
                <option value="">All Types</option>
                {FILE_TYPES.map(t => <option key={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label style={S.label}>Uploader</label>
              <input value={fUploader} onChange={e => setFUploader(e.target.value)}
                placeholder="Search by name" style={S.input} />
            </div>
          </div>
          {activeFilters > 0 && (
            <Btn variant="gray" size="sm" style={{ marginTop: 12 }}
              onClick={() => { setFCourseQ(""); setFDept(""); setFLevel(""); setFFileType(""); setFUploader(""); }}>
              Clear All Filters
            </Btn>
          )}
        </div>
      )}

      {/* Access context pill */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: MUTED }}>Showing notes you can access:</span>
        <Badge variant="green">🌍 Public</Badge>
        {profile.faculty    && <Badge>🏛 {profile.faculty}</Badge>}
        {profile.department && <Badge>🎓 {profile.department}</Badge>}
        {profile.level      && <Badge>📅 {profile.level}</Badge>}
      </div>

      <div style={{ fontSize: 12, color: MUTED, marginBottom: 12 }}>
        {filteredPub.length} note{filteredPub.length !== 1 ? "s" : ""} available
      </div>

      {filteredPub.length === 0
        ? <Empty icon="🌍" title="No shared notes found"
            subtitle="Notes shared with your faculty, department, or level appear here. Upload and share to be the first!" />
        : filteredPub.map(n => (
          <div key={n.id} style={{ ...S.card, padding: 16, margin: "0 0 12px" }}>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div style={{ fontSize: 32, flexShrink: 0 }}>{TYPE_ICON[n.type] || "📎"}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>{n.title}</div>
                {n.description && (
                  <div style={{ fontSize: 13, color: MUTED, marginBottom: 8, lineHeight: 1.4 }}>{n.description}</div>
                )}
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                  {n.course && <Badge>{n.course}</Badge>}
                  <Badge variant="blue">{n.type}</Badge>
                  <Badge variant={n.visibility === "public" ? "green" : "blue"}>{visLabel(n.visibility)}</Badge>
                </div>

                {/* Uploader card */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap",
                  background: GRAY, borderRadius: 8, padding: "8px 12px" }}>
                  <div style={{ width: 28, height: 28, background: BLUE, borderRadius: "50%",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 12, color: WHITE, fontWeight: 800, flexShrink: 0 }}>
                    {n.uploaderName?.[0] || "U"}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: TEXT }}>{n.uploaderName}</div>
                    <div style={{ fontSize: 11, color: MUTED }}>
                      {n.uploaderDepartment} · {n.uploaderLevel}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: MUTED, textAlign: "right" }}>
                    <div>{fmtDate(n.sharedAt)}</div>
                    <div style={{ color: BLUE, fontWeight: 600 }}>👁 {n.views || 0} views</div>
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div style={{ display: "flex", flexDirection: "column", gap: 6, flexShrink: 0 }}>
                <Btn variant="blue" size="sm" onClick={() => handleView(n, false)}>👁 View</Btn>
                {n.uploaderUid === uid && (
                  <Btn variant="gray" size="sm" onClick={() => unpublish(n.id)}>Unpublish</Btn>
                )}
              </div>
            </div>
          </div>
        ))
      }
    </>
  );

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <div style={S.page}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={S.h1}>📚 Library</h1>
        <p style={{ ...S.muted, marginTop: 2 }}>
          {profile.department} · {profile.level}
        </p>
      </div>

      {/* Tab switcher */}
      <div style={{ display: "flex", background: GRAY, borderRadius: 10, padding: 4, marginBottom: 20 }}>
        {[
          { key: "private", icon: "📁", label: "My Library",     count: myNotes.length },
          { key: "public",  icon: "🌍", label: "Public Library", count: pubNotes.length },
        ].map(t => (
          <button key={t.key} onClick={() => setActiveTab(t.key)}
            style={{ flex: 1, padding: "10px 6px", borderRadius: 8, border: "none", cursor: "pointer",
              background: activeTab === t.key ? WHITE : "transparent",
              boxShadow: activeTab === t.key ? "0 1px 6px rgba(0,0,0,0.1)" : "none",
              transition: "all 0.2s" }}>
            <div style={{ fontWeight: 700, fontSize: 14, color: activeTab === t.key ? BLUE : MUTED }}>
              {t.icon} {t.label}
            </div>
            <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
              {t.count} note{t.count !== 1 ? "s" : ""}
            </div>
          </button>
        ))}
      </div>

      {activeTab === "private" ? PrivateTab : PublicTab}

      {showUpload && UploadModal}
      {viewerNote && <ResourceViewer note={viewerNote} onClose={() => setViewerNote(null)} />}

      {/* Toast */}
      {toast && (
        <div style={{ position: "fixed", bottom: 80, left: 16, right: 16, background: GREEN,
          color: WHITE, borderRadius: 12, padding: "14px 18px", zIndex: 300,
          display: "flex", justifyContent: "space-between", alignItems: "center",
          boxShadow: "0 4px 16px rgba(0,0,0,0.2)" }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>✅ {toast}</span>
          <button onClick={() => setToast("")}
            style={{ background: "none", border: "none", color: WHITE, fontSize: 18, cursor: "pointer" }}>✕</button>
        </div>
      )}
    </div>
  );
}

// ─── FLASHCARDS ───────────────────────────────────────────────────────────────
function Flashcards({ uid, userData }) {
  const decks = userData.flashcards || [];
  const [modal, setModal]           = useState(false);
  const [deckName, setDeckName]     = useState("");
  const [deckCourse, setDeckCourse] = useState("");
  const [activeDeckId, setActiveDeckId] = useState(null);
  const [cardModal, setCardModal]   = useState(false);
  const [front, setFront]           = useState("");
  const [back, setBack]             = useState("");
  const [quizMode, setQuizMode]     = useState(false);
  const [quizIdx, setQuizIdx]       = useState(0);
  const [flipped, setFlipped]       = useState(false);
  const courseOpts = (userData.courses || []).map(c => ({ value: c.code, label: `${c.code} - ${c.title}` }));

  // Derive the active deck from live Firestore data so it stays in sync
  // (e.g. after adding a card or sharing) without any manual re-fetching.
  const activeDeck = decks.find(d => d.id === activeDeckId) || null;

  const saveDeck = async () => {
    if (!deckName) return;
    try {
      await addItem(uid, "flashcards", { name: deckName, course: deckCourse, cards: [], public: false });
      setModal(false); setDeckName(""); setDeckCourse("");
    } catch (e) {
      console.warn("Failed to create deck:", e);
    }
  };

  const saveCard = async () => {
    if (!front || !back || !activeDeck) return;
    const updatedCards = [...activeDeck.cards, { id: genId(), front, back }];
    try {
      await updateItem(uid, "flashcards", activeDeck.id, { cards: updatedCards });
      setCardModal(false); setFront(""); setBack("");
    } catch (e) {
      console.warn("Failed to add card:", e);
    }
  };

  const removeDeck = async (id) => {
    try {
      await deleteItem(uid, "flashcards", id);
    } catch (e) {
      console.warn("Failed to remove deck:", e);
    }
  };

  const shareDeck = async (id) => {
    const deck = decks.find(d => d.id === id);
    if (!deck) return;
    try {
      await makeShareable(uid, "flashcards", id, deck);
    } catch (e) {
      console.warn("Failed to share deck:", e);
    }
  };

  // ── Quiz mode ──
  if (quizMode && activeDeck) {
    const cards = activeDeck.cards;
    if (cards.length === 0) return (
      <div style={S.page}>
        <Btn variant="outline" onClick={() => setQuizMode(false)}>← Back</Btn>
        <Empty icon="🃏" title="No cards in this deck" subtitle="Add some cards first" />
      </div>
    );
    const card = cards[quizIdx % cards.length];
    return (
      <div style={S.page}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <Btn variant="outline" onClick={() => { setQuizMode(false); setFlipped(false); setQuizIdx(0); }}>← Exit</Btn>
          <span style={S.muted}>{quizIdx + 1} / {cards.length}</span>
        </div>
        <div onClick={() => setFlipped(!flipped)}
          style={{ cursor: "pointer", background: flipped ? BLUE : WHITE, border: `2px solid ${BLUE}`,
            borderRadius: 16, padding: "48px 24px", textAlign: "center", minHeight: 200,
            display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
            transition: "all 0.3s", boxShadow: "0 4px 20px rgba(26,86,219,0.12)" }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: flipped ? "rgba(255,255,255,0.7)" : BLUE,
            marginBottom: 12, textTransform: "uppercase", letterSpacing: 1 }}>
            {flipped ? "Answer" : "Question — Tap to flip"}
          </div>
          <div style={{ fontSize: 20, fontWeight: 700, color: flipped ? WHITE : TEXT, lineHeight: 1.4 }}>
            {flipped ? card.back : card.front}
          </div>
        </div>
        <div style={{ display: "flex", gap: 12, marginTop: 20 }}>
          <Btn variant="outline" style={{ flex: 1 }} onClick={() => { setQuizIdx(Math.max(0, quizIdx - 1)); setFlipped(false); }}>← Prev</Btn>
          <Btn style={{ flex: 1 }} onClick={() => { setQuizIdx((quizIdx + 1) % cards.length); setFlipped(false); }}>Next →</Btn>
        </div>
      </div>
    );
  }

  // ── Deck detail view ──
  if (activeDeck) return (
    <div style={S.page}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20, flexWrap: "wrap" }}>
        <Btn variant="outline" onClick={() => setActiveDeckId(null)}>← Back</Btn>
        <h1 style={{ ...S.h1, margin: 0 }}>{activeDeck.name}</h1>
      </div>
      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        <Btn onClick={() => setCardModal(true)}>+ Add Card</Btn>
        {activeDeck.cards.length > 0 &&
          <Btn variant="outline" onClick={() => { setQuizMode(true); setQuizIdx(0); setFlipped(false); }}>▶ Start Quiz</Btn>}
        {activeDeck.public
          ? <Btn variant="gray" onClick={() => { const link = `${window.location.origin}/share/${activeDeck.id}`; navigator.clipboard?.writeText(link); }}>📋 Copy Link</Btn>
          : <Btn variant="gray" onClick={() => shareDeck(activeDeck.id)}>🔗 Share Deck</Btn>
        }
      </div>
      {activeDeck.cards.length === 0
        ? <Empty icon="🃏" title="No cards yet" subtitle="Add question & answer cards to this deck" />
        : activeDeck.cards.map(c => (
          <div key={c.id} style={S.listItem}>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 13, color: BLUE, marginBottom: 2 }}>Q: {c.front}</div>
              <div style={{ fontSize: 13, color: MUTED }}>A: {c.back}</div>
            </div>
          </div>
        ))
      }
      {cardModal && (
        <Modal title="Add Card" onClose={() => setCardModal(false)}>
          <Field label="Question (Front)" value={front} onChange={setFront} placeholder="What is..." required />
          <Field label="Answer (Back)" value={back} onChange={setBack} placeholder="The answer is..." required />
          <Btn onClick={saveCard} style={{ width: "100%" }}>Add Card</Btn>
        </Modal>
      )}
    </div>
  );

  // ── Deck list view ──
  return (
    <div style={S.page}>
      <div style={S.sectionHeader}>
        <h1 style={S.h1}>Flashcard Decks</h1>
        <Btn onClick={() => setModal(true)}>+ New Deck</Btn>
      </div>
      {decks.length === 0
        ? <Empty icon="🃏" title="No flashcard decks yet" subtitle="Create a deck and add cards to quiz yourself"
            action={<Btn onClick={() => setModal(true)}>Create First Deck</Btn>} />
        : <div style={S.grid2}>
          {decks.map(d => (
            <div key={d.id} style={{ ...S.card, cursor: "pointer", margin: 0 }} onClick={() => setActiveDeckId(d.id)}>
              <div style={{ fontSize: 28, marginBottom: 8 }}>🃏</div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{d.name}</div>
              {d.course && <div style={S.muted}>{d.course}</div>}
              <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
                <Badge>{d.cards.length} card{d.cards.length !== 1 ? "s" : ""}</Badge>
                {d.public && <Badge variant="green">Shared</Badge>}
              </div>
              <Btn variant="red" size="sm" style={{ marginTop: 12 }}
                onClick={e => { e.stopPropagation(); removeDeck(d.id); }}>Delete</Btn>
            </div>
          ))}
        </div>
      }
      {modal && (
        <Modal title="New Flashcard Deck" onClose={() => setModal(false)}>
          <Field label="Deck Name" value={deckName} onChange={setDeckName} placeholder="e.g. Organic Chemistry Terms" required />
          <Dropdown label="Course (optional)" value={deckCourse} onChange={setDeckCourse} options={courseOpts} />
          <Btn onClick={saveDeck} style={{ width: "100%" }}>Create Deck</Btn>
        </Modal>
      )}
    </div>
  );
}

// ─── GPA CALCULATOR ───────────────────────────────────────────────────────────
// Nigerian 5-point grading scale (UNIMAID standard)
// A = 70–100 → 5 pts | B = 60–69 → 4 pts | C = 50–59 → 3 pts
// D = 45–49  → 2 pts | E = 40–44 → 1 pt  | F = 0–39  → 0 pts
//
// Classification (CGPA):
// 4.50–5.00 → First Class Honours
// 3.50–4.49 → Second Class Upper (2:1)
// 2.40–3.49 → Second Class Lower (2:2)
// 1.50–2.39 → Third Class
// 1.00–1.49 → Pass
// 0.00–0.99 → Fail

const GRADE_SCALE = [
  { grade: "A", pts: 5, range: "70 – 100" },
  { grade: "B", pts: 4, range: "60 – 69"  },
  { grade: "C", pts: 3, range: "50 – 59"  },
  { grade: "D", pts: 2, range: "45 – 49"  },
  { grade: "E", pts: 1, range: "40 – 44"  },
  { grade: "F", pts: 0, range: "0 – 39"   },
];

function classifyGPA(v) {
  if (v >= 4.50) return { label: "First Class Honours",     color: "#065F46" };
  if (v >= 3.50) return { label: "Second Class Upper (2:1)",color: BLUE      };
  if (v >= 2.49) return { label: "Second Class Lower (2:2)",color: ORANGE    };
  if (v >= 1.50) return { label: "Third Class",             color: "#92400E" };
  if (v >= 1.00) return { label: "Pass",                    color: MUTED     };
  if (v >  0)    return { label: "Fail",                    color: RED       };
  return { label: "—", color: MUTED };
}

function GPA({ uid, userData, user }) {
  const courses = userData.courses || [];
  const records = userData.gpaRecords || [];
  const levelNames = useLiveLevels();
  const [grades, setGrades]   = useState({});
  const [level, setLevel]     = useState(user?.profile?.level || "");
  const [semester, setSem]    = useState("1st Semester");
  const [saved, setSaved]     = useState(false);
  const [showScale, setShowScale] = useState(false);

  const semCourses = courses.filter(c => c.level === level && c.semester === semester);

  // How many courses in this level+semester already have a grade entered
  const gradedCount = semCourses.filter(c => grades[c.id]).length;
  const totalUnitsRegistered = semCourses.reduce((s, c) => s + c.units, 0);
  const totalUnitsGraded     = semCourses.filter(c => grades[c.id]).reduce((s, c) => s + c.units, 0);

  // ── GPA: only uses courses that have a grade entered ──────────────────────
  const calcGPA = () => {
    let pts = 0, units = 0;
    semCourses.forEach(c => {
      const g = grades[c.id];
      if (g) { pts += gradePoints[g] * c.units; units += c.units; }
    });
    return units > 0 ? pts / units : 0;
  };

  // ── CGPA: every OTHER saved level+semester record + this one live ─────────
  // Records are matched on BOTH level and semester now — previously this
  // matched on semester name alone, so a 300L "1st Semester" record would
  // silently overwrite a 100L "1st Semester" record and CGPA never really
  // covered more than the two most recent semesters.
  const calcCGPA = (overridePts, overrideUnits) => {
    const prevRecords = records.filter(r => !(r.level === level && r.semester === semester));
    const prevPts   = prevRecords.reduce((s, r) => s + r.totalPoints, 0);
    const prevUnits = prevRecords.reduce((s, r) => s + r.totalUnits, 0);
    let curPts = overridePts ?? 0;
    let curUnits = overrideUnits ?? 0;
    if (overridePts === undefined) {
      semCourses.forEach(c => {
        const g = grades[c.id];
        if (g) { curPts += gradePoints[g] * c.units; curUnits += c.units; }
      });
    }
    return (prevUnits + curUnits) > 0 ? (prevPts + curPts) / (prevUnits + curUnits) : 0;
  };

  const saveRecord = async () => {
    if (gradedCount === 0) return;
    let tp = 0, tu = 0;
    semCourses.forEach(c => {
      const g = grades[c.id];
      if (g) { tp += gradePoints[g] * c.units; tu += c.units; }
    });
    // Pass computed tp/tu directly so CGPA isn't calculated from stale state
    const cgpa = calcCGPA(tp, tu);
    const recFields = {
      level, semester,
      gpa: calcGPA(), cgpa,
      totalPoints: tp, totalUnits: tu,
      date: new Date().toISOString(),
    };
    try {
      // One record per level+semester combo — update it if it already
      // exists, else create it. This is what lets every semester of a
      // multi-year program be tracked independently.
      const existing = records.find(r => r.level === level && r.semester === semester);
      if (existing) {
        await updateItem(uid, "gpaRecords", existing.id, recFields);
      } else {
        await addItem(uid, "gpaRecords", recFields);
      }
      setSaved(true); setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      console.warn("Failed to save GPA record:", e);
    }
  };

  const deleteRecord = async (id) => {
    try {
      await deleteItem(uid, "gpaRecords", id);
    } catch (e) {
      console.warn("Failed to delete GPA record:", e);
    }
  };

  const gpa   = calcGPA();
  const cgpa  = calcCGPA();
  const gpaC  = classifyGPA(gpa);
  const cgpaC = classifyGPA(cgpa);
  const totalSemestersCounted = records.filter(r => !(r.level === level && r.semester === semester)).length + (gradedCount > 0 ? 1 : 0);

  return (
    <div style={S.page}>
      <h1 style={{ ...S.h1, marginBottom: 4 }}>GPA & CGPA Calculator</h1>
      <p style={{ ...S.muted, marginBottom: 20 }}>5-point scale · UNIMAID grading standard</p>

      {/* Live result cards */}
      <div style={S.grid2}>
        <div style={{ ...S.card, textAlign: "center", background: BLUE_LIGHT, border: `1px solid ${BLUE}33`, margin: 0 }}>
          <div style={{ fontSize: 38, fontWeight: 900, color: BLUE, letterSpacing: -1 }}>{gpa.toFixed(2)}</div>
          <div style={{ fontWeight: 600, color: MUTED, fontSize: 13, marginTop: 2 }}>Semester GPA</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: gpaC.color, marginTop: 6 }}>{gpaC.label}</div>
          <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>{gradedCount}/{semCourses.length} courses graded</div>
        </div>
        <div style={{ ...S.card, textAlign: "center", background: "#F0FDF4", border: "1px solid #BBF7D0", margin: 0 }}>
          <div style={{ fontSize: 38, fontWeight: 900, color: GREEN, letterSpacing: -1 }}>{cgpa.toFixed(2)}</div>
          <div style={{ fontWeight: 600, color: MUTED, fontSize: 13, marginTop: 2 }}>Cumulative CGPA</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: cgpaC.color, marginTop: 6 }}>{cgpaC.label}</div>
          <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>Across {totalSemestersCounted} semester(s)</div>
        </div>
      </div>

      {/* Grade entry card */}
      <div style={{ ...S.card, marginTop: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
          <div>
            <h2 style={{ ...S.h2, margin: 0 }}>Enter Grades</h2>
            {semCourses.length > 0 &&
              <div style={{ fontSize: 12, color: MUTED, marginTop: 2 }}>
                {totalUnitsGraded}/{totalUnitsRegistered} credit units graded
              </div>
            }
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <Dropdown label="" value={level} onChange={v => { setLevel(v); setGrades({}); }} options={levelNames} />
            <Dropdown label="" value={semester} onChange={v => { setSem(v); setGrades({}); }} options={["1st Semester","2nd Semester"]} />
          </div>
        </div>

        {/* Column headers */}
        {semCourses.length > 0 && (
          <div style={{ display: "flex", gap: 12, marginBottom: 8, paddingBottom: 8, borderBottom: `1px solid ${BORDER}` }}>
            <div style={{ flex: 1, fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5 }}>Course</div>
            <div style={{ width: 80, fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "center" }}>Grade</div>
            <div style={{ width: 80, fontSize: 11, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, textAlign: "center" }}>Quality Pts</div>
          </div>
        )}

        {semCourses.length === 0
          ? <Empty icon="📊" title={`No courses in ${semester}`} subtitle="Add courses in the Courses tab first" />
          : semCourses.map(c => {
            const g = grades[c.id];
            const qp = g ? gradePoints[g] * c.units : null;
            return (
              <div key={c.id} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{c.code}</div>
                  <div style={{ fontSize: 12, color: MUTED }}>{c.title} · {c.units} unit{c.units !== 1 ? "s" : ""}</div>
                </div>
                <select
                  value={g || ""}
                  onChange={e => setGrades({ ...grades, [c.id]: e.target.value })}
                  style={{ ...S.select, width: 80, padding: "8px 10px",
                    borderColor: g ? BLUE : BORDER,
                    color: g ? TEXT : MUTED,
                    fontWeight: g ? 700 : 400 }}
                >
                  <option value="">—</option>
                  {GRADE_SCALE.map(gs => (
                    <option key={gs.grade} value={gs.grade}>
                      {gs.grade} ({gs.pts})
                    </option>
                  ))}
                </select>
                <div style={{ width: 80, textAlign: "center", fontWeight: 800, fontSize: 14,
                  color: qp !== null ? (qp >= 15 ? GREEN : qp >= 9 ? BLUE : qp >= 6 ? ORANGE : RED) : MUTED }}>
                  {qp !== null ? qp : "—"}
                </div>
              </div>
            );
          })
        }

        {/* Totals row */}
        {gradedCount > 0 && (
          <div style={{ display: "flex", gap: 12, marginTop: 12, paddingTop: 12, borderTop: `1px solid ${BORDER}` }}>
            <div style={{ flex: 1, fontWeight: 700, fontSize: 13 }}>Total</div>
            <div style={{ width: 80, textAlign: "center", fontWeight: 700, fontSize: 13, color: MUTED }}>{totalUnitsGraded} units</div>
            <div style={{ width: 80, textAlign: "center", fontWeight: 800, fontSize: 14, color: BLUE }}>
              {semCourses.filter(c => grades[c.id]).reduce((s, c) => s + gradePoints[grades[c.id]] * c.units, 0)}
            </div>
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
          <Btn onClick={saveRecord} variant={saved ? "green" : "blue"} disabled={gradedCount === 0}>
            {saved ? "✓ Saved!" : "Calculate & Save"}
          </Btn>
          <Btn variant="gray" onClick={() => setShowScale(!showScale)}>
            {showScale ? "Hide" : "📋 View"} Grade Scale
          </Btn>
        </div>

        {/* Grade scale reference */}
        {showScale && (
          <div style={{ marginTop: 16, borderRadius: 8, overflow: "hidden", border: `1px solid ${BORDER}` }}>
            <div style={{ background: BLUE, color: WHITE, padding: "8px 12px", fontSize: 12, fontWeight: 700 }}>
              UNIMAID Grade Scale (5-Point System)
            </div>
            {GRADE_SCALE.map(gs => (
              <div key={gs.grade} style={{ display: "flex", padding: "8px 12px", borderBottom: `1px solid ${BORDER}`,
                background: WHITE, fontSize: 13 }}>
                <div style={{ width: 30, fontWeight: 800, color: BLUE }}>{gs.grade}</div>
                <div style={{ width: 80, color: MUTED }}>{gs.range}</div>
                <div style={{ fontWeight: 600 }}>{gs.pts} point{gs.pts !== 1 ? "s" : ""}</div>
              </div>
            ))}
            <div style={{ padding: "8px 12px", background: GRAY, fontSize: 11, color: MUTED }}>
              First Class: 4.50–5.00 · 2:1: 3.50–4.49 · 2:2: 2.49–3.49 · Third: 1.50–2.48
            </div>
          </div>
        )}
      </div>

      {/* Academic History */}
      {records.length > 0 && (
        <div style={S.card}>
          <h2 style={S.h2}>Academic History</h2>
          {[...records]
            .sort((a, b) => {
              const la = levelNames.indexOf(a.level), lb = levelNames.indexOf(b.level);
              if (la !== lb) return la - lb;
              return a.semester.localeCompare(b.semester);
            })
            .map(r => {
            const rc = classifyGPA(r.gpa);
            return (
              <div key={r.id} style={{ ...S.listItem, marginBottom: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{r.level ? `${r.level} · ${r.semester}` : r.semester}</div>
                  <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>
                    {r.totalUnits} credit units · {r.totalPoints} quality points · Saved {fmtDate(r.date)}
                  </div>
                </div>
                <div style={{ textAlign: "right", marginRight: 8 }}>
                  <div style={{ fontWeight: 800, fontSize: 15, color: BLUE }}>GPA {r.gpa.toFixed(2)}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: rc.color }}>{rc.label}</div>
                  <div style={{ fontSize: 11, color: MUTED }}>CGPA {r.cgpa.toFixed(2)}</div>
                </div>
                <Btn variant="red" size="sm" onClick={() => deleteRecord(r.id)}>✕</Btn>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── EXAM COUNTDOWN ───────────────────────────────────────────────────────────
function ExamCountdown({ uid, userData }) {
  const exams = userData.examDates || [];
  const [modal, setModal] = useState(false);
  const [course, setCourse] = useState("");
  const [date, setDate]     = useState("");
  const [time, setTime]     = useState("");
  const [venue, setVenue]   = useState("");
  const courseOpts = (userData.courses || []).map(c => ({ value: c.code, label: `${c.code} - ${c.title}` }));

  const save = async () => {
    if (!course || !date) return;
    try {
      await addItem(uid, "examDates", { course, date, time, venue });
      setModal(false); setCourse(""); setDate(""); setTime(""); setVenue("");
    } catch (e) {
      console.warn("Failed to save exam:", e);
    }
  };

  const remove = async (id) => {
    try {
      await deleteItem(uid, "examDates", id);
    } catch (e) {
      console.warn("Failed to remove exam:", e);
    }
  };

  const sorted   = [...exams].sort((a, b) => new Date(a.date) - new Date(b.date));
  const upcoming = sorted.filter(e => daysUntil(e.date) >= 0);
  const past     = sorted.filter(e => daysUntil(e.date) < 0);

  return (
    <div style={S.page}>
      <div style={S.sectionHeader}>
        <h1 style={S.h1}>Exam Countdown</h1>
        <Btn onClick={() => setModal(true)}>+ Add Exam</Btn>
      </div>

      {exams.length === 0 && <Empty icon="⏰" title="No exams added yet" subtitle="Add your exam dates to track countdowns"
        action={<Btn onClick={() => setModal(true)}>Add First Exam</Btn>} />}

      {upcoming.length > 0 && (
        <>
          <div style={{ fontWeight: 700, fontSize: 12, color: BLUE, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>Upcoming</div>
          {upcoming.map(e => {
            const d = daysUntil(e.date);
            return (
              <div key={e.id} style={{ ...S.listItem, borderLeft: `4px solid ${d <= 3 ? RED : BLUE}` }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{e.course}</div>
                  <div style={S.muted}>{fmtDate(e.date)}{e.time ? ` · ${e.time}` : ""}</div>
                  {e.venue && <div style={{ fontSize: 12, color: MUTED }}>📍 {e.venue}</div>}
                </div>
                <div style={{ textAlign: "center", minWidth: 60 }}>
                  <div style={{ fontSize: 24, fontWeight: 900, color: d <= 3 ? RED : d <= 7 ? ORANGE : BLUE }}>{d}</div>
                  <div style={{ fontSize: 10, fontWeight: 600, color: MUTED, textTransform: "uppercase" }}>days left</div>
                </div>
                <Btn variant="red" size="sm" onClick={() => remove(e.id)}>✕</Btn>
              </div>
            );
          })}
        </>
      )}

      {past.length > 0 && (
        <>
          <div style={{ fontWeight: 700, fontSize: 12, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10, marginTop: 20 }}>Past Exams</div>
          {past.map(e => (
            <div key={e.id} style={{ ...S.listItem, opacity: 0.5 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{e.course}</div>
                <div style={S.muted}>{fmtDate(e.date)}</div>
              </div>
              <Badge variant="green">Done</Badge>
              <Btn variant="gray" size="sm" onClick={() => remove(e.id)}>✕</Btn>
            </div>
          ))}
        </>
      )}

      {modal && (
        <Modal title="Add Exam Date" onClose={() => setModal(false)}>
          <Dropdown label="Course" value={course} onChange={setCourse} options={courseOpts} />
          {courseOpts.length === 0 &&
            <Field label="Or enter course code" value={course} onChange={setCourse} placeholder="e.g. MTH 301" required />}
          <div style={S.row2}>
            <Field label="Exam Date" value={date} onChange={setDate} type="date" required />
            <Field label="Time (optional)" value={time} onChange={setTime} type="time" />
          </div>
          <Field label="Venue (optional)" value={venue} onChange={setVenue} placeholder="e.g. Main Auditorium" />
          <Btn onClick={save} style={{ width: "100%" }}>Save Exam</Btn>
        </Modal>
      )}
    </div>
  );
}

// ─── STUDY PLANNER ────────────────────────────────────────────────────────────
function StudyPlanner({ uid, userData }) {
  const plans = userData.studyPlans || [];
  const [modal, setModal]     = useState(false);
  const [task, setTask]       = useState("");
  const [course, setCourse]   = useState("");
  const [planDate, setPlanDate] = useState("");
  const [duration, setDuration] = useState("60");
  const [goal, setGoal]       = useState("");
  const [filter, setFilter]   = useState("today");
  const courseOpts = (userData.courses || []).map(c => ({ value: c.code, label: `${c.code} - ${c.title}` }));
  const today = new Date().toISOString().slice(0, 10);

  const save = async () => {
    if (!task || !planDate) return;
    try {
      await addItem(uid, "studyPlans", { task, course, date: planDate, duration: Number(duration), goal, done: false });
      setModal(false); setTask(""); setCourse(""); setPlanDate(""); setGoal("");
    } catch (e) {
      console.warn("Failed to save study session:", e);
    }
  };

  const toggle = async (p) => {
    try {
      await updateItem(uid, "studyPlans", p.id, { done: !p.done });
    } catch (e) {
      console.warn("Failed to update study session:", e);
    }
  };

  const remove = async (id) => {
    try {
      await deleteItem(uid, "studyPlans", id);
    } catch (e) {
      console.warn("Failed to remove study session:", e);
    }
  };

  const filtered = plans
    .filter(p => filter === "today" ? p.date === today : filter === "upcoming" ? p.date > today : true)
    .sort((a, b) => a.date.localeCompare(b.date));

  const todayDone  = plans.filter(p => p.date === today && p.done).length;
  const todayTotal = plans.filter(p => p.date === today).length;

  return (
    <div style={S.page}>
      <div style={S.sectionHeader}>
        <h1 style={S.h1}>Study Planner</h1>
        <Btn onClick={() => setModal(true)}>+ Add Session</Btn>
      </div>

      {todayTotal > 0 && (
        <div style={{ ...S.cardBlue, display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
          <div style={{ fontSize: 32, fontWeight: 900, color: BLUE }}>{todayDone}/{todayTotal}</div>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 700, color: TEXT }}>Today's Progress</div>
            <div style={{ ...S.muted, fontSize: 12 }}>{todayTotal - todayDone} session{todayTotal - todayDone !== 1 ? "s" : ""} remaining</div>
            <div style={{ background: "#C7D9FF", borderRadius: 8, height: 8, overflow: "hidden", marginTop: 8 }}>
              <div style={{ background: BLUE, height: "100%", width: `${todayTotal > 0 ? (todayDone / todayTotal) * 100 : 0}%`, transition: "width 0.4s" }} />
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        {["today","upcoming","all"].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            style={{ padding: "6px 14px", borderRadius: 20, border: `1.5px solid ${filter === f ? BLUE : BORDER}`,
              background: filter === f ? BLUE : WHITE, color: filter === f ? WHITE : MUTED, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {filtered.length === 0
        ? <Empty icon="📅" title="No study sessions here" subtitle="Plan your study sessions to stay on track"
            action={<Btn onClick={() => setModal(true)}>Plan a Session</Btn>} />
        : filtered.map(p => (
          <div key={p.id} style={{ ...S.listItem, opacity: p.done ? 0.6 : 1 }}>
            <input type="checkbox" checked={p.done} onChange={() => toggle(p)}
              style={{ marginTop: 3, accentColor: BLUE, width: 16, height: 16, cursor: "pointer" }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 600, fontSize: 14, textDecoration: p.done ? "line-through" : "none" }}>{p.task}</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
                {p.course && <Badge>{p.course}</Badge>}
                <span style={S.muted}>{fmtDate(p.date)} · {p.duration} min</span>
              </div>
              {p.goal && <div style={{ fontSize: 12, color: MUTED, marginTop: 4 }}>🎯 {p.goal}</div>}
            </div>
            <Btn variant="gray" size="sm" onClick={() => remove(p.id)}>✕</Btn>
          </div>
        ))
      }

      {modal && (
        <Modal title="New Study Session" onClose={() => setModal(false)}>
          <Field label="Study Task" value={task} onChange={setTask} placeholder="e.g. Review Chapter 4 — Thermodynamics" required />
          <Dropdown label="Course (optional)" value={course} onChange={setCourse} options={courseOpts} />
          <div style={S.row2}>
            <Field label="Date" value={planDate} onChange={setPlanDate} type="date" required />
            <Dropdown label="Duration (mins)" value={duration} onChange={setDuration} options={["30","60","90","120","180"]} />
          </div>
          <Field label="Daily Goal (optional)" value={goal} onChange={setGoal} placeholder="e.g. Complete all practice problems" />
          <Btn onClick={save} style={{ width: "100%" }}>Save Session</Btn>
        </Modal>
      )}
    </div>
  );
}

// ─── PROFILE ──────────────────────────────────────────────────────────────────
function Profile({ user, onLogout, onProfileUpdate }) {
  const [profile, setProfile]       = useState(user.profile || {});
  const [saving, setSaving]         = useState(false);
  const [saved, setSaved]           = useState(false);
  const [saveError, setSaveError]   = useState("");
  const [uploading, setUploading]   = useState(false);
  const [photoError, setPhotoError] = useState("");

  const { faculties, names: facultyNames } = useLiveFaculties();
  const levelNames = useLiveLevels();
  const departmentNames = useLiveDepartments(profile.faculty, faculties);

  const save = async () => {
    setSaving(true); setSaveError("");
    try {
      await updateStudentProfile(user.uid, profile);
      onProfileUpdate(profile);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e) {
      setSaveError(e?.message || "Failed to save changes. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  // Upload to Cloudinary and store just the URL — Firestore documents cap
  // out at 1MB, so a base64-encoded photo would risk breaking profile saves.
  const handlePhotoChange = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) { setPhotoError("Please select an image file"); return; }
    if (file.size > 2 * 1024 * 1024) { setPhotoError("Image must be under 2MB"); return; }
    setPhotoError(""); setUploading(true);
    try {
      const url = await uploadToCloudinary(file);
      const updated = { ...profile, photoURL: url };
      setProfile(updated);
      await updateStudentProfile(user.uid, { photoURL: url });
      onProfileUpdate(updated);
    } catch (err) {
      setPhotoError(err?.message || "Failed to upload photo.");
    } finally {
      setUploading(false);
    }
  };

  const removePhoto = async () => {
    const updated = { ...profile, photoURL: null };
    setProfile(updated);
    try {
      await updateStudentProfile(user.uid, { photoURL: null });
    } catch (err) {
      setPhotoError(err?.message || "Failed to remove photo.");
    }
    onProfileUpdate(updated);
  };

  return (
    <div style={S.page}>
      <h1 style={{ ...S.h1, marginBottom: 20 }}>My Profile</h1>

      {/* Profile card with picture */}
      <div style={{ ...S.cardBlue, textAlign: "center", marginBottom: 20 }}>
        {/* Avatar */}
        <div style={{ position: "relative", width: 88, height: 88, margin: "0 auto 12px" }}>
          {profile.photoURL
            ? <img src={profile.photoURL} alt="Profile"
                style={{ width: 88, height: 88, borderRadius: "50%", objectFit: "cover", border: `3px solid ${BLUE}` }} />
            : <div style={{ width: 88, height: 88, background: BLUE, borderRadius: "50%", display: "flex",
                alignItems: "center", justifyContent: "center", fontSize: 32, color: WHITE, fontWeight: 800 }}>
                {profile.name?.[0] || "U"}
              </div>
          }
          {/* Camera overlay button */}
          <label htmlFor="photo-upload" style={{ position: "absolute", bottom: 0, right: 0,
            width: 28, height: 28, background: WHITE, border: `2px solid ${BLUE}`, borderRadius: "50%",
            display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer",
            fontSize: 14, boxShadow: "0 2px 6px rgba(0,0,0,0.15)" }}>
            📷
          </label>
          <input id="photo-upload" type="file" accept="image/*"
            onChange={handlePhotoChange} style={{ display: "none" }} />
        </div>

        {uploading && <div style={{ fontSize: 13, color: BLUE, marginBottom: 6 }}>Uploading...</div>}
        {photoError && <div style={{ fontSize: 13, color: RED, marginBottom: 6 }}>{photoError}</div>}

        {profile.photoURL && (
          <button onClick={removePhoto}
            style={{ fontSize: 12, color: RED, background: "none", border: "none", cursor: "pointer", marginBottom: 8, textDecoration: "underline" }}>
            Remove photo
          </button>
        )}

        <div style={{ fontWeight: 800, fontSize: 18 }}>{profile.name}</div>
        <div style={S.muted}>{profile.email}</div>
        <div style={{ marginTop: 6, display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap" }}>
          <Badge>{profile.level}</Badge>
          <Badge variant="green">✓ Email Verified</Badge>
        </div>

        <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>
          Tap 📷 to change your photo · Max 2MB
        </div>
      </div>

      {/* Edit form */}
      <div style={S.card}>
        <h2 style={S.h2}>Edit Profile</h2>
        <Field label="Full Name" value={profile.name || ""} onChange={v => setProfile({ ...profile, name: v })} required />
        <Dropdown label="Faculty" value={profile.faculty || ""} onChange={v => setProfile({ ...profile, faculty: v, department: "" })} options={facultyNames} required />
        <Dropdown label="Department" value={profile.department || ""} onChange={v => setProfile({ ...profile, department: v })} options={departmentNames} required
          placeholder={profile.faculty ? "Select..." : "Choose a faculty first"} />
        <Dropdown label="Level" value={profile.level || ""} onChange={v => setProfile({ ...profile, level: v })} options={levelNames} required />
        {saveError && <div style={{ fontSize: 13, color: RED, marginBottom: 10 }}>{saveError}</div>}
        <Btn onClick={save} disabled={saving} variant={saved ? "green" : "blue"}>
          {saving ? "Saving..." : saved ? "✓ Saved!" : "Save Changes"}
        </Btn>
      </div>

      {/* Account actions */}
      <div style={{ ...S.card, marginTop: 8 }}>
        <h2 style={{ ...S.h2, color: RED }}>Account</h2>
        <Btn variant="red" onClick={onLogout}>Log Out</Btn>
      </div>

      <div style={{ textAlign: "center", padding: 20, color: MUTED, fontSize: 12 }}>
        UHub v1.0 · University of Maiduguri<br />Your Personal Academic Companion
      </div>
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
// ─── ANNOUNCEMENTS PANEL ──────────────────────────────────────────────────────
// Slide-in panel opened from the bell icon in the navbar. Important
// announcements are pinned to the top and highlighted.
function AnnouncementsPanel({ announcements, onClose }) {
  const sorted = [...announcements].sort((a, b) => {
    if (!!b.important !== !!a.important) return (b.important ? 1 : 0) - (a.important ? 1 : 0);
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", zIndex: 400, display: "flex", justifyContent: "flex-end" }}
      onClick={onClose}>
      <div style={{ background: WHITE, width: "100%", maxWidth: 420, height: "100%", overflowY: "auto", padding: 20, boxSizing: "border-box" }}
        onClick={e => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: TEXT }}>📢 Announcements</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", fontSize: 22, cursor: "pointer", color: MUTED }}>✕</button>
        </div>
        {sorted.length === 0
          ? <Empty icon="📢" title="No announcements yet" subtitle="Updates from your school will appear here as soon as they're published." />
          : sorted.map(a => (
            <div key={a.id} style={{ ...S.card, borderLeft: `4px solid ${a.important ? RED : BLUE}`, marginBottom: 12 }}>
              {a.important && <Badge variant="red">🔴 Important</Badge>}
              <div style={{ fontWeight: 700, fontSize: 14, marginTop: a.important ? 6 : 0 }}>{a.title}</div>
              <div style={{ fontSize: 13, color: MUTED, marginTop: 4, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{a.body}</div>
              <div style={{ fontSize: 11, color: MUTED, marginTop: 8 }}>{fmtDate(a.createdAt)}</div>
            </div>
          ))
        }
      </div>
    </div>
  );
}

const TABS = [
  { id: "dashboard",   label: "Home",    icon: "🏠" },
  { id: "courses",     label: "Courses", icon: "📖" },
  { id: "assignments", label: "Tasks",   icon: "✅" },
  { id: "notes",       label: "Library", icon: "📚" },
  { id: "flashcards",  label: "Cards",   icon: "🃏" },
  { id: "gpa",         label: "GPA",     icon: "📊" },
  { id: "exams",       label: "Exams",   icon: "⏰" },
  { id: "planner",     label: "Planner", icon: "📅" },
  { id: "profile",     label: "Profile", icon: "👤" },
];

export default function App() {
  const [user, setUser]           = useState(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [tab, setTab]             = useState("dashboard");
  const [userData, setUserData]   = useState({});
  const [suspended, setSuspended] = useState(false);
  const [announcements, setAnnouncements] = useState([]);
  const [showAnnouncements, setShowAnnouncements] = useState(false);

  // Subscribe to real Firebase Auth state. This replaces the old
  // localStorage session restore — Firebase keeps `user` in sync
  // automatically (login, logout, token refresh) across the whole app.
  useEffect(() => {
    const unsubscribe = watchAuthState((u) => {
      // An admin can suspend an account from the Admin Dashboard (User
      // Management). If that flag is set, sign out immediately and show a
      // blocked screen instead of letting them into the app.
      if (u?.profile?.suspended) {
        logoutStudent().finally(() => { setUser(null); setSuspended(true); setAuthLoading(false); });
        return;
      }
      setSuspended(false);
      setUser(u);
      setAuthLoading(false);
    });
    return unsubscribe;
  }, []);

  // Live Firestore listeners for every collection of student data. Any
  // add/edit/delete anywhere in the app — or on another device — flows
  // back here automatically and re-renders the active page. No more
  // manual onUpdate() refresh calls anywhere in the app.
  useEffect(() => {
    if (!user) { setUserData({}); return; }
    const collections = ["courses", "assignments", "notes", "flashcards", "gpaRecords", "examDates", "studyPlans"];
    const unsubscribers = collections.map(col =>
      listenToCollection(user.uid, col, (items) => {
        setUserData(prev => ({ ...prev, [col]: items }));
      })
    );
    return () => unsubscribers.forEach(unsub => unsub());
  }, [user?.uid]);

  // Announcements published by the Admin Dashboard — live for every
  // signed-in student, filtered client-side to what's relevant to them.
  // Errors are logged (not silently swallowed) so a rules/permission issue
  // is visible in the console instead of just looking like "nothing synced".
  useEffect(() => {
    if (!user) { setAnnouncements([]); return; }
    const unsubscribe = listenToAnnouncements(
      setAnnouncements,
      (err) => console.error("[UHub] Announcements failed to load:", err)
    );
    return unsubscribe;
  }, [user?.uid]);

  const handleAuth          = (u) => setUser(u);
  const handleVerified      = (u) => setUser(u);
  const handleProfileUpdate = (updatedProfile) => {
    setUser(prev => prev ? { ...prev, profile: updatedProfile } : prev);
  };
  const handleLogout = async () => {
    try { await logoutStudent(); } finally { setUser(null); setTab("dashboard"); }
  };

  if (suspended) {
    return (
      <div style={S.authWrap}>
        <div style={S.authCard}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 40, marginBottom: 10 }}>🚫</div>
            <div style={{ fontSize: 18, fontWeight: 800, color: TEXT }}>Account Suspended</div>
            <div style={{ fontSize: 13.5, color: MUTED, marginTop: 8, lineHeight: 1.6 }}>
              Your UHub account has been suspended. If you believe this is a mistake, please
              contact your school administrator.
            </div>
            <Btn onClick={() => setSuspended(false)} style={{ marginTop: 20 }}>Back to Log In</Btn>
          </div>
        </div>
      </div>
    );
  }

  // Wait for Firebase to report the initial auth state before deciding what
  // to render — avoids a flash of the login screen for already-signed-in students.
  if (authLoading) {
    return (
      <div style={S.authWrap}>
        <div style={{ textAlign: "center", color: MUTED }}>
          <div style={{ fontSize: 36, marginBottom: 8 }}>🎓</div>
          Loading UHub...
        </div>
      </div>
    );
  }

  if (!user) return <AuthScreen onAuth={handleAuth} />;

  // Show verification screen if email not yet verified
  if (!user.emailVerified) return <EmailVerification user={user} onVerified={handleVerified} />;

  // Registration only collects Name/Email/Password — Faculty, Department,
  // and Level are required here, on first login, sourced live from
  // whatever the admin has set up in Firestore.
  if (!user.profile?.faculty || !user.profile?.department || !user.profile?.level) {
    return <CompleteProfile user={user} onComplete={handleProfileUpdate} />;
  }

  const visibleAnnouncements = announcements.filter(a => canViewAnnouncement(a, user.profile, userData.courses, user.uid));

  const pages = {
    dashboard:   <Dashboard   user={user}  userData={userData} announcements={visibleAnnouncements} onOpenAnnouncements={() => setShowAnnouncements(true)} />,
    courses:     <Courses     uid={user.uid} userData={userData} user={user} />,
    assignments: <Assignments uid={user.uid} userData={userData} />,
    notes:       <Library     uid={user.uid} userData={userData} user={user} />,
    flashcards:  <Flashcards  uid={user.uid} userData={userData} />,
    gpa:         <GPA         uid={user.uid} userData={userData} user={user} />,
    exams:       <ExamCountdown uid={user.uid} userData={userData} />,
    planner:     <StudyPlanner  uid={user.uid} userData={userData} />,
    profile:     <Profile user={user} onLogout={handleLogout} onProfileUpdate={handleProfileUpdate} />,
  };

  return (
    <div style={S.app}>
      {/* Blue Top Navbar */}
      <nav style={S.nav}>
        <div style={S.navBrand}>
          <span>🎓</span> UHub
        </div>
        <div style={S.navRight}>
          <span style={{ fontSize: 13, opacity: 0.85 }}>{user.profile?.name?.split(" ")[0]}</span>
          <div onClick={() => setShowAnnouncements(true)} style={{ position: "relative", cursor: "pointer", fontSize: 20 }}>
            🔔
            {visibleAnnouncements.some(a => a.important) && (
              <span style={{ position: "absolute", top: -2, right: -2, width: 9, height: 9, borderRadius: "50%", background: "#EF4444", border: `2px solid ${BLUE}` }} />
            )}
          </div>
          <div onClick={() => setTab("profile")}
            style={{ width: 36, height: 36, borderRadius: "50%", cursor: "pointer",
              border: "2px solid rgba(255,255,255,0.5)", overflow: "hidden",
              display: "flex", alignItems: "center", justifyContent: "center",
              background: "rgba(255,255,255,0.2)", fontWeight: 800, color: WHITE, fontSize: 16 }}>
            {user.profile?.photoURL
              ? <img src={user.profile.photoURL} alt="avatar"
                  style={{ width: "100%", height: "100%", objectFit: "cover" }} />
              : (user.profile?.name?.[0] || "U")
            }
          </div>
        </div>
      </nav>

      {/* Page content — padded above bottom nav */}
      <div style={{ paddingBottom: 80 }}>
        {pages[tab]}
      </div>

      {/* Mobile bottom nav */}
      <nav style={S.bottomNav}>
        {TABS.map(t => (
          <div key={t.id} onClick={() => setTab(t.id)}
            style={{ ...S.bottomNavItem, color: tab === t.id ? BLUE : MUTED }}>
            <span style={{ fontSize: 18 }}>{t.icon}</span>
            <span style={{ ...S.bottomNavLabel, color: tab === t.id ? BLUE : MUTED }}>{t.label}</span>
          </div>
        ))}
      </nav>

      {showAnnouncements && (
        <AnnouncementsPanel announcements={visibleAnnouncements} onClose={() => setShowAnnouncements(false)} />
      )}

      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; }
        input:focus, select:focus { outline: 2px solid ${BLUE}40; border-color: ${BLUE} !important; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: #f1f5f9; }
        ::-webkit-scrollbar-thumb { background: ${BLUE}60; border-radius: 4px; }
      `}</style>
    </div>
  );
}
