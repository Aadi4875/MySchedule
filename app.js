/* MySchedule v136 - Add Team Member stack overflow fix */

const APP_KEY = "myschedule_v9_complete_stable";
const FIREBASE_CONFIG_KEY = "myschedule_v18_firebase_config";
const FIREBASE_DOC_PATH = "myschedule_public_launch";

// Built-in Firebase config for this project.
// This is safe to include in frontend Firebase apps; Firestore security rules protect the data.
const BUILT_IN_FIREBASE_CONFIG = {
  apiKey: "AIzaSyDUntvUpL0o8I74-DKBmMOxFOT9L-nkPxw",
  authDomain: "myschedule-8f213.firebaseapp.com",
  projectId: "myschedule-8f213",
  storageBucket: "myschedule-8f213.firebasestorage.app",
  messagingSenderId: "806776296910",
  appId: "1:806776296910:web:ec2f0761d7369de5bcc79f",
  measurementId: "G-QRV9T31SRE"
};
let firebaseDb = null;
let firebaseAuth = null;
let firebaseReady = false;
let firebaseLiveUnsubscribe = null;
let authUnsubscribe = null;
let lastCloudUpdatedAt = null;
let isApplyingCloudState = false;
let cloudRevision = 0;
let firebaseAuthInitialised = false;
let cloudSaveRunning = false;
let pendingCloudSnapshot = null;
let pendingCloudResolvers = [];
let cloudSaveRetryTimer = null;
const CURRENT_KEY = "myschedule_v15_current_user_session";
const LEGACY_CURRENT_KEY = "myschedule_v9_current_user";

const EMAILJS_DEFAULTS = {
  provider: "brevo_worker",
  enabled: true,
  workerUrl: "https://myschedule-email.adityapatelap591.workers.dev",
  fromName: "MySchedule Notification",
  replyTo: "",
  appUrl: "",
  mode: "brevo",
  pausedByOwner: false
};

let state = null;
let currentUserId = getStoredCurrentUserId();
let currentView = "dashboard";
let rosterWeekStart = getMonday(new Date());
let copiedWeekBuffer = null;
const INACTIVITY_LIMIT_MS = 15 * 60 * 1000;
let lastActivityAt = Date.now();
let inactivityTimer = null;

function getFirebaseConfig(){
  try{
    const raw = localStorage.getItem(FIREBASE_CONFIG_KEY);
    // If user manually saved a config, use it. Otherwise use the built-in config automatically.
    return raw ? JSON.parse(raw) : BUILT_IN_FIREBASE_CONFIG;
  }catch(e){
    return BUILT_IN_FIREBASE_CONFIG;
  }
}

function isValidFirebaseConfig(cfg){
  return !!(cfg && cfg.apiKey && cfg.projectId && cfg.appId);
}

function saveFirebaseConfigFromUI(){
  const raw = el("firebase-config") ? el("firebase-config").value.trim() : "";
  if(!raw) return toast("Paste your Firebase config first.");
  try{
    // Accept either pure JSON or the copied Firebase code containing: const firebaseConfig = {...};
    let jsonText = raw;
    const m = raw.match(/firebaseConfig\s*=\s*(\{[\s\S]*?\})\s*;?/);
    if(m) jsonText = m[1];
    // Convert common JS object format into JSON safely enough for Firebase config values.
    jsonText = jsonText
      .replace(/([,{]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":')
      .replace(/'/g, '"');
    const cfg = JSON.parse(jsonText);
    if(!isValidFirebaseConfig(cfg)) return toast("Firebase config missing apiKey, projectId or appId.");
    localStorage.setItem(FIREBASE_CONFIG_KEY, JSON.stringify(cfg));
    toast("Firebase cloud database connected. Refreshing...");
    setTimeout(()=>location.reload(), 600);
  }catch(e){
    console.error(e);
    toast("Could not read Firebase config. Paste the full config object from Firebase Web App settings.");
  }
}

function clearFirebaseConfig(){
  if(!confirm("Remove Firebase cloud connection from this browser?")) return;
  localStorage.removeItem(FIREBASE_CONFIG_KEY);
  firebaseDb = null;
  firebaseReady = false;
  toast("Manual Firebase config removed. Built-in Firebase connection will be used.");
  setTimeout(()=>location.reload(), 600);
}

function initFirebase(){
  if(firebaseReady && firebaseDb) return true;
  const cfg = getFirebaseConfig();
  if(!isValidFirebaseConfig(cfg)) return false;
  try{
    if(typeof firebase === "undefined") return false;
    if(!firebase.apps.length) firebase.initializeApp(cfg);
    firebaseDb = firebase.firestore();
    firebaseAuth = firebase.auth ? firebase.auth() : null;
    // Use session persistence instead of browser-wide local persistence.
    // This reduces the chance that Owner login is reused automatically in every new browser tab.
    if(firebaseAuth && firebase.auth.Auth && firebase.auth.Auth.Persistence){
      firebaseAuth.setPersistence(firebase.auth.Auth.Persistence.SESSION).catch(console.warn);
    }
    firebaseReady = true;
    return true;
  }catch(e){
    console.warn("Firebase init failed", e);
    return false;
  }
}

async function waitForFirebaseAuthInitialState(){
  if(!initFirebase() || !firebaseAuth) return null;
  if(firebaseAuthInitialised) return firebaseAuth.currentUser;
  return new Promise(resolve => {
    const stop = firebaseAuth.onAuthStateChanged(user => {
      firebaseAuthInitialised = true;
      try{ stop(); }catch(e){}
      resolve(user || null);
    }, () => resolve(null));
  });
}

async function loadFirebaseState(){
  if(!initFirebase() || !firebaseAuth) return null;
  let user = firebaseAuth.currentUser || await waitForFirebaseAuthInitialState();
  if(!user) return null;

  const ref = firebaseDb.collection("apps").doc(FIREBASE_DOC_PATH);
  let lastError = null;
  for(let attempt = 0; attempt < 4; attempt++){
    try{
      // Refresh the ID token on the first retry so recently changed rules and sessions
      // are evaluated with a current authenticated token.
      if(attempt === 1 && user.getIdToken) await user.getIdToken(true);
      const snap = await ref.get({ source: attempt < 2 ? "server" : "default" });
      if(snap.exists && snap.data() && snap.data().state){
        cloudRevision = Number(snap.data().revision || 0);
        lastCloudUpdatedAt = snap.data().updatedAt || null;
        return snap.data().state;
      }
      const fresh = defaultState();
      const updatedAt = new Date().toISOString();
      await ref.set({state:fresh, updatedAt, updatedBy:user.uid, revision:1});
      cloudRevision = 1;
      lastCloudUpdatedAt = updatedAt;
      return fresh;
    }catch(e){
      lastError = e;
      await new Promise(r => setTimeout(r, 350 * (attempt + 1)));
    }
  }
  console.warn("Firebase read failed after retries", lastError);
  return null;
}

async function writeFirebaseSnapshot(snapshot){
  if(!snapshot || !initFirebase() || !firebaseAuth || !firebaseAuth.currentUser) return false;
  const ref = firebaseDb.collection("apps").doc(FIREBASE_DOC_PATH);
  let lastError = null;
  for(let attempt = 0; attempt < 5; attempt++){
    try{
      const updatedAt = new Date().toISOString();
      let committedRevision = 0;
      await firebaseDb.runTransaction(async tx => {
        const snap = await tx.get(ref);
        const remoteRevision = snap.exists ? Number(snap.data().revision || 0) : 0;
        committedRevision = remoteRevision + 1;
        tx.set(ref, {
          state: snapshot,
          updatedAt,
          updatedBy: firebaseAuth.currentUser.uid,
          revision: committedRevision
        });
      });
      cloudRevision = committedRevision;
      lastCloudUpdatedAt = updatedAt;
      return true;
    }catch(e){
      lastError = e;
      await new Promise(r => setTimeout(r, 180 * (attempt + 1)));
    }
  }
  console.warn("Firebase save retry exhausted", lastError);
  return false;
}

async function flushCloudSaveQueue(){
  if(cloudSaveRunning) return;
  cloudSaveRunning = true;
  clearTimeout(cloudSaveRetryTimer);
  try{
    while(pendingCloudSnapshot){
      const snapshot = pendingCloudSnapshot;
      pendingCloudSnapshot = null;
      const ok = await writeFirebaseSnapshot(snapshot);
      if(!ok){
        // Keep the newest unsaved state queued and retry automatically.
        pendingCloudSnapshot = pendingCloudSnapshot || snapshot;
        cloudSaveRetryTimer = setTimeout(() => flushCloudSaveQueue(), 2500);
        break;
      }
      const resolvers = pendingCloudResolvers.splice(0);
      resolvers.forEach(r => r(true));
    }
  }finally{
    cloudSaveRunning = false;
  }
}

function queueFirebaseSave(snapshot){
  pendingCloudSnapshot = JSON.parse(JSON.stringify(snapshot));
  const promise = new Promise(resolve => pendingCloudResolvers.push(resolve));
  flushCloudSaveQueue();
  return promise;
}

async function saveFirebaseState(snapshotOverride){
  if(!state || !initFirebase() || !firebaseAuth || !firebaseAuth.currentUser) return false;
  const snapshot = snapshotOverride || state;
  return queueFirebaseSave(snapshot);
}

function startFirebaseLiveUpdates(){
  if(!initFirebase() || !firebaseDb || firebaseLiveUnsubscribe) return;
  firebaseLiveUnsubscribe = firebaseDb.collection("apps").doc(FIREBASE_DOC_PATH).onSnapshot(snap => {
    if(!snap.exists || !snap.data() || !snap.data().state) return;
    const cloudUpdatedAt = snap.data().updatedAt || "";
    const remoteRevision = Number(snap.data().revision || 0);
    if(lastCloudUpdatedAt && cloudUpdatedAt && cloudUpdatedAt === lastCloudUpdatedAt) return;
    if(cloudSaveRunning || pendingCloudSnapshot) return;
    if(remoteRevision <= cloudRevision) return;
    cloudRevision = remoteRevision;
    isApplyingCloudState = true;
    state = migrateState(snap.data().state);
    lastCloudUpdatedAt = cloudUpdatedAt;
    enforceSessionSecurity(false);
    const user = currentUser();
    if(user){
      render();
      // Quiet sync: live update received without interrupting the user.
    }
    isApplyingCloudState = false;
  }, err => {
    console.warn("Live Firestore listener paused", err);
    setTimeout(() => {
      try{ if(firebaseLiveUnsubscribe) firebaseLiveUnsubscribe(); }catch(_e){}
      firebaseLiveUnsubscribe = null;
      startFirebaseLiveUpdates();
    }, 2500);
  });
}

function startAuthGuard(){
  if(!initFirebase() || !firebaseAuth || authUnsubscribe) return;
  authUnsubscribe = firebaseAuth.onAuthStateChanged(async authUser => {
    await enforceSessionSecurity(true, authUser);
  });
}

async function enforceSessionSecurity(shouldRender=true, authUserOverride){
  if(!state) return false;
  initFirebase();
  const authUser = authUserOverride !== undefined ? authUserOverride : (firebaseAuth ? firebaseAuth.currentUser : null);
  const localUser = currentUser();
  // If there is a local app session but Firebase auth is missing or belongs to another user, close it.
  if(localUser){
    if(!authUser || localUser.authUid !== authUser.uid || normalizeEmail(localUser.email) !== normalizeEmail(authUser.email)){
      clearCurrentSession();
      currentView = "dashboard";
      if(shouldRender) render();
      if(authUser) toast("Session switched. Please sign in again for this workspace user.");
      return false;
    }
    return true;
  }
  // Do NOT automatically open the Owner dashboard just because Firebase remembered an auth user.
  // The person must explicitly sign in in this tab/window. This avoids accidental owner access from employee links.
  if(shouldRender) render();
  return false;
}

function cloudStatusBadge(){
  const cfg = getFirebaseConfig();
  if(isValidFirebaseConfig(cfg)) return `<span class="badge good">Secure cloud connected</span>`;
  return `<span class="badge good">Secure cloud connected</span>`;
}

function defaultState(){
  return {
    emailConfig: {...EMAILJS_DEFAULTS},
    businesses: [],
    users: [],
    employees: [],
    availability: [],
    shifts: [],
    requests: [],
    timesheets: [],
    notifications: [],
    notificationHistory: []
  };
}
function browserNavigationType(){
  try{
    const nav = performance.getEntriesByType && performance.getEntriesByType("navigation")[0];
    return nav && nav.type ? nav.type : "navigate";
  }catch(e){
    return "navigate";
  }
}
function getStoredCurrentUserId(){
  // v105: preserve the signed-in user for the lifetime of this browser tab.
  // Internal navigation, mobile browser restoration and GitHub Pages reloads must not
  // erase the workspace session. sessionStorage remains tab-scoped, so a new tab does
  // not inherit another tab's signed-in user.
  try{
    return sessionStorage.getItem(CURRENT_KEY) || null;
  }catch(e){
    return null;
  }
}
function setCurrentSession(userId){
  currentUserId = userId;
  markActivity();
  try{ sessionStorage.setItem(CURRENT_KEY, userId); }catch(e){}
  // Remove old single-login key so one tab does not overwrite another tab.
  localStorage.removeItem(LEGACY_CURRENT_KEY);
}
function clearCurrentSession(){
  currentUserId = null;
  try{ sessionStorage.removeItem(CURRENT_KEY); }catch(e){}
  localStorage.removeItem(LEGACY_CURRENT_KEY);
}

function migrateState(data){
  data.emailConfig = {...EMAILJS_DEFAULTS, ...(data.emailConfig || {})};
  // Legacy migration retained for older saved data; v126 enables Brevo immediately afterward.
  if(!data.emailConfig._emailPauseMigrationV33){
    data.emailConfig.enabled = false;
    data.emailConfig.mode = "demo";
    data.emailConfig.pausedByOwner = true;
    data.emailConfig._emailPauseMigrationV33 = true;
  }
  if(!data.emailConfig.replyTo) data.emailConfig.replyTo = EMAILJS_DEFAULTS.replyTo;
  if(!data.emailConfig.fromName || data.emailConfig.fromName === "My Schedule") data.emailConfig.fromName = EMAILJS_DEFAULTS.fromName;
  // v126 one-time migration: move every existing business to the shared Brevo Worker.
  if(!data.emailConfig._brevoMigrationV126){
    data.emailConfig.provider = "brevo_worker";
    data.emailConfig.workerUrl = EMAILJS_DEFAULTS.workerUrl;
    data.emailConfig.enabled = true;
    data.emailConfig.mode = "brevo";
    data.emailConfig.pausedByOwner = false;
    data.emailConfig._brevoMigrationV126 = true;
  }
  if(!data.emailConfig.workerUrl) data.emailConfig.workerUrl = EMAILJS_DEFAULTS.workerUrl;
  if(!Array.isArray(data.businesses)) data.businesses = [];
  data.businesses.forEach(b => {
    if(!b.businessCode) b.businessCode = generateBusinessCode(b.name || "Business");
    if(!b.storeCode) b.storeCode = generateStoreCode(b.name || "Store");
  });
  if(!Array.isArray(data.users)) data.users = [];
  if(!Array.isArray(data.employees)) data.employees = [];
  if(!Array.isArray(data.shifts)) data.shifts = [];
  if(!Array.isArray(data.notifications)) data.notifications = [];
  if(!Array.isArray(data.notificationHistory)) data.notificationHistory = [];
  if(!Array.isArray(data.requests)) data.requests = [];
  if(!Array.isArray(data.timesheets)) data.timesheets = [];
  if(!Array.isArray(data.availability)) data.availability = [];
  if(Array.isArray(data.availability)){
    data.availability.forEach(a => {
      if(!a.status) a.status = "approved";
      if(!a.requestAction) a.requestAction = "add";
      if(!a.createdAt) a.createdAt = now();
      if(!a.reason) a.reason = a.notes || "Unavailable";
      if(a.date && !a.day) a.day = fullDayName(dateObj(a.date));
    });
  }
  if(Array.isArray(data.requests)){
    data.requests.forEach(r => { if(!r.createdAt) r.createdAt = now(); if(!Array.isArray(r.seenBy)) r.seenBy = []; });
  }
  if(Array.isArray(data.users)){
    data.users.forEach(u => {
      u.email = normalizeEmail(u.email);
      delete u.password;
      if(!u.status) u.status = "active";
      if(u.status === "active" && !u.emailVerified) u.emailVerified = false;
    });
  }
  return data;
}

async function loadState(){
  let data = null;

  // True free cloud mode: Firebase Spark Firestore. Works from GitHub Pages/static hosting.
  data = await loadFirebaseState();

  // Optional old Node server fallback for local testing only.
  if(!data){
    try{
      const res = await fetch("/api/state", {cache:"no-store"});
      if(res.ok){
        const payload = await res.json();
        if(payload && payload.state) data = payload.state;
      }
    }catch(e){
      console.warn("Node server database not available; using browser backup only.", e);
    }
  }

  if(!data){
    data = defaultState();
    localStorage.removeItem(LEGACY_CURRENT_KEY);
  }

  data = migrateState(data);
  return data;
}

let saveTimer = null;
function saveState(){
  if(!state || isApplyingCloudState) return Promise.resolve(false);
  const snapshot = JSON.parse(JSON.stringify(state));
  clearTimeout(saveTimer);
  return new Promise(resolve => {
    saveTimer = setTimeout(async () => {
      const ok = await saveFirebaseState(snapshot);
      resolve(ok);
    }, 120);
  });
}



function markActivity(){
  lastActivityAt = Date.now();
}
function startInactivityGuard(){
  if(inactivityTimer) return;
  ["click","keydown","mousemove","touchstart","scroll"].forEach(evt => {
    window.addEventListener(evt, markActivity, {passive:true});
  });
  inactivityTimer = setInterval(() => {
    if(!currentUser()) return;
    if(Date.now() - lastActivityAt >= INACTIVITY_LIMIT_MS){
      forceLogoutForSecurity("Signed out for security after inactivity.");
    }
  }, 30000);
}
async function forceLogoutForSecurity(message){
  try{ if(firebaseAuth) await firebaseAuth.signOut(); }catch(e){}
  clearCurrentSession();
  currentView = "dashboard";
  updateTopbarAuthVisibility(null);
  render();
  if(message) toast(message);
}

/* Render shell */
function updateTopbarAuthVisibility(user){
  const logoutBtn = el("logoutBtn");
  const inboxBtn = el("topInboxBtn");
  const inboxCount = el("topInboxCount");
  const profileMenu = el("profileMenu");
  const topProfileName = el("topProfileName");
  const topProfileAvatar = el("topProfileAvatar");
  const hasUser = !!user;
  document.body.classList.toggle("logged-out", !hasUser);
  document.body.classList.toggle("logged-in", hasUser);
  if(logoutBtn){
    // v54: logout lives inside the profile menu; keep legacy button hidden as a safe fallback only.
    logoutBtn.classList.add("hidden");
    logoutBtn.setAttribute("aria-hidden", "true");
    logoutBtn.tabIndex = -1;
  }
  if(profileMenu){
    profileMenu.classList.toggle("hidden", !hasUser);
    profileMenu.setAttribute("aria-hidden", hasUser ? "false" : "true");
    if(!hasUser) profileMenu.removeAttribute("open");
  }
  if(topProfileName && hasUser) topProfileName.textContent = user.name || "Profile";
  if(topProfileAvatar && hasUser){
    const initials = (user.name || user.email || "MS").trim().split(/\s+/).slice(0,2).map(x=>x[0]||"").join("").toUpperCase() || "MS";
    topProfileAvatar.textContent = initials;
  }
  if(inboxBtn){
    inboxBtn.classList.toggle("hidden", !hasUser);
    inboxBtn.setAttribute("aria-hidden", hasUser ? "false" : "true");
    inboxBtn.tabIndex = hasUser ? 0 : -1;
  }
  if(inboxCount){
    const count = hasUser ? actionNeededCount(user) : 0;
    inboxCount.textContent = count > 99 ? "99+" : String(count);
    inboxCount.classList.toggle("hidden", !count);
    if(inboxBtn) inboxBtn.classList.toggle("has-unread", !!count);
  }
}

function render(){
  const app = el("app");
  const user = currentUser();
  updateTopbarAuthVisibility(user);
  if(!user){
    app.innerHTML = loginView();
    setTimeout(initLandingPageUX, 0);
    return;
  }
  app.innerHTML = shellView(user);
  renderContent();
}


function goHomeLogo(){
  const user = currentUser();
  if(!user){
    currentView = "dashboard";
    render();
    return;
  }
  go(isManagerial(user) ? "dashboard" : "myshifts");
}

function closeProfileMenu(){
  const menu = el("profileMenu");
  if(menu) menu.removeAttribute("open");
}

function loginView(){
  return `
  <section class="landing-page">
    <header class="landing-nav">
      <button class="landing-logo" onclick="setAuthMode('login')" aria-label="MySchedule home">
        <span class="logo">MS</span>
        <span>MySchedule</span>
      </button>
      <div class="landing-navlinks">
        <a href="#features" data-section="features">Features</a>
        <a href="#how-it-works" data-section="how-it-works">How it works</a>
        <a href="#free-launch" data-section="free-launch">Free launch</a>
      </div>
      <button class="primary landing-login-jump" onclick="openLandingAuth('login')">Sign in</button>
    </header>

    <main class="landing-hero">
      <section class="landing-copy">
        <div class="eyebrow">Free scheduling app for hourly teams</div>
        <h1>Schedule. Notify. Track hours. All from one easy workspace.</h1>
        <p class="hero-subtitle">MySchedule helps small businesses build weekly rosters, publish shifts, keep employees updated, and print clean schedule reports without spreadsheets.</p>
        <div class="hero-actions">
          <button class="primary hero-cta" onclick="openLandingAuth('signup')">Get started free</button>
          <button class="ghost hero-secondary" onclick="openLandingAuth('login')">I already have an account</button>
        </div>
        <div class="trust-row landing-trust-compact">
          <span>✓ Free launch access</span>
          <span>✓ Works on phone and desktop</span>
          <span>✓ Manager + employee views</span>
        </div>
        <div id="features" class="feature-strip landing-feature-grid">
          <div><strong>Roster builder</strong><span>Create shifts, sort by time, copy/paste, drag, publish, and check alerts before sending.</span></div>
          <div><strong>Time clock & breaks</strong><span>Clock in/out, record breaks, catch missing breaks, and send records for manager review.</span></div>
          <div><strong>Employee self-service</strong><span>Staff see published shifts, request changes, swap shifts, and update availability from their phone.</span></div>
          <div><strong>Manager insights</strong><span>See weekly/monthly roster hours, worked hours, break issues, requests, and publishing status in one place.</span></div>
        </div>
      </section>

      <aside class="auth-panel card landing-auth-card">
        <div class="auth-panel-head">
          <h2 id="auth-title">Welcome back</h2>
          <p id="auth-subtitle" class="muted">Sign in with your work email.</p>
        </div>

        <div class="auth-switch">
          <button id="login-tab" class="active" onclick="setAuthMode('login')">Sign in</button>
          <button id="signup-tab" onclick="setAuthMode('signup')">Create account</button>
        </div>

        <div id="login-box">
          <label>Email address</label><input id="login-email" autocomplete="email" placeholder="you@business.com">
          <label>Password</label><input id="login-password" type="password" autocomplete="current-password" placeholder="Enter password">
          <button class="primary full auth-continue" onclick="login()">Sign in</button>
          <div class="auth-links clean-links">
            <button class="linkbtn" onclick="setAuthMode('reset')">Forgot password?</button>
            <button class="linkbtn" onclick="resendVerificationFromLogin()">Resend verification</button>
          </div>
        </div>

        <div id="signup-box" class="hidden">
          <label>I want to</label>
          <select id="signup-type" onchange="updateSignupFields()">
            <option value="create-business">Create a business workspace</option>
            <option value="join-team">Join my workplace</option>
          </select>

          <div id="signup-business-fields">
            <label>Business name</label><div class="business-autocomplete"><input id="signup-business-name" autocomplete="organization" oninput="businessNameInputChanged()" onfocus="updateBusinessNameSuggestions()" onblur="setTimeout(closeBusinessSuggestionList,180)" placeholder="Type your business name"><div id="business-suggestion-list" class="business-suggestion-list hidden" role="listbox" aria-label="Business suggestions"></div></div>
            <div class="form-grid auth-mini-grid">
              <div><label>Industry</label><select id="signup-industry" onchange="onIndustrySelectChange()"><option>Café</option><option>Restaurant</option><option>Retail</option><option>Grocery</option><option>Fast food</option><option>Cleaning</option><option>Hospitality</option><option>Healthcare</option><option>Other</option></select><input id="signup-industry-other" class="hidden" placeholder="Enter industry type (optional)"></div>
              <div><label>Your role</label><select id="signup-role"><option value="owner">Owner</option><option value="manager">Manager</option></select></div>
            </div>
          </div>

          <label>Full name</label><input id="signup-name" autocomplete="name" placeholder="Your full name">
          <label>Work email</label><input id="signup-email" autocomplete="email" placeholder="you@business.com">
          <label>Create password</label><input id="signup-password" type="password" autocomplete="new-password" placeholder="Minimum 6 characters">
          <button class="primary full auth-continue" onclick="createAccount()">Create free account</button>
          <p id="signup-help" class="small muted center">Owners/managers can create a free workspace. Team members can join after their email is added by a manager.</p>
        </div>

        <div id="reset-box" class="hidden">
          <label>Email address</label><input id="reset-email" autocomplete="email" placeholder="you@business.com">
          <button class="primary full auth-continue" onclick="forgotPassword()">Send password reset link</button>
          <div class="auth-links clean-links"><button class="linkbtn" onclick="setAuthMode('login')">Back to sign in</button></div>
        </div>

        <p class="small muted center auth-fineprint">Secure email login with Firebase Authentication. New accounts must verify email before using a workspace.</p>
      </aside>
    </main>

    <section id="how-it-works" class="landing-section">
      <div class="section-head landing-section-head-tight">
        <span class="eyebrow">How it works</span>
        <h2>A practical workforce workflow for small businesses.</h2>
        <p class="landing-section-subtitle">Everything stays connected: roster planning, employee access, requests, time records, breaks, and reports.</p>
      </div>
      <div class="steps-grid landing-steps-grid">
        <div><b>1</b><strong>Set up workspace</strong><span>Add business name, industry, team members, roles, weekly limits, and access details.</span></div>
        <div><b>2</b><strong>Plan the roster</strong><span>Create shifts with times, roles and notes. Use copy/paste, drag and publish checks to finish faster.</span></div>
        <div><b>3</b><strong>Employee app view</strong><span>Employees open My Shifts, manage requests, swaps and availability without seeing manager-only tools.</span></div>
        <div><b>4</b><strong>Clock, breaks & review</strong><span>Track clock activity, break time, missing breaks, late issues and manager approval status.</span></div>
        <div><b>5</b><strong>Insights before publishing</strong><span>Compare scheduled and worked hours, check busy weeks, review limits, and avoid unnecessary overtime.</span></div>
        <div><b>6</b><strong>Reports & records</strong><span>Print schedules, export CSV files, and keep previous shifts and time records organised.</span></div>
      </div>
    </section>

    <section id="free-launch" class="landing-section landing-final">
      <h2>Start free during launch.</h2>
      <p>Use it for real roster planning, time clock testing, employee requests, break review, and clean reports before any pricing is added.</p>
      <div class="launch-proof-grid">
        <span>Roster builder</span><span>Time clock</span><span>Break alerts</span><span>Shift swaps</span><span>Availability</span><span>Reports</span>
      </div>
      <button class="primary hero-cta" onclick="openLandingAuth('signup')">Create free account</button>
    </section>
  </section>`;
}
function shellView(user){
  const b = business();
  const unread = unreadCount(user.id);
  const actionNeeded = actionNeededCount(user);
  const nav = isManagerial(user) ? `
    <button data-view="dashboard" onclick="go('dashboard')">Dashboard</button>
    <button data-view="roster" onclick="go('roster')">Roster Builder</button>
    <button data-view="employees" onclick="go('employees')">Employees</button>
    <button data-view="credentials" onclick="go('credentials')">Team Access</button>
    <button data-view="requests" onclick="go('requests')">Requests</button>
    <button data-view="timesheets" onclick="go('timesheets')">Timesheets</button>
    <button data-view="reports" onclick="go('reports')">Reports</button>
    ${user.role === "owner" ? `<button data-view="settings" onclick="go('settings')">Business Settings</button>` : ""}
  ` : `
    <button data-view="myshifts" onclick="go('myshifts')">My Shifts</button>
    <button data-view="availability" onclick="go('availability')">My Availability</button>
    <button data-view="myrequests" onclick="go('myrequests')">My Requests</button>
    <button data-view="clock" onclick="go('clock')">Clock In/Out</button>
  `;
  return `
  <section class="layout mobile-ready-shell role-${user.role}">
    <aside class="sidebar" aria-label="Workspace navigation">
      <nav class="nav">${nav}</nav>
    </aside>
    <section class="content">
      <div id="view"></div>
    </section>
  </section>`;
}

function renderContent(){
  document.querySelectorAll(".nav button").forEach(btn => btn.classList.toggle("active", btn.dataset.view === currentView));
  const view = el("view");
  if(!view) return;
  const user = currentUser();
  if(!user){ render(); return; }
  if(currentView === "profile"){ view.innerHTML = profileView(); return; }
  if(isManagerial(user)){
    if(currentView === "dashboard") view.innerHTML = managerDashboard();
    else if(currentView === "roster") view.innerHTML = rosterView();
    else if(currentView === "employees") view.innerHTML = employeesView();
    else if(currentView === "credentials") view.innerHTML = credentialsView();
    else if(currentView === "requests") view.innerHTML = requestsView(true);
    else if(currentView === "timesheets") view.innerHTML = timesheetsView();
    else if(currentView === "reports") view.innerHTML = reportsView();
    else if(currentView === "notifications") view.innerHTML = notificationsView();
    else if(currentView === "settings") view.innerHTML = settingsView();
    else view.innerHTML = managerDashboard();
  }else{
    if(currentView === "myshifts" || currentView === "mywork" || currentView === "myhours") view.innerHTML = employeeWorkView();
    else if(currentView === "availability") view.innerHTML = availabilityView();
    else if(currentView === "myrequests") view.innerHTML = requestsView(false);
    else if(currentView === "clock") view.innerHTML = clockView();
    else if(currentView === "notifications") view.innerHTML = notificationsView();
    else view.innerHTML = employeeWorkView();
  }
}

/* Auth */

function scrollLandingAuthIntoView(options = {}){
  const panel = document.querySelector(".landing-auth-card");
  if(!panel) return;
  const mobileOnly = options.mobileOnly !== false;
  if(mobileOnly && window.innerWidth > 820) return;
  const header = document.querySelector(".landing-nav");
  const headerHeight = header ? header.getBoundingClientRect().height : 0;
  const top = window.scrollY + panel.getBoundingClientRect().top - headerHeight - 12;
  window.scrollTo({top: Math.max(0, top), behavior: options.instant ? "auto" : "smooth"});
}

function openLandingAuth(mode){
  setAuthMode(mode);
  // Wait until the selected form is visible before measuring its position.
  requestAnimationFrame(() => requestAnimationFrame(() => scrollLandingAuthIntoView({mobileOnly:true})));
}

function setAuthMode(mode){
  const boxes = ["login-box","signup-box","reset-box"];
  boxes.forEach(id => { if(el(id)) el(id).classList.toggle("hidden", id !== `${mode}-box`); });
  if(el("login-tab")) el("login-tab").classList.toggle("active", mode === "login");
  if(el("signup-tab")) el("signup-tab").classList.toggle("active", mode === "signup");
  const landing = document.querySelector(".landing-page");
  if(landing){
    landing.classList.toggle("auth-mode-login", mode === "login");
    landing.classList.toggle("auth-mode-signup", mode === "signup");
    landing.classList.toggle("auth-mode-reset", mode === "reset");
  }
  const title = el("auth-title");
  const subtitle = el("auth-subtitle");
  if(title && subtitle){
    if(mode === "signup"){
      title.textContent = "Create your account";
      subtitle.textContent = "Start a free workspace or join your workplace.";
    }else if(mode === "reset"){
      title.textContent = "Reset your password";
      subtitle.textContent = "We will send a secure reset link to your email.";
      const loginEmail = normalizeEmail(el("login-email")?.value || "");
      if(loginEmail && el("reset-email")) el("reset-email").value = loginEmail;
    }else{
      title.textContent = "Welcome back";
      subtitle.textContent = "Sign in with your work email.";
    }
  }
  if(mode === "signup") updateSignupFields();
  if(mode === "signup") updateIndustryOtherField();
  const focusId = mode === "signup" ? (val("signup-type") === "join-team" ? "signup-name" : "signup-business-name") : mode === "reset" ? "reset-email" : "login-email";
  setTimeout(() => {
    const target = el(focusId);
    if(target){ target.focus(); try{ target.select && target.select(); }catch(e){} }
  }, 40);
}

function updateSignupFields(){
  const type = val("signup-type") || "create-business";
  const isCreate = type === "create-business";
  if(el("signup-business-fields")) el("signup-business-fields").classList.toggle("hidden", !isCreate);
  if(el("signup-help")) el("signup-help").textContent = isCreate
    ? "Create your free business workspace. Business and store IDs are generated automatically for clean team separation."
    : "Use the same email your manager added to the team. No activation code is needed.";
  updateIndustryOtherField();
}

function updateIndustryOtherField(){
  const industry = val("signup-industry");
  const other = el("signup-industry-other");
  if(other) other.classList.toggle("hidden", industry !== "Other");
}
function onIndustrySelectChange(){
  businessIndustryManualOverride = true;
  updateIndustryOtherField();
  // Do not reopen the business suggestion menu just because industry changed.
  // If the user is still typing in Business name, the next key press will refresh suggestions.
  if(document.activeElement?.id !== "signup-business-name") closeBusinessSuggestionList();
}

function selectedSignupIndustry(){
  const industry = val("signup-industry") || "Other";
  if(industry === "Other") return val("signup-industry-other") || "Other";
  return industry;
}

let businessSuggestionTimer = null;
let lastBusinessSuggestionQuery = "";
let businessIndustryManualOverride = false;
const INDUSTRY_OPTIONS = ["Café","Restaurant","Retail","Grocery","Fast food","Cleaning","Hospitality","Healthcare","Other"];

function businessSuggestionBaseNames(){
  return (state?.businesses || []).map(b => ({name:b.name, industry:b.industry || "Business"})).filter(x => x.name);
}
function closeBusinessSuggestionList(){
  const box = el("business-suggestion-list");
  if(box) box.classList.add("hidden");
}
function normaliseSuggestedIndustry(type){
  const t = String(type || "").toLowerCase();
  if(/cafe|coffee|bakery/.test(t)) return "Café";
  if(/restaurant|dining|food court|kitchen|grill/.test(t)) return "Restaurant";
  if(/fast|pizza|burger|takeaway|quick/.test(t)) return "Fast food";
  if(/grocery|supermarket|convenience|food store/.test(t)) return "Grocery";
  if(/retail|shop|store|mall|clothing|electronics|market/.test(t)) return "Retail";
  if(/clean|janitor|maintenance/.test(t)) return "Cleaning";
  if(/hotel|hospitality|motel|lounge|guest/.test(t)) return "Hospitality";
  if(/clinic|health|medical|care|pharmacy/.test(t)) return "Healthcare";
  return "Other";
}
function inferIndustryFromBusinessName(name){
  const t = String(name || "").toLowerCase();
  if(/pizza|burger|kfc|mcdonald|subway|takeaway|fried|chicken|express/.test(t)) return "Fast food";
  if(/cafe|coffee|tea|bakery|bake|roast/.test(t)) return "Café";
  if(/restaurant|kitchen|grill|dining|bistro|food/.test(t)) return "Restaurant";
  if(/grocery|supermarket|mart|fresh|convenience/.test(t)) return "Grocery";
  if(/clean|janitor|maintenance/.test(t)) return "Cleaning";
  if(/hotel|motel|lodge|inn|hospitality/.test(t)) return "Hospitality";
  if(/clinic|medical|health|care|pharmacy|dental/.test(t)) return "Healthcare";
  if(/store|shop|retail|outlet|market|fashion|electronics/.test(t)) return "Retail";
  return "";
}
function syncIndustryFromBusinessName(raw){
  if(businessIndustryManualOverride) return;
  const inferred = inferIndustryFromBusinessName(raw);
  if(inferred && el("signup-industry")){
    el("signup-industry").value = inferred;
    updateIndustryOtherField();
  }
}
function businessNameInputChanged(){
  businessIndustryManualOverride = false;
  const raw = el("signup-business-name")?.value || "";
  syncIndustryFromBusinessName(raw);
  updateBusinessNameSuggestions();
}
function businessTypeFromPlace(place){
  const raw = place?.type || place?.class || place?.category || "Business";
  return String(raw).replace(/_/g," ");
}
function localBusinessSuggestions(raw){
  const industry = selectedSignupIndustry();
  const suffixesByIndustry = {
    "Restaurant":["Restaurant","Kitchen","Grill","Dining"],
    "Fast food":["Pizza","Burgers","Takeaway","Express"],
    "Café":["Cafe","Coffee","Roasters","Bakery"],
    "Retail":["Store","Market","Outlet","Shop"],
    "Grocery":["Grocery","Market","Fresh Foods","Supermarket"],
    "Cleaning":["Cleaning","Cleaners","Maintenance","Services"],
    "Hospitality":["Hospitality","Lounge","Hotel","Guest Services"],
    "Healthcare":["Care","Clinic","Health","Support"]
  };
  const saved = businessSuggestionBaseNames()
    .filter(x => x.name.toLowerCase().includes(raw.toLowerCase()))
    .map(x => ({name:x.name, industry:normaliseSuggestedIndustry(x.industry), type:x.industry || "saved workspace"}));
  const suffixes = suffixesByIndustry[industry] || ["Services","Group","Co","Team","Studio","Store"];
  const generated = suffixes.slice(0,5).map(suf => ({
    name: raw.toLowerCase().endsWith(suf.toLowerCase()) ? raw : `${raw} ${suf}`,
    industry: industry === "Other" ? normaliseSuggestedIndustry(suf) : industry,
    type: String(suf).toLowerCase()
  }));
  return [...saved, ...generated];
}
function renderBusinessSuggestionList(items){
  const box = el("business-suggestion-list");
  if(!box) return;
  const seen = new Set();
  const unique = items.filter(item => {
    const key = String(item.name || "").toLowerCase().trim();
    if(!key || seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0,8);
  if(!unique.length){ box.classList.add("hidden"); box.innerHTML=""; return; }
  box.innerHTML = unique.map(item => `
    <button type="button" class="business-suggestion-item" onclick="selectBusinessSuggestion('${escAttr(item.name)}','${escAttr(item.industry || 'Other')}')">
      <span>${esc(item.name)}</span>
      <small>${esc(item.industry || 'Other')} · ${esc(String(item.type || 'business').toLowerCase())}</small>
    </button>`).join("");
  box.classList.remove("hidden");
}
function selectBusinessSuggestion(name, industry){
  if(el("signup-business-name")) el("signup-business-name").value = name || "";
  const normal = INDUSTRY_OPTIONS.includes(industry) ? industry : normaliseSuggestedIndustry(industry);
  if(el("signup-industry")) el("signup-industry").value = normal || "Other";
  businessIndustryManualOverride = false;
  updateIndustryOtherField();
  closeBusinessSuggestionList();
  setTimeout(()=>el("signup-name")?.focus(), 40);
}
async function fetchGlobalBusinessSuggestions(raw){
  // Free public place search. If it is unavailable, local suggestions still work and manual entry is always allowed.
  try{
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&addressdetails=0&q=${encodeURIComponent(raw)}`;
    const res = await fetch(url, {headers:{"Accept":"application/json"}});
    if(!res.ok) throw new Error("suggestion search unavailable");
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map(place => {
      const name = String(place.name || place.display_name || raw).split(",")[0].trim();
      const type = businessTypeFromPlace(place);
      return {name, industry:normaliseSuggestedIndustry(type), type};
    });
  }catch(e){
    return [];
  }
}
function updateBusinessNameSuggestions(){
  const input = el("signup-business-name");
  const box = el("business-suggestion-list");
  if(!input || !box) return;
  const raw = input.value.trim().replace(/\s+/g," ");
  if(raw.length < 2){ box.classList.add("hidden"); box.innerHTML=""; return; }
  const local = localBusinessSuggestions(raw);
  renderBusinessSuggestionList(local);
  clearTimeout(businessSuggestionTimer);
  businessSuggestionTimer = setTimeout(async () => {
    if(!el("signup-business-name")) return;
    const latest = el("signup-business-name").value.trim().replace(/\s+/g," ");
    const queryKey = `${latest}|${selectedSignupIndustry()}`;
    if(latest.length < 2 || queryKey === lastBusinessSuggestionQuery) return;
    lastBusinessSuggestionQuery = queryKey;
    const global = await fetchGlobalBusinessSuggestions(latest);
    if(el("signup-business-name")?.value.trim().replace(/\s+/g," ") === latest){
      renderBusinessSuggestionList([...global, ...localBusinessSuggestions(latest)]);
    }
  }, 450);
}

function cleanCodePart(text){
  const cleaned = String(text || "MS").toUpperCase().replace(/[^A-Z0-9]+/g, "").slice(0, 6);
  return cleaned || "MS";
}
function shortRandomCode(){ return Math.random().toString(36).slice(2, 7).toUpperCase(); }
function generateBusinessCode(name){ return `BUS-${cleanCodePart(name)}-${shortRandomCode()}`; }
function generateStoreCode(name){ return `STORE-${cleanCodePart(name)}-${shortRandomCode()}`; }

function initLandingPageUX(){
  const landing = document.querySelector(".landing-page");
  if(!landing || landing.dataset.enhanced === "true") return;
  landing.dataset.enhanced = "true";
  if(!landing.classList.contains("auth-mode-signup") && !landing.classList.contains("auth-mode-reset")) landing.classList.add("auth-mode-login");
  const headerOffset = () => (document.querySelector(".landing-nav")?.offsetHeight || 70) + 14;
  document.querySelectorAll(".landing-navlinks a").forEach(a => {
    a.addEventListener("click", evt => {
      evt.preventDefault();
      const id = a.getAttribute("href")?.replace("#", "");
      const target = id ? document.getElementById(id) : null;
      if(target){
        const y = window.scrollY + target.getBoundingClientRect().top - headerOffset();
        window.scrollTo({top: Math.max(0, y), behavior:"smooth"});
      }
    });
  });
  const syncActive = () => {
    const ids = ["features","how-it-works","free-launch"];
    let active = ids[0];
    ids.forEach(id => {
      const sec = document.getElementById(id);
      if(sec && sec.getBoundingClientRect().top <= headerOffset() + 22) active = id;
    });
    document.querySelectorAll(".landing-navlinks a").forEach(a => a.classList.toggle("active", a.dataset.section === active));
  };
  window.addEventListener("scroll", syncActive, {passive:true});
  window.addEventListener("resize", syncActive, {passive:true});
  syncActive();
  const navScroller = document.querySelector(".landing-navlinks");
  if(navScroller && !navScroller.dataset.dragReady){
    navScroller.dataset.dragReady = "true";
    let isDown = false, startX = 0, startLeft = 0;
    navScroller.addEventListener("pointerdown", e => {
      if(window.innerWidth > 820) return;
      isDown = true; startX = e.clientX; startLeft = navScroller.scrollLeft;
      navScroller.setPointerCapture?.(e.pointerId);
    });
    navScroller.addEventListener("pointermove", e => {
      if(!isDown) return;
      const dx = e.clientX - startX;
      if(Math.abs(dx) > 3){ e.preventDefault(); navScroller.scrollLeft = startLeft - dx; }
    });
    ["pointerup","pointercancel","pointerleave"].forEach(type => navScroller.addEventListener(type, () => { isDown = false; }));
  }
  const enterSubmit = (containerId, handler) => {
    const box = el(containerId);
    if(!box) return;
    box.querySelectorAll("input,select").forEach(input => {
      input.addEventListener("keydown", evt => {
        if(evt.key === "Enter"){
          evt.preventDefault();
          handler();
        }
      });
    });
  };
  enterSubmit("login-box", login);
  enterSubmit("signup-box", createAccount);
  enterSubmit("reset-box", forgotPassword);
  updateIndustryOtherField();
  updateBusinessNameSuggestions();
}

function requireAuth(){
  initFirebase();
  if(!firebaseAuth) throw new Error("Firebase Auth is not available. Check Firebase scripts and config.");
  return firebaseAuth;
}

async function login(){
  const email = normalizeEmail(readCredentialFromInput("login-email", "email"));
  const password = cleanPassword(readCredentialFromInput("login-password", "password"));
  if(!isValidEmail(email) || !password) return toast("Enter your email and password.");
  try{
    const auth = requireAuth();
    await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION).catch(()=>{});
    if(auth.currentUser && normalizeEmail(auth.currentUser.email) !== email){ await auth.signOut().catch(()=>{}); clearCurrentSession(); }
    const cred = await auth.signInWithEmailAndPassword(email, password);
    if(!cred.user.emailVerified){
      await cred.user.sendEmailVerification({url: window.location.href.split("#")[0]});
      await auth.signOut();
      clearCurrentSession();
      return toast("Please verify your email first. A new verification link was sent.");
    }
    const cloudState = await loadFirebaseState();
    if(cloudState) state = migrateState(cloudState);
    startFirebaseLiveUpdates();
    await finishAuthLogin(cred.user);
  }catch(e){
    console.warn(e);
    toast(firebaseErrorMessage(e));
  }
}

async function finishAuthLogin(authUser){
  const email = normalizeEmail(authUser?.email || "");
  if(!authUser || !authUser.emailVerified || !email){
    await firebaseAuth?.signOut().catch(()=>{});
    clearCurrentSession();
    return toast("Please verify your email before signing in.");
  }

  // Prefer the exact Firebase UID, but safely recover legacy owner/employee profiles
  // by the same verified email. This repairs profiles created before UID linking was added.
  let user = state.users.find(u => u.authUid === authUser.uid && u.status !== "removed");
  if(!user){
    const emailMatches = state.users.filter(u => normalizeEmail(u.email) === email && u.status !== "removed");
    if(emailMatches.length === 1) user = emailMatches[0];
    else if(emailMatches.length > 1){
      // Prefer the owner profile for an owner email; otherwise use the active profile.
      user = emailMatches.find(u => u.role === "owner") || emailMatches.find(u => u.status === "active") || emailMatches[0];
    }
  }

  if(!user){
    await firebaseAuth.signOut().catch(()=>{});
    clearCurrentSession();
    return toast("Account verified, but no MySchedule business profile was found for this email.");
  }

  const wasRelinked = !!user.authUid && user.authUid !== authUser.uid;
  user.authUid = authUser.uid;
  if(user.status === "invited" || user.status === "pending_verification") user.status = "active";
  user.emailVerified = true;
  user.lastLoginAt = now();
  user.forcePasswordChange = false;
  user.tempPassword = "";
  delete user.password;
  delete user.localPassword;
  await saveFirebaseState(JSON.parse(JSON.stringify(state)));
  setCurrentSession(user.id);
  currentView = isManagerial(user) ? "dashboard" : "myshifts";
  render();
  return true;
}

async function createBusinessInviteFromOwner(){
  const owner = currentUser();
  if(!owner || owner.role !== "owner") return toast("Only the owner can add a business admin.");
  const businessName = val("new-business-name");
  const industry = val("new-business-industry") || "Other";
  const name = val("new-business-user-name");
  const email = normalizeEmail(val("new-business-user-email"));
  const role = val("new-business-user-role") || "owner";
  if(!businessName || !name || !isValidEmail(email)) return toast("Enter business name, user name and valid email.");
  if(state.users.some(u => normalizeEmail(u.email) === email && u.status !== "removed")) return toast("This email already has a MySchedule profile. Use a different email.");
  const businessId = uuid();
  const userId = uuid();
  state.businesses.push({
    id: businessId,
    businessCode: generateBusinessCode(businessName),
    storeCode: generateStoreCode(businessName),
    name: businessName,
    industry,
    country: business()?.country || "Australia",
    timezone: business()?.timezone || detectedDeviceTimezone(),
    subscription: "Free launch",
    createdAt: now(),
    createdByOwnerId: owner.id
  });
  state.users.push({
    id: userId,
    businessId,
    name,
    email,
    role,
    status: "invited",
    notifyEmail: true,
    notifyInApp: true,
    emailVerified: false,
    invitedAt: now(),
    invitedBy: owner.id,
    createdAt: now()
  });
  saveState();
  await sendBusinessInviteEmail({name,email,role,businessName});
  render();
  toast("Business admin added. They can now create an account with that email and verify it.");
}

async function sendBusinessInviteEmail({name,email,role,businessName}){
  const u = state.users.find(x => normalizeEmail(x.email) === normalizeEmail(email) && x.status !== "removed");
  if(!u) return;
  const loginUrl = window.location.href.split("#")[0];
  notifyUser(
    u.id,
    "invite",
    "Join your workplace on My Schedule",
    `Hi ${name}, your workplace has added you to My Schedule as ${role} for ${businessName}. Open this link: ${loginUrl}. Use this email address: ${email}. Create your free account with this email, then verify it before signing in.`,
    {forceToEmail: email, recipientSource:"owner_business_invite", templateType:"invite", loginUrl, tempPassword:""}
  );
  notifyRole(["owner"], "invite", "New business admin added", `${name} was added as ${role} for ${businessName}. Account setup email sent to ${email}.`);
}

async function createAccount(){
  const type = val("signup-type") || "create-business";
  const name = val("signup-name");
  const email = normalizeEmail(val("signup-email"));
  const password = val("signup-password");
  if(!name || !isValidEmail(email) || password.length < 6) return toast("Enter name, valid email, and a password with minimum 6 characters.");

  if(type === "create-business"){
    const businessName = val("signup-business-name");
    if(!businessName) return toast("Enter your business name.");
  }

  try{
    const auth = requireAuth();
    await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION).catch(()=>{});
    const cred = await auth.createUserWithEmailAndPassword(email, password);
    await cred.user.updateProfile({displayName: name}).catch(()=>{});
    const cloudState = await loadFirebaseState();
    if(cloudState) state = migrateState(cloudState);
    await cred.user.sendEmailVerification({url: window.location.href.split("#")[0]});

    if(type === "create-business"){
      if(state.users.some(u => normalizeEmail(u.email) === email && u.status !== "removed")){
        await cred.user.delete().catch(()=>{});
        return toast("This email already belongs to a workspace. Use Sign in or Forgot password.");
      }
      const businessName = val("signup-business-name");
      const industry = selectedSignupIndustry();
      const role = val("signup-role") || "owner";
      const businessId = uuid();
      const userId = uuid();
      state.businesses.push({
        id: businessId,
        businessCode: generateBusinessCode(businessName),
        storeCode: generateStoreCode(businessName),
        name: businessName,
        industry,
        country: /^America\/(Toronto|Montreal|Ottawa)/.test(detectedDeviceTimezone()) ? "Canada" : "Australia",
        timezone: detectedDeviceTimezone(),
        subscription: "Free launch",
        createdAt: now(),
        createdByOwnerId: userId
      });
      state.users.push({
        id: userId,
        businessId,
        name,
        email,
        role,
        status: "pending_verification",
        authUid: cred.user.uid,
        notifyEmail: true,
        notifyInApp: true,
        emailVerified: false,
        createdAt: now()
      });
      if(!(await saveFirebaseState(JSON.parse(JSON.stringify(state))))) throw new Error("WORKSPACE_SAVE_RETRY");
      await auth.signOut();
      clearCurrentSession();
      setAuthMode("login");
      return toast("Account created. Please verify your email, then sign in.");
    }

    const profile = state.users.find(u => normalizeEmail(u.email) === email && u.status !== "removed");
    if(!profile){
      await cred.user.delete().catch(()=>{});
      await auth.signOut().catch(()=>{});
      return toast("No workplace invitation was found for this email. Ask the owner or manager to add it first.");
    }
    if(profile.authUid && profile.authUid !== cred.user.uid){
      await cred.user.delete().catch(()=>{});
      await auth.signOut().catch(()=>{});
      return toast("This workplace profile is already connected. Use Sign in or Forgot password.");
    }
    profile.name = profile.name || name;
    profile.authUid = cred.user.uid;
    profile.status = "pending_verification";
    profile.emailVerified = false;
    delete profile.password;
    if(!(await saveFirebaseState(JSON.parse(JSON.stringify(state))))) throw new Error("WORKSPACE_SAVE_RETRY");
    await auth.signOut();
    clearCurrentSession();
    setAuthMode("login");
    toast("Account created. Please verify your email, then sign in.");
  }catch(e){
    console.warn(e);
    if(e && e.message === "WORKSPACE_SAVE_RETRY") return toast("Please try once more.");
    toast(firebaseErrorMessage(e));
  }
}


async function forgotPassword(){
  const email = normalizeEmail(val("reset-email") || val("login-email"));
  if(!isValidEmail(email)) return toast("Enter your email first.");
  try{
    const auth = requireAuth();
    await auth.sendPasswordResetEmail(email, {url: window.location.href.split("#")[0]});
    toast("Password reset link sent. Check your email inbox and spam folder.");
  }catch(e){
    console.warn(e);
    toast(firebaseErrorMessage(e));
  }
}

async function resendVerificationFromLogin(){
  const email = normalizeEmail(val("login-email"));
  const password = cleanPassword(val("login-password"));
  if(!isValidEmail(email) || !password) return toast("Enter email and password first, then resend verification.");
  try{
    const auth = requireAuth();
    const cred = await auth.signInWithEmailAndPassword(email, password);
    if(cred.user.emailVerified){
      await finishAuthLogin(cred.user);
      return;
    }
    await cred.user.sendEmailVerification({url: window.location.href.split("#")[0]});
    await auth.signOut();
    toast("Verification link sent again.");
  }catch(e){
    console.warn(e);
    toast(firebaseErrorMessage(e));
  }
}

async function logout(){
  try{ if(firebaseLiveUnsubscribe){ firebaseLiveUnsubscribe(); firebaseLiveUnsubscribe = null; } }catch(e){}
  try{ if(firebaseAuth) await firebaseAuth.signOut(); }catch(e){}
  try{ localStorage.removeItem(APP_KEY); }catch(e){}
  currentUserId = null;
  clearCurrentSession();
  currentView = "dashboard";
  updateTopbarAuthVisibility(null);
  render();
}


function credentialsView(){
  const b = business();
  const users = state.users.filter(u => u.businessId === b.id && u.status !== "removed").sort((a,b)=>a.role.localeCompare(b.role) || a.name.localeCompare(b.name));
  return `
  <div class="panel-head">
    <div>
      <h2>Team Access</h2>
      <p class="muted">Add managers and employees. Passwords are never shown or stored; each person creates their own secure verified account.</p>
    </div>
    <button class="primary" onclick="openUserModal()">Add Team Member</button>
  </div>
  <div class="notice oknotice">Launch mode: public sign-in is enabled, email verification is required, and forgot-password links are handled by Firebase Authentication.</div>
  <div class="panel">${credentialsTable(users)}</div>`;
}

function credentialsTable(users){
  return `<div class="table-wrap"><table><thead><tr><th>Role</th><th>Name</th><th>Email</th><th>Verification</th><th>Status</th><th>Actions</th></tr></thead><tbody>
  ${users.map(u => `<tr>
    <td><span class="badge ${u.role}">${u.role}</span></td>
    <td>${esc(u.name)}</td>
    <td><strong>${esc(u.email)}</strong></td>
    <td>${u.emailVerified ? '<span class="badge good">Verified</span>' : '<span class="badge warn">Pending</span>'}</td>
    <td>${esc(u.status || 'active')}</td>
    <td class="actions">
      <button class="tiny" onclick="copyInviteInfo('${u.id}')">Copy Info</button>
      ${u.role !== "owner" ? `<button class="tiny" onclick="resendInvite('${u.id}')">Resend Account Email</button><button class="tiny" onclick="sendPasswordResetForUser('${u.id}')">Send Reset Link</button>` : `<button class="tiny" onclick="sendPasswordResetForUser('${u.id}')">Send Reset Link</button>`}
    </td>
  </tr>`).join("")}</tbody></table></div>`;
}

function copyInviteInfo(userId){
  const u = state.users.find(x => x.id === userId);
  if(!u) return;
  const text = `MySchedule Access\nRole: ${u.role}\nName: ${u.name}\nEmail: ${u.email}\nLogin URL: ${window.location.href.split("#")[0]}\nUse Sign in if you already created a password. Use Forgot password if you need a reset link.`;
  navigator.clipboard?.writeText(text).then(()=>toast("Access info copied.")).catch(()=>alert(text));
}

async function sendPasswordResetForUser(userId){
  const u = state.users.find(x => x.id === userId);
  if(!u) return;
  try{
    const auth = requireAuth();
    await auth.sendPasswordResetEmail(normalizeEmail(u.email), {url: window.location.href.split("#")[0]});
    notifyUser(u.id, "login", "MySchedule password reset link sent", `Hi ${u.name}, a password reset link has been sent to ${u.email}. Please check your inbox and spam folder.`, {forceToEmail:u.email, recipientSource:"password_reset", templateType:"invite", loginUrl:window.location.href.split("#")[0]});
    toast("Password reset link sent.");
  }catch(e){
    console.warn(e);
    toast(firebaseErrorMessage(e));
  }
}

function showCredentialModal(data){
  modal(`
    <h3>Account Access Created</h3>
    <div class="credential-card">
      <div class="cred-logo">MS</div>
      <div>
        <p class="muted">Share this login page with the new ${esc(data.role)}.</p>
        <h2>${esc(data.name)}</h2>
      </div>
      <div class="cred-row"><span>Business</span><strong>${esc(data.businessName)}</strong></div>
      <div class="cred-row"><span>Role</span><strong>${esc(data.role)}</strong></div>
      <div class="cred-row"><span>Email</span><strong>${esc(data.email)}</strong></div>
      <div class="cred-row"><span>Login URL</span><strong>${esc(window.location.href.split("#")[0])}</strong></div>
      <p class="small muted">The user should open MySchedule, use the same email, create/verify their Firebase account if needed, or use Forgot password to receive a secure reset link.</p>
      <div class="actions" style="margin-top:14px">
        <button class="primary" onclick="copyInviteInfo('${esc(data.id || '')}')">Copy Access Info</button>
        <button onclick="closeModal()">Close</button>
      </div>
    </div>
  `);
}

function managerDashboard(){
  const b = business();
  const employees = state.users.filter(u => u.businessId === b.id && u.role === "employee" && u.status === "active");
  const weekShifts = visibleWeekShifts();
  const weeklyHours = totalHours(weekShifts);
  const pending = state.requests.filter(r => r.businessId === b.id && r.status === "pending");
  const alerts = buildAlerts();
  const notes = state.notifications.filter(n => n.businessId === b.id).slice(-8).reverse();
  const priorityText = pending.length ? `${pending.length} request${pending.length === 1 ? "" : "s"} waiting for approval` : alerts.length ? `${alerts.length} schedule alert${alerts.length === 1 ? "" : "s"} to review` : "Everything looks clear";
  const prioritySub = pending.length ? "Approve or reject staff availability and shift requests." : alerts.length ? "Check hours, limits, and schedule conflicts before publishing." : "No urgent manager action needed right now.";
  return `
  <section class="dashboard-apple">
    <div class="dashboard-hero">
      <div>
        <span class="eyebrow">Manager dashboard</span>
        <h2>${esc(b?.name || "MySchedule")}</h2>
        <p>${esc(prioritySub)}</p>
      </div>
      <button class="primary" onclick="go('${pending.length ? "requests" : alerts.length ? "roster" : "roster"}')">${pending.length ? "Review requests" : alerts.length ? "Open roster" : "Build roster"}</button>
    </div>

    <div class="dashboard-focus-card ${pending.length || alerts.length ? "needs-action" : "all-clear"}">
      <div class="focus-icon">${pending.length ? "!" : alerts.length ? "•" : "✓"}</div>
      <div>
        <strong>${esc(priorityText)}</strong>
        <span>${pending.length ? "Requests should be handled before publishing changes." : alerts.length ? "Alerts are suggestions to help avoid scheduling issues." : "You can continue building or publishing the schedule."}</span>
      </div>
    </div>

    <div class="dashboard-smart-grid">
      <button class="smart-card" onclick="go('employees')">
        <span>Team</span><strong>${employees.length}</strong><em>active employee${employees.length === 1 ? "" : "s"}</em>
      </button>
      <button class="smart-card" onclick="go('roster')">
        <span>This week</span><strong>${weeklyHours.toFixed(1)} hrs</strong><em>${weekShifts.length} shift${weekShifts.length === 1 ? "" : "s"} planned</em>
      </button>
      <button class="smart-card ${pending.length ? "attention" : ""}" onclick="go('requests')">
        <span>Requests</span><strong>${pending.length || "Clear"}</strong><em>${pending.length ? "needs approval" : "no pending items"}</em>
      </button>
      <button class="smart-card ${alerts.length ? "attention" : ""}" onclick="go('roster')">
        <span>Alerts</span><strong>${alerts.length || "Clear"}</strong><em>${alerts.length ? "review schedule" : "no issues found"}</em>
      </button>
    </div>

    <div class="dashboard-two-col">
      <div class="apple-panel">
        <div class="apple-panel-head">
          <div><h3>Needs your attention</h3><p>Only useful items are shown here.</p></div>
          ${pending.length ? `<button class="tiny" onclick="go('requests')">View all</button>` : ``}
        </div>
        ${managerActionList(pending, alerts)}
      </div>
      <div class="apple-panel">
        <div class="apple-panel-head">
          <div><h3>Recent notifications</h3><p>Simple delivery and message activity.</p></div>
          <button class="tiny" onclick="go('notifications')">Open inbox</button>
        </div>
        ${dashboardNotificationList(notes)}
      </div>
    </div>
  </section>`;
}

function managerActionList(pending, alerts){
  const items = [];
  pending.slice(0,4).forEach(r => {
    const who = userName(r.employeeId || r.userId);
    const detail = r.date ? friendlyDate(r.date) : (r.createdAt ? dateTime(r.createdAt) : "New request");
    items.push(`<button class="action-item" onclick="go('requests')"><span class="dot urgent"></span><div><strong>${esc(who || "Employee request")}</strong><small>${esc(requestLabel(r))} • ${esc(detail)}</small></div><em>Review</em></button>`);
  });
  alerts.slice(0,4-pending.slice(0,4).length).forEach(a => {
    items.push(`<button class="action-item" onclick="go('roster')"><span class="dot warn"></span><div><strong>${esc(a.employee || "Schedule alert")}</strong><small>${esc(a.message)}</small></div><em>Fix</em></button>`);
  });
  if(!items.length) return `<div class="apple-empty-mini"><strong>No action needed</strong><span>Your dashboard is clear.</span></div>`;
  return `<div class="action-list">${items.join("")}</div>`;
}

function requestLabel(r){
  const type = String(r.type || "request").replace(/_/g," ");
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function dashboardNotificationList(rows){
  if(!rows.length) return `<div class="apple-empty-mini"><strong>No notifications yet</strong><span>New alerts and delivery updates will appear here.</span></div>`;
  return `<div class="dash-note-list">${rows.map(n => `
    <button class="dash-note ${n.read ? "" : "unread"}" onclick="openNotificationTarget('${n.id}')">
      <span class="note-dot"></span>
      <div><strong>${esc(cleanNotificationSubject(n))}</strong><small>${esc(cleanNotificationMessage(n))}</small></div>
      <em>${esc(relativeTime(n.createdAt))}</em>
    </button>`).join("")}</div>`;
}

function cleanNotificationSubject(n){
  return String(n.originalSubject || n.subject || "Notification").replace(/^MySchedule Alert\s*\[[^\]]+\]:\s*/i,"").trim();
}

function cleanNotificationMessage(n){
  const msg = String(n.originalMessage || n.message || "").replace(/Reference ID:[\s\S]*$/i,"").trim();
  return msg.length > 92 ? msg.slice(0,89).trim() + "..." : msg;
}

function relativeTime(value){
  if(!value) return "Now";
  const d = new Date(value);
  const diff = Date.now() - d.getTime();
  if(!Number.isFinite(diff)) return "Now";
  const mins = Math.max(0, Math.round(diff/60000));
  if(mins < 1) return "Now";
  if(mins < 60) return `${mins}m`;
  const hrs = Math.round(mins/60);
  if(hrs < 24) return `${hrs}h`;
  const days = Math.round(hrs/24);
  return `${days}d`;
}

function rosterView(){
  const b = business();
  const weekShifts = visibleWeekShifts();
  const monthStart = new Date(rosterWeekStart.getFullYear(), rosterWeekStart.getMonth(), 1);
  const monthEnd = new Date(rosterWeekStart.getFullYear(), rosterWeekStart.getMonth()+1, 1);
  const monthHours = totalHours(state.shifts.filter(s => s.businessId === b.id && dateObj(s.date) >= monthStart && dateObj(s.date) < monthEnd));
  return `
  <div class="panel-head">
    <div>
      <h2>Roster Builder</h2>
      <p class="muted">Edit freely in draft mode. Staff emails are sent only when you click Publish Week.</p>
    </div>
    <button class="primary" onclick="openShiftModal()">Add Shift</button>
  </div>
  <div class="grid roster-metrics">
    <button class="stat micro-stat" onclick="focusRosterBoard()"><strong>${totalHours(weekShifts).toFixed(1)}</strong><span>Weekly hrs</span></button>
    <button class="stat micro-stat" onclick="focusRosterBoard()"><strong>${monthHours.toFixed(1)}</strong><span>Monthly hrs</span></button>
    <button class="stat micro-stat" onclick="focusRosterBoard()"><strong>${weekShifts.length}</strong><span>Shifts</span></button>
    <button class="stat micro-stat" onclick="pasteCopiedWeek()"><strong>${copiedWeekBuffer ? copiedWeekBuffer.length : 0}</strong><span>Copied</span></button>
  </div>
  <div class="panel roster-panel">
    <div class="schedule-toolbar apple-week-toolbar">
      <div class="week-switcher">
        <button class="week-arrow" aria-label="Previous week" title="Previous week" onclick="changeRosterWeek(-7)">‹</button>
        <div class="week-pill">${shortDate(rosterWeekStart)} - ${shortDate(addDays(rosterWeekStart,6))}</div>
        <button class="week-arrow" aria-label="Next week" title="Next week" onclick="changeRosterWeek(7)">›</button>
      </div>
      <div class="week-actions">
        <button onclick="copyVisibleWeek()">Copy</button>
        <button onclick="pasteCopiedWeek()">Paste</button>
        <button onclick="copyWeekToNextWeek()">Next wk</button>
        <button class="primary publish-main" onclick="publishWeek()">Publish</button>
        <button class="success" onclick="quickPrintWeek()">Print</button>
        <button class="danger" onclick="clearWeek()">Clear</button>
      </div>
    </div>
    <div class="notice oknotice">Notification rule: adding, editing, copying, deleting or dragging shifts will not email staff. Emails are sent only from the main <strong>Publish Week</strong> button.</div>
    ${scheduleBoard(weekShifts)}
  </div>
  <div class="panel">
    <h3>Employee Hour Summary</h3>
    ${employeeHoursSummaryTable(weekShifts)}
  </div>
  <div class="panel">
    <h3>List View</h3>
    ${shiftsTable(weekShifts, true)}
  </div>`;
}

function employeesView(){
  const b = business();
  const users = state.users.filter(u => u.businessId === b.id);
  return `
  <div class="panel-head">
    <div><h2>Employees & Access</h2><p class="muted">Add managers and employees. Account setup emails are sent through Brevo when email notifications are active.</p></div>
    <button class="primary" onclick="openUserModal()">Add User</button>
  </div>
  <div class="panel">${usersTable(users)}</div>`;
}

function timesheetsView(){
  const rows = state.timesheets.filter(t => t.businessId === business().id).sort((a,b)=>b.clockIn.localeCompare(a.clockIn));
  return `<h2>Timesheets</h2><p class="muted">Clock in/out records.</p><div class="panel">${timesheetTable(rows)}</div>`;
}

function reportsView(){
  const employees = state.users.filter(u => u.businessId === business().id && u.role === "employee" && u.status === "active").sort((a,b)=>a.name.localeCompare(b.name));
  const defaultStart = isoDate(rosterWeekStart);
  const columnOptions = [
    ["no","No."],["date","Date"],["day","Day"],["employee","Employee"],["email","Email"],["time","Time"],["break","Break"],["hours","Hours"],["role","Role"],["location","Location"],["status","Status"],["notes","Notes"],["signature","Signature"]
  ];
  return `
  <div class="panel-head">
    <div>
      <h2>Printouts & Reports</h2>
      <p class="muted">Build professional workforce printouts. Choose the layout, filters, sections, and exact columns before printing.</p>
    </div>
    <button class="primary" onclick="printReport()">Print / Save PDF</button>
  </div>
  <div class="panel report-controls">
    <h3>1) Choose printout style</h3>
    <div class="form-grid">
      <div><label>Printout Layout</label><select id="report-layout" onchange="applyReportPreset();updateReportPreview()">
        <option value="weekly_board">Weekly Schedule Board</option>
        <option value="daily_signin">Daily Sign-in Sheet</option>
        <option value="employee_cards">Employee Schedule Cards</option>
        <option value="hours_summary">Employee Hours Summary</option>
        <option value="detailed">Detailed Shift List</option>
        <option value="custom">Custom Builder</option>
      </select></div>
      <div><label>Period</label><select id="report-period" onchange="syncReportPeriod();updateReportPreview()"><option value="week">Weekly</option><option value="month">Monthly</option><option value="custom">Custom Dates</option></select></div>
      <div><label>Start Date</label><input id="report-start" type="date" value="${defaultStart}" onchange="updateReportPreview()"></div>
      <div><label>End Date</label><input id="report-end" type="date" value="${isoDate(addDays(rosterWeekStart,7))}" onchange="updateReportPreview()"></div>
      <div><label>Employee</label><select id="report-employee" onchange="updateReportPreview()"><option value="all">All Employees</option>${employees.map(e=>`<option value="${e.id}">${esc(e.name)}</option>`).join("")}</select></div>
      <div><label>Shift Status</label><select id="report-status" onchange="updateReportPreview()"><option value="published_only">Published + Confirmed Only</option><option value="all">All Statuses</option><option value="draft">Draft Only</option></select></div>
      <div><label>Page Format</label><select id="report-page" onchange="updateReportPreview()"><option value="landscape">A4 Landscape</option><option value="portrait">A4 Portrait</option></select></div>
      <div><label>Group By</label><select id="report-group" onchange="updateReportPreview()"><option value="day">Day</option><option value="employee">Employee</option><option value="none">No Grouping</option></select></div>
    </div>

    <h3 style="margin-top:16px">2) Choose what to include</h3>
    <div class="option-grid">
      <label><input id="sec-cover" type="checkbox" checked onchange="updateReportPreview()"> Header / business name</label>
      <label><input id="sec-kpis" type="checkbox" onchange="updateReportPreview()"> Quick totals</label>
      <label><input id="sec-summary" type="checkbox" checked onchange="updateReportPreview()"> Employee hours summary</label>
      <label><input id="sec-details" type="checkbox" checked onchange="updateReportPreview()"> Shift details</label>
      <label><input id="sec-signature" type="checkbox" onchange="updateReportPreview()"> Signature / acknowledgement column</label>
      <label><input id="sec-notes" type="checkbox" checked onchange="updateReportPreview()"> Show notes</label>
    </div>

    <h3 style="margin-top:16px">3) Choose columns</h3>
    <div class="column-picker">
      ${columnOptions.map(([key,label])=>`<label><input class="report-col" data-col="${key}" type="checkbox" ${["no","date","day","employee","time","hours","role","location","status","notes"].includes(key)?"checked":""} onchange="updateReportPreview()"> ${label}</label>`).join("")}
    </div>

    <div class="actions" style="margin-top:14px">
      <button class="primary" onclick="printReport()">Print / Save PDF</button>
      <button onclick="downloadReportCSV()">Download CSV</button>
      <button onclick="updateReportPreview()">Refresh Preview</button>
    </div>
    <div class="notice oknotice">Use <strong>Weekly Schedule Board</strong> for staff room printouts, <strong>Daily Sign-in Sheet</strong> for shift confirmation, or <strong>Custom Builder</strong> to decide exactly what appears.</div>
  </div>
  <div id="report-preview" class="panel report-preview">${buildPrintableReport(getReportOptions())}</div>
  <div class="panel"><h3>Alerts</h3>${alertsTable(buildAlerts())}</div>`;
}

function settingsView(){
  const b = business();
  const c = state.emailConfig;
  return `
  <h2>Business Settings</h2>
  <div class="panel">
    <h3>Business</h3>
    <div class="form-grid">
      <div><label>Business Name</label><input id="biz-name" value="${attr(b.name)}"></div>
      <div><label>Industry</label><input id="biz-industry" value="${attr(b.industry)}"></div>
      <div><label>Country</label><input id="biz-country" value="${attr(b.country)}"></div>
      <div><label>Timezone</label><input id="biz-timezone" value="${attr(b.timezone)}"></div>
    </div>
    <button class="primary" onclick="saveBusinessSettings()">Save Business</button>
  </div>
  ${currentUser()?.role === "owner" ? `
  <div class="panel">
    <h3>Invite Another Business Admin</h3>
    <div class="notice oknotice">This is no longer public. Only a logged-in owner can create another business invitation. The invited owner/manager will choose <strong>Create account</strong>, select <strong>Join my workplace</strong>, use the invited email, and verify it before signing in.</div>
    <div class="form-grid">
      <div><label>New Business Name</label><input id="new-business-name" placeholder="Business name"></div>
      <div><label>Industry</label><select id="new-business-industry"><option>Café</option><option>Restaurant</option><option>Retail</option><option>Grocery</option><option>Cleaning</option><option>Hospitality</option><option>Healthcare</option><option>Other</option></select></div>
      <div><label>New User Role</label><select id="new-business-user-role"><option value="owner">Owner</option><option value="manager">Manager</option></select></div>
      <div><label>New User Full Name</label><input id="new-business-user-name" placeholder="Full name"></div>
      <div><label>New User Email</label><input id="new-business-user-email" placeholder="owner@business.com"></div>
    </div>
    <button class="primary" onclick="createBusinessInviteFromOwner()">Invite Business Admin</button>
  </div>` : ""}
  <div class="panel email-settings-card">
    <div class="settings-title-row">
      <h3>Email Notifications</h3>
      <span class="status-pill ${c.enabled ? 'active' : 'paused'}">${c.enabled ? 'Active' : 'Paused'}</span>
    </div>
    <p class="small muted">Brevo sends notifications securely through the MySchedule Cloudflare Worker. The business owner's signup email is used automatically as Reply-To.</p>
    <div class="form-grid compact-settings">
      <div><label>Email Status</label><select id="email-enabled"><option value="false" ${!c.enabled?"selected":""}>Paused</option><option value="true" ${c.enabled?"selected":""}>Active</option></select></div>
      <div><label>Sender Name</label><input value="MySchedule Notification" disabled></div>
      <div style="grid-column:1/-1"><label>Cloudflare Worker URL</label><input id="email-worker-url" value="${attr(c.workerUrl || EMAILJS_DEFAULTS.workerUrl)}" placeholder="https://myschedule-email.example.workers.dev"></div>
    </div>
    <div class="notice oknotice" style="margin-top:12px">No Brevo API key is stored in this website. The key must remain only in Cloudflare as the <strong>BREVO_API_KEY</strong> secret.</div>
    <div class="actions" style="margin-top:14px">
      <button class="primary" onclick="saveEmailSettings()">Save Email Settings</button>
      <button onclick="sendTestToMe()" ${!c.enabled ? 'disabled title="Turn email notifications Active first"' : ''}>Send Test to My Email</button>
    </div>
  </div>`;
}

/* Employee views */
function employeeWorkView(){
  const user = currentUser();
  if(!user) return `<div class="panel"><h2>My Shifts</h2><p class="muted">Please sign in again to view your published shifts.</p></div>`;

  const weekEnd = addDays(rosterWeekStart, 7);
  const publishedAll = employeeVisibleShifts(user).sort(sortShift);
  const nowTime = new Date();
  const activePublished = publishedAll.filter(s => !isShiftGone(s, nowTime)).sort(sortShift);
  const pastPublished = publishedAll.filter(s => isShiftGone(s, nowTime)).sort(sortShift).reverse();
  const weekShifts = activePublished.filter(s => inDateRange(s, rosterWeekStart, weekEnd));
  const week = totalHours(weekShifts);
  const fortnightShifts = activePublished.filter(s => inDateRange(s, fortnightStart(new Date()), addDays(fortnightStart(new Date()), 14)));
  const fortnight = totalHours(fortnightShifts);
  const upcomingShifts = activePublished.filter(s => safeShiftDateTime(s) >= nowTime).sort(sortShift);
  const upcoming = upcomingShifts.length;
  const nextShift = upcomingShifts[0];
  const pendingRequests = state.requests.filter(r => r.employeeId === user.id && r.status === "pending");
  const unavailableRows = state.availability.filter(a => a.employeeId === user.id && a.status !== "rejected");
  const nextTitle = nextShift ? `${fullDayName(dateObj(nextShift.date))}, ${shortMonthDay(nextShift.date)}` : "No upcoming shift";
  const nextSub = nextShift ? `${esc(nextShift.start)} - ${esc(nextShift.end)} · ${shiftHours(nextShift).toFixed(1)} hrs` : "Your roster will appear here after it is published.";

  return `
  <section class="dashboard-apple employee-dashboard">
    <div class="dashboard-hero">
      <div>
        <span class="eyebrow">Employee workspace</span>
        <h2>My Shifts</h2>
        <p>Your published roster, requests, availability, and notifications in one clean view.</p>
      </div>
    </div>

    <button class="dashboard-focus-card ${nextShift ? "all-clear" : ""}" onclick="${nextShift ? "document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})" : "go('availability')"}">
      <div class="focus-icon">${nextShift ? "↗" : "✓"}</div>
      <div>
        <strong>${esc(nextTitle)}</strong>
        <span>${nextSub}</span>
      </div>
    </button>

    <div class="dashboard-smart-grid">
      <button class="smart-card" onclick="document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})">
        <span>This week</span><strong>${week.toFixed(1)} hrs</strong><em>${weekShifts.length} published shift${weekShifts.length === 1 ? "" : "s"}</em>
      </button>
      <button class="smart-card" onclick="document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})">
        <span>Fortnight</span><strong>${fortnight.toFixed(1)} hrs</strong><em>published hours</em>
      </button>
      <button class="smart-card ${pendingRequests.length ? "attention" : ""}" onclick="go('myrequests')">
        <span>Requests</span><strong>${pendingRequests.length || "Clear"}</strong><em>${pendingRequests.length ? "waiting approval" : "no pending items"}</em>
      </button>
      <button class="smart-card" onclick="go('availability')">
        <span>Availability</span><strong>${unavailableRows.length || "Open"}</strong><em>${unavailableRows.length ? "unavailable item" + (unavailableRows.length === 1 ? "" : "s") : "available by default"}</em>
      </button>
    </div>

    <div class="dashboard-two-col">
      <div class="apple-panel">
        <div class="apple-panel-head">
          <div><h3>Upcoming</h3><p>Your next published shifts only.</p></div>
          <button class="tiny" onclick="go('notifications')">Inbox</button>
        </div>
        ${employeeUpcomingList(upcomingShifts.slice(0,4))}
      </div>
      <div class="apple-panel">
        <div class="apple-panel-head">
          <div><h3>Quick actions</h3><p>Useful actions without clutter.</p></div>
        </div>
        ${employeeQuickActions(pendingRequests, nextShift)}
      </div>
    </div>

    <div class="apple-panel" id="my-published-schedule">
      <div class="apple-panel-head">
        <div><h3>My published schedule</h3><p>Only active and upcoming published shifts appear here. Completed shifts are kept in history.</p></div>
        <span class="status-pill">${upcoming} upcoming</span>
      </div>
      ${activePublished.length ? employeeShiftCardList(activePublished) : `<div class="apple-empty-mini"><strong>No active published shifts</strong><span>Past shifts are moved to history. New shifts will appear here after publishing.</span></div>`}
      ${employeePastShiftHistory(pastPublished)}
    </div>
  </section>`;
}

function employeeUpcomingList(rows){
  if(!rows.length) return `<div class="apple-empty-mini"><strong>No upcoming shifts</strong><span>You are clear for now.</span></div>`;
  return `<div class="employee-shift-list compact">${rows.map(s => employeeShiftCard(s, true)).join("")}</div>`;
}

function employeeQuickActions(pendingRequests, nextShift){
  const reqText = pendingRequests.length ? `${pendingRequests.length} request${pendingRequests.length === 1 ? "" : "s"} waiting for approval` : "No pending request";
  return `<div class="action-list">
    <button class="action-item" onclick="go('availability')"><span class="dot ${pendingRequests.length ? "warn" : ""}"></span><div><strong>Request unavailable time</strong><small>All days are available by default. Submit only unavailable date/time.</small></div><em>Open</em></button>
    <button class="action-item" onclick="go('myrequests')"><span class="dot ${pendingRequests.length ? "urgent" : ""}"></span><div><strong>My requests</strong><small>${esc(reqText)}</small></div><em>View</em></button>
    <button class="action-item" onclick="go('notifications')"><span class="dot"></span><div><strong>Notifications</strong><small>Open roster updates and approvals.</small></div><em>Inbox</em></button>
    ${nextShift ? `<button class="action-item" onclick="openChangeModal('${nextShift.id}')"><span class="dot"></span><div><strong>Request change</strong><small>For your next shift: ${esc(nextShift.start)} - ${esc(nextShift.end)}.</small></div><em>Ask</em></button>` : ``}
  </div>`;
}

function employeeShiftCardList(rows){
  return `<div class="employee-shift-list">${rows.map(s => employeeShiftCard(s, false)).join("")}</div>`;
}

function employeePastShiftHistory(rows){
  if(!rows.length) return "";
  return `<details class="history-fold employee-history-fold">
    <summary>Previous shifts <span>${rows.length}</span></summary>
    <div class="employee-shift-list history-list">${rows.slice(0,12).map(s => employeeShiftCard(s, false, true)).join("")}</div>
    ${rows.length > 12 ? `<p class="small muted">Showing latest 12 completed shifts.</p>` : ""}
  </details>`;
}

function employeeShiftCard(s, compact, past=false){
  const d = dateObj(s.date);
  const gone = past || isShiftGone(s);
  const canManage = !compact && !gone;
  return `<div class="employee-shift-row ${gone ? "is-past" : ""}">
    <div class="employee-date-badge"><strong>${shortWeekday(d)}</strong><span>${shortMonthDay(s.date)}</span></div>
    <div class="employee-shift-main">
      <strong>${esc(s.start)} - ${esc(s.end)}</strong>
      <span>${shiftHours(s).toFixed(1)} hrs${s.notes ? " · " + esc(s.notes) : ""}</span>
    </div>
    ${compact ? `<span class="status-pill ${s.status}">${esc(s.status)}</span>` : canManage ? `<details class="action-menu"><summary>Manage</summary><div class="action-menu-list"><button onclick="openChangeModal('${s.id}')">Request Change</button><button onclick="openSwapModal('${s.id}')">Request Swap</button></div></details>` : `<span class="status-pill muted-pill">Completed</span>`}
  </div>`;
}

function employeeShiftsView(){
  return employeeWorkView();
}

function shiftDetailsCard(shiftId){
  const s = state.shifts.find(x => x.id === shiftId);
  if(!s) return `<div class="notice warnnotice">Selected shift details were not found.</div>`;
  const u = state.users.find(x => x.id === s.employeeId);
  return `<div class="request-shift-card">
    <strong>Selected shift</strong><br>
    <span>${friendlyDate(s.date)}</span><br>
    <span>${esc(s.start)} - ${esc(s.end)} · ${shiftHours(s).toFixed(1)} hrs</span><br>
    <span>${esc(u ? u.name : "Unassigned")} · ${esc(s.role || "Shift")} · ${esc(s.status || "draft")}</span>
    ${s.notes ? `<br><span class="small muted">Notes: ${esc(s.notes)}</span>` : ""}
  </div>`;
}
function requestSnapshotText(r){
  const s = state.shifts.find(x => x.id === r.shiftId);
  const a = state.availability.find(x => x.id === r.availabilityId);
  if(s) return `${friendlyDate(s.date)}<br>${esc(s.start)}-${esc(s.end)} · ${shiftHours(s).toFixed(1)} hrs<br><span class="small muted">${esc(s.role || "Shift")} · ${esc(s.status || "")}</span>`;
  if(a) return `${a.date ? esc(friendlyDate(a.date)) : esc(a.day)}<br>${esc(a.start)}-${esc(a.end)}<br><span class="small muted">Unavailable${a.requestAction === "remove" ? " removal" : ""}${a.reason ? " • " + esc(a.reason) : ""}</span><br><span class="small muted">Submitted: ${friendlyDate((r.createdAt || a.createdAt || now()).slice(0,10))}</span>`;
  if(r.shiftSnapshot) return `${esc(r.shiftSnapshot.day || "")}<br>${esc(r.shiftSnapshot.date || "")}<br>${esc(r.shiftSnapshot.time || "")}`;
  return "-";
}
function requestStatusFlags(r, managerMode){
  const u = currentUser();
  const unread = u && Array.isArray(r.seenBy) ? !r.seenBy.includes(u.id) : true;
  const needsAction = managerMode && r.status === "pending";
  const labels = [];
  if(unread) labels.push(`<span class="badge new">New</span>`);
  if(needsAction) labels.push(`<span class="badge action-needed">Action needed</span>`);
  return labels.join(" ") || `<span class="small muted">No action</span>`;
}
function markRequestRead(id){
  const r = state.requests.find(x => x.id === id);
  const u = currentUser();
  if(r && u){ if(!Array.isArray(r.seenBy)) r.seenBy = []; if(!r.seenBy.includes(u.id)) r.seenBy.push(u.id); saveState(); renderContent(); }
}
function markRequestSeenOnly(id){
  const r = state.requests.find(x => x.id === id);
  const u = currentUser();
  if(r && u){
    if(!Array.isArray(r.seenBy)) r.seenBy = [];
    if(!r.seenBy.includes(u.id)) r.seenBy.push(u.id);
    saveState();
  }
}

function availabilityView(){
  const user = currentUser();
  const rows = state.availability.filter(a => a.employeeId === user.id);
  return `
  <div class="panel-head"><div><h2>My Availability</h2><p class="muted">All days are available by default. Submit only dates/times when you are unavailable.</p></div><button class="primary" onclick="openAvailabilityModal()">Request Unavailable</button></div>
  <div class="notice oknotice">Approved unavailable dates block managers from adding, moving, copying or publishing overlapping shifts.</div>
  <div class="panel">${availabilityTable(rows)}</div>`;
}

function requestsView(managerMode){
  const allRows = managerMode
    ? state.requests.filter(r => r.businessId === business().id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
    : state.requests.filter(r => r.employeeId === currentUser().id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const currentRows = allRows.filter(r => r.status === "pending");
  const completedCount = allRows.length - currentRows.length;
  const title = managerMode ? "Current Requests" : "My Current Requests";
  return `<section class="apple-requests-page">
    <div class="apple-request-hero">
      <div>
        <p class="eyebrow">Action centre</p>
        <h2>${title}</h2>
        <p class="muted">Only active requests are shown here. Approved, rejected, and old requests stay hidden unless you open history.</p>
      </div>
      ${currentRows.length ? `<span class="apple-count-bubble">${currentRows.length}</span>` : `<span class="apple-clear-bubble">Clear</span>`}
    </div>
    ${currentRows.length ? requestsCards(currentRows, managerMode) : `<div class="apple-empty-state"><div class="apple-empty-icon">✓</div><h3>No current requests</h3><p class="muted">New availability, change, and swap requests will appear here when someone submits them.</p></div>`}
    ${completedCount ? `<details class="apple-history"><summary>Show request history (${completedCount})</summary>${requestsCards(allRows.filter(r => r.status !== "pending"), managerMode, true)}</details>` : ``}
  </section>`;
}

function clockView(){
  const user = currentUser();
  const active = state.timesheets.find(t => t.employeeId === user.id && !t.clockOut);
  const rows = state.timesheets.filter(t => t.employeeId === user.id).sort((a,b)=>b.clockIn.localeCompare(a.clockIn));
  return `
  <h2>Clock In/Out</h2>
  <div class="panel">
    ${active ? `<div class="notice oknotice">Clocked in since ${dateTime(active.clockIn)}</div><button class="danger" onclick="clockOut()">Clock Out</button>` : `<button class="primary" onclick="clockIn()">Clock In</button>`}
  </div>
  <div class="panel">${timesheetTable(rows)}</div>`;
}

function myHoursView(){
  return employeeWorkView();
}


function profileView(){
  const user = currentUser();
  const b = business();
  return `
  <div class="panel-head">
    <div>
      <h2>My Profile</h2>
      <p class="muted">Update your name, phone, photo, and notification details. Changes sync live to the owner/manager view.</p>
    </div>
    <button class="primary" onclick="saveProfile()">Save Profile</button>
  </div>
  <div class="profile-grid">
    <div class="panel profile-card">
      ${profileAvatar(user, 'large')}
      <h3>${esc(user.name)}</h3>
      <p class="muted">${esc(user.email)}</p>
      <span class="badge ${user.role}">${user.role.toUpperCase()}</span>
      <p class="small muted">Workspace: ${esc(b?.name || 'MySchedule')}</p>
    </div>
    <div class="panel">
      <h3>Personal details</h3>
      <div class="form-grid">
        <div><label>Full Name</label><input id="profile-name" value="${attr(user.name || '')}"></div>
        <div><label>Phone</label><input id="profile-phone" value="${attr(user.phone || '')}" placeholder="Mobile number"></div>
        <div><label>Email / Login</label><input id="profile-email" value="${attr(user.email || '')}" placeholder="email@example.com"></div>
        <div><label>Role</label><input value="${attr(user.role || '')}" disabled></div>
      </div>
      <label>Profile Photo</label>
      <input id="profile-photo" type="file" accept="image/*" onchange="previewProfilePhoto(event)">
      <input id="profile-photo-data" type="hidden" value="${attr(user.photoData || '')}">
      <p class="small muted">Photo is saved to the cloud profile record. Use a small clear photo for best speed.</p>
      <div class="actions" style="margin-top:14px">
        <button class="primary" onclick="saveProfile()">Save Profile</button>
        <button onclick="sendMyPasswordReset()">Send Password Reset Link</button>
      </div>
      <div class="notice oknotice">Security: changing login email may require a fresh sign-in and email verification from Firebase.</div>
    </div>
  </div>`;
}

function profileAvatar(user, size='small'){
  const cls = size === 'large' ? 'avatar avatar-large' : 'avatar';
  if(user && user.photoData) return `<img class="${cls}" src="${attr(user.photoData)}" alt="Profile photo">`;
  const initials = String(user?.name || user?.email || 'MS').trim().split(/\s+/).slice(0,2).map(x=>x[0]||'').join('').toUpperCase() || 'MS';
  return `<div class="${cls}">${esc(initials)}</div>`;
}

function previewProfilePhoto(event){
  const file = event.target.files && event.target.files[0];
  if(!file) return;
  if(file.size > 700000) return toast('Please choose a smaller photo under 700 KB.');
  const reader = new FileReader();
  reader.onload = () => {
    const hidden = el('profile-photo-data');
    if(hidden) hidden.value = reader.result;
    const card = document.querySelector('.profile-card');
    if(card){
      const av = card.querySelector('.avatar, img.avatar');
      if(av) av.outerHTML = `<img class="avatar avatar-large" src="${attr(reader.result)}" alt="Profile photo">`;
    }
  };
  reader.readAsDataURL(file);
}

async function saveProfile(){
  const user = currentUser();
  if(!user) return;
  const oldName = user.name || '';
  const oldPhone = user.phone || '';
  const oldPhoto = user.photoData || '';
  const oldEmail = normalizeEmail(user.email);
  const newName = cleanText(val('profile-name'));
  const newPhone = cleanText(val('profile-phone'));
  const newEmail = normalizeEmail(val('profile-email'));
  const photoData = el('profile-photo-data') ? el('profile-photo-data').value : (user.photoData || '');
  if(!newName || !isValidEmail(newEmail)) return toast('Enter a valid name and email.');
  const changedFields = [];
  if(newName !== oldName) changedFields.push(`Name: ${oldName || 'blank'} → ${newName}`);
  if(newPhone !== oldPhone) changedFields.push(`Phone: ${oldPhone || 'blank'} → ${newPhone || 'blank'}`);
  if(newEmail !== oldEmail) changedFields.push(`Email/login: ${oldEmail || 'blank'} → ${newEmail}`);
  if(photoData !== oldPhoto) changedFields.push(photoData ? 'Profile photo updated' : 'Profile photo removed');
  if(!changedFields.length) return toast('No profile changes to save.');
  try{
    const auth = requireAuth();
    const authUser = auth.currentUser;
    if(!authUser || authUser.uid !== user.authUid) return toast('For security, please sign in again before changing profile details.');
    await authUser.updateProfile({displayName:newName, photoURL: photoData || null}).catch(()=>{});
    let emailChanged = false;
    if(newEmail !== oldEmail){
      emailChanged = true;
      if(authUser.verifyBeforeUpdateEmail){
        await authUser.verifyBeforeUpdateEmail(newEmail, {url: window.location.href.split('#')[0]});
      }else{
        await authUser.updateEmail(newEmail);
        await authUser.sendEmailVerification({url: window.location.href.split('#')[0]}).catch(()=>{});
      }
    }
    user.name = newName;
    user.phone = newPhone;
    user.photoData = photoData;
    if(!emailChanged || !authUser.verifyBeforeUpdateEmail){ user.email = newEmail; }
    user.updatedAt = now();
    const details = changedFields.join('; ');
    notifyUser(user.id, 'profile', 'Your MySchedule profile was updated', `Your profile was updated. Changes: ${details}`);
    notifyProfileAdmins(user, details);
    saveState();
    render();
    toast(emailChanged && authUser.verifyBeforeUpdateEmail ? 'Profile saved. Confirm the email-change link before the new email becomes your login.' : 'Profile saved and synced.');
  }catch(e){
    console.warn(e);
    toast(firebaseErrorMessage(e));
  }
}

async function sendMyPasswordReset(){
  const user = currentUser();
  if(!user) return;
  try{
    const auth = requireAuth();
    await auth.sendPasswordResetEmail(normalizeEmail(user.email), {url: window.location.href.split('#')[0]});
    toast('Password reset link sent to your email.');
  }catch(e){
    console.warn(e);
    toast(firebaseErrorMessage(e));
  }
}

function notificationsView(filter="all"){
  const user = currentUser();
  const allRows = state.notifications.filter(n => n.userId === user.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const rows = filter === "action" ? allRows.filter(notificationNeedsAction) : allRows;
  const unread = allRows.filter(n => !n.read).length;
  const action = allRows.filter(notificationNeedsAction).length;
  const historyRows = notificationHistoryForUser(user).slice(0,6);
  return `
  <section class="apple-notification-page simple-inbox apple-clean-page">
    <div class="apple-notification-hero simple-hero compact-hero">
      <div>
        <p class="eyebrow">Inbox</p>
        <h2>Notifications</h2>
        <p class="muted">Clear messages, quick actions, and saved history when you need details later.</p>
      </div>
      ${action ? `<span class="apple-count-bubble">${action} need attention</span>` : unread ? `<span class="apple-count-bubble">${unread} new</span>` : `<span class="apple-clear-bubble">All clear</span>`}
    </div>

    <div class="apple-inbox-toolbar simple-toolbar clean-toolbar">
      <div class="apple-segment" role="tablist" aria-label="Notification filters">
        <button class="${filter === "all" ? "active" : ""}" type="button" onclick="showAllNotifications()">All</button>
        <button class="${filter === "action" ? "active" : ""}" type="button" onclick="showActionNeededOnly()">Action needed</button>
      </div>
      <div class="actions apple-soft-actions">
        <button onclick="markAllRead()">Mark read</button>
        <button onclick="clearMine()">Clear all</button>
      </div>
    </div>

    <div id="notificationListHost">${myNotificationsCards(rows)}</div>
    ${historyRows.length ? `<details class="apple-history notification-history"><summary>Cleared history</summary>${notificationHistoryCards(historyRows)}</details>` : ``}
  </section>`;
}

/* Tables */
function usersTable(users){
  return `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Role</th><th>Status</th><th>Limit</th><th>Action</th></tr></thead><tbody>
  ${users.map(u=>{
    const emp = state.employees.find(e => e.userId === u.id);
    return `<tr>
      <td><div class="table-user">${profileAvatar(u)}<span>${esc(u.name)}</span></div></td><td><span class="email-text">${esc(u.email)}</span></td><td>${esc(u.phone || "-")}</td><td><span class="badge ${u.role}">${u.role}</span></td><td>${u.status}</td>
      <td>${emp ? `${emp.fortnightLimit} hrs/fortnight` : "-"}</td>
      <td class="actions">
        ${u.role !== "owner" && currentUser().role === "owner" ? `<button class="danger" onclick="removeUser('${u.id}')">Remove</button>` : "-"}
        ${u.role !== "owner" ? `<button onclick="resendInvite('${u.id}')">Resend Account Email</button>` : ""}
      </td>
    </tr>`;
  }).join("")}</tbody></table></div>`;
}

function shiftsTable(shifts, managerMode){
  return `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Time</th><th>Employee</th><th>Role</th><th>Status</th><th>Notes</th><th>Actions</th></tr></thead><tbody>
  ${shifts.map(s=>{
    const u = state.users.find(u => u.id === s.employeeId);
    const d = dateObj(s.date);
    return `<tr>
      <td><strong>${fullDayName(d)}</strong><br><span class="small muted">${s.date}</span></td><td>${s.start} - ${s.end}<br><span class="small muted">${shiftHours(s).toFixed(1)} hrs</span></td>
      <td>${u ? esc(u.name) : "Unassigned"}</td><td>${esc(s.role)}</td><td><span class="badge ${s.status}">${s.status}</span></td><td>${esc(s.notes || "")}</td>
      <td>${managerMode ? `<div class="actions"><button onclick="openShiftModal('${s.id}')">Edit</button><button class="danger" onclick="deleteShift('${s.id}')">Delete</button></div>` : `
        <details class="action-menu"><summary>Manage</summary><div class="action-menu-list">
          <button onclick="openChangeModal('${s.id}')">Request Change</button>
          <button onclick="openSwapModal('${s.id}')">Request Swap</button>
        </div></details>`}
      </td></tr>`;
  }).join("") || `<tr><td colspan="7">No shifts found.</td></tr>`}</tbody></table></div>`;
}

function requestShortMessage(r){
  if(r.type === "availability"){
    const a = state.availability.find(x => x.id === r.availabilityId);
    if(a) return `${userName(r.employeeId)} is unavailable on ${a.date ? friendlyDate(a.date) : a.day}, ${a.start}-${a.end}${a.reason ? " • " + a.reason : ""}.`;
  }
  if(r.type === "swap") return `${userName(r.employeeId)} requested a shift swap.`;
  if(r.type === "change") return `${userName(r.employeeId)} requested a shift change.`;
  return r.message || "Request received.";
}
function requestDateLine(r){
  const s = state.shifts.find(x => x.id === r.shiftId);
  const a = state.availability.find(x => x.id === r.availabilityId);
  if(s) return `${friendlyDate(s.date)} · ${esc(s.start)}-${esc(s.end)}`;
  if(a) return `${esc(a.day)} · ${esc(a.start)}-${esc(a.end)}`;
  if(r.shiftSnapshot) return `${esc(r.shiftSnapshot.day || "")} · ${esc(r.shiftSnapshot.date || "")} · ${esc(r.shiftSnapshot.time || "")}`;
  return dateTime(r.createdAt);
}
function requestDetailModal(id){
  const r = state.requests.find(x => x.id === id);
  if(!r) return toast("Request not found.");
  markRequestSeenOnly(id);
  const managerMode = isManagerial(currentUser());
  modal(`<h3>${esc(requestTypeLabel(r))}</h3>
    <div class="apple-modal-summary">
      <strong>${esc(requestShortMessage(r))}</strong>
      <span>${requestDateLine(r)}</span>
      <span>Requested ${dateTime(r.createdAt)} by ${esc(userName(r.employeeId))}</span>
    </div>
    <label>Message</label>
    <div class="readable-message">${esc(r.message || "No extra message.")}${r.targetEmployeeId ? `<br><span class="small muted">Swap with: ${esc(userName(r.targetEmployeeId))}</span>` : ""}</div>
    <div class="actions" style="margin-top:14px">
      ${managerMode && r.status === "pending" ? `<button class="success" onclick="approveRequest('${r.id}'); closeModal();">Approve</button><button class="danger" onclick="rejectRequest('${r.id}'); closeModal();">Reject</button>` : ``}
      <button onclick="closeModal()">Close</button>
    </div>`);
}
function requestsCards(rows, managerMode, history=false){
  return `<div class="apple-request-list ${history ? "is-history" : ""}">
  ${rows.map(r=>{
    const flags = requestStatusFlags(r, managerMode);
    const isNew = flags.includes("New");
    return `<article class="apple-request-card ${isNew ? "is-new" : ""} ${r.status === "pending" ? "is-current" : ""}" onclick="requestDetailModal('${r.id}')">
      <div class="apple-request-main">
        <div class="apple-request-title-row">
          <h3>${esc(requestTypeLabel(r))}</h3>
          <span class="badge ${r.status}">${esc(r.status)}</span>
        </div>
        <p>${esc(requestShortMessage(r))}</p>
        <span class="apple-note-meta">${requestDateLine(r)}</span>
      </div>
      <div class="apple-request-side">
        ${isNew ? `<span class="ios-badge new-dot">New</span>` : ``}
        ${managerMode && r.status === "pending" ? `<span class="ios-badge action-dot">Action needed</span>` : ``}
        <button class="tiny apple-link-button" onclick="event.stopPropagation(); requestDetailModal('${r.id}')">Open</button>
      </div>
    </article>`;
  }).join("")}
  </div>`;
}
function requestsTable(rows, managerMode){
  return requestsCards(rows, managerMode);
}

function availabilityTable(rows){
  const sorted = [...rows].sort((a,b)=>String(a.date||"").localeCompare(String(b.date||"")) || String(a.start||"").localeCompare(String(b.start||"")));
  return `<div class="table-wrap"><table><thead><tr><th>Date / Day</th><th>Time</th><th>Reason</th><th>Approval</th><th>Action</th></tr></thead><tbody>
  ${sorted.map(a => `<tr><td><strong>${a.date ? esc(friendlyDate(a.date)) : esc(a.day || "Every matching day")}</strong><br><span class="small muted">Unavailable</span></td><td>${esc(a.start)}-${esc(a.end)}</td><td>${esc(a.reason || a.notes || "Unavailable")}</td><td><span class="badge ${a.status || "pending"}">${availabilityStatusLabel(a)}</span></td><td><button class="danger" onclick="deleteAvailability('${a.id}')">${a.status === "approved" ? "Request Remove" : "Delete"}</button></td></tr>`).join("") || `<tr><td colspan="5"><strong>Available by default.</strong><br><span class="muted">No unavailable dates have been submitted.</span></td></tr>`}
  </tbody></table></div>`;
}

function timesheetTable(rows){
  return `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Clock In</th><th>Clock Out</th><th>Hours</th></tr></thead><tbody>
  ${rows.map(t=>{
    const hrs = t.clockOut ? ((new Date(t.clockOut)-new Date(t.clockIn))/3600000).toFixed(2) : "-";
    return `<tr><td>${esc(userName(t.employeeId))}</td><td>${dateTime(t.clockIn)}</td><td>${t.clockOut ? dateTime(t.clockOut) : "Still clocked in"}</td><td>${hrs}</td></tr>`;
  }).join("") || `<tr><td colspan="4">No timesheets.</td></tr>`}</tbody></table></div>`;
}

function alertsTable(alerts){
  return `<div class="table-wrap"><table><thead><tr><th>Severity</th><th>Employee</th><th>Alert</th></tr></thead><tbody>
  ${alerts.map(a => `<tr><td><span class="badge ${a.severity}">${a.severity}</span></td><td>${esc(a.employee)}</td><td>${esc(a.message)}</td></tr>`).join("") || `<tr><td colspan="3">No alerts.</td></tr>`}
  </tbody></table></div>`;
}

function deliveryLogTable(){
  const rows = state.notifications.filter(n => n.businessId === business().id).slice(-25).reverse();
  return `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Recipient Email</th><th>Name</th><th>Source</th><th>Type</th><th>Email Status</th><th>Error</th><th>Subject</th><th>Debug</th></tr></thead><tbody>
  ${rows.map(n => `<tr><td>${dateTime(n.createdAt)}</td><td><strong>${esc(n.to)}</strong></td><td>${esc(n.toName || "")}</td><td>${esc(n.recipientSource || "user_profile_email")}</td><td>${esc(n.type)}</td><td>${emailStatusLabel(n.emailStatus)}</td><td>${esc(n.emailError || "")}</td><td>${esc(n.subject)}</td><td><button class="tiny" onclick="showEmailDebug('${n.id}')">View</button></td></tr>`).join("") || `<tr><td colspan="9">No notifications yet.</td></tr>`}
  </tbody></table></div>`;
}

function notificationPriority(n){
  if(!n.read) return `<span class="badge new">New</span> <span class="badge action-needed">Action needed</span>`;
  return `<span class="small muted">Read</span>`;
}
function notificationNeedsAction(n){
  const t = String(n.type || "").toLowerCase();
  const subject = String(n.originalSubject || n.subject || "").toLowerCase();
  const msg = String(n.originalMessage || n.message || "").toLowerCase();
  return !n.read || t.includes("request") || subject.includes("request") || msg.includes("approve") || msg.includes("action");
}
function notificationTone(n){
  const text = `${n.type || ""} ${n.originalSubject || n.subject || ""} ${n.originalMessage || n.message || ""}`.toLowerCase();
  if(text.includes("approved") || text.includes("published")) return "success";
  if(text.includes("reject") || text.includes("decline") || text.includes("error")) return "danger";
  if(notificationNeedsAction(n)) return "action";
  return "info";
}
function notificationIcon(n){
  const tone = notificationTone(n);
  if(tone === "success") return "✓";
  if(tone === "danger") return "!";
  if(tone === "action") return "•";
  return "i";
}
function notificationActionLabel(n){
  if(n.requestId) return "Open request";
  if(String(n.type || "").includes("schedule")) return "Open schedule";
  if(["request","availability","approval","swap"].includes(String(n.type || ""))) return "Open related";
  return "Open";
}
function findRelatedRequestForNotification(n){
  if(n.requestId) return state.requests.find(r => r.id === n.requestId);
  const user = currentUser();
  const rows = isManagerial(user)
    ? state.requests.filter(r => r.businessId === user.businessId && r.status === "pending")
    : state.requests.filter(r => r.employeeId === user.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  const text = `${n.type || ""} ${n.originalSubject || n.subject || ""} ${n.originalMessage || n.message || ""}`.toLowerCase();
  if(text.includes("availability")) return rows.find(r => r.type === "availability") || rows[0];
  if(text.includes("swap")) return rows.find(r => r.type === "swap") || rows[0];
  if(text.includes("change")) return rows.find(r => r.type === "change") || rows[0];
  if(text.includes("request") || text.includes("approval")) return rows[0];
  return null;
}
function openNotification(id){
  const n = state.notifications.find(x => x.id === id);
  if(!n) return toast("Notification not found.");
  n.read = true;
  saveState();
  const related = findRelatedRequestForNotification(n);
  if(related){ requestDetailModal(related.id); return; }
  if(String(n.type || "").includes("schedule") || String(n.originalSubject || n.subject || "").toLowerCase().includes("schedule")){
    go(currentUser().role === "employee" ? "myshifts" : "roster");
    return;
  }
  modal(`<h3>${esc(n.originalSubject || n.subject || "Notification")}</h3>
    <div class="apple-modal-summary"><span>${friendlyDate((n.createdAt || now()).slice(0,10))}</span></div>
    <div class="readable-message">${esc(n.originalMessage || n.message || "")}</div>
    <div class="actions" style="margin-top:14px"><button onclick="closeModal()">Close</button></div>`);
}
function myNotificationsCards(rows){
  if(!rows.length) return `<div class="apple-empty-state"><div class="apple-empty-icon">✓</div><h3>All clear</h3><p class="muted">No notifications in this view.</p></div>`;
  return `<div class="apple-notification-list simple-list">
  ${rows.map(n => {
    const title = esc(n.originalSubject || n.subject || "Notification");
    const message = esc(n.originalMessage || n.message || "");
    const created = n.createdAt || now();
    const tone = notificationTone(n);
    return `<article class="apple-note-card simple-note ${n.read ? "is-read" : "is-new"} tone-${tone}" onclick="openNotification('${n.id}')">
      <div class="apple-note-dot"></div>
      <div class="apple-note-main">
        <div class="apple-note-top">
          <div>
            <h3>${title}</h3>
            <p class="apple-note-meta">${friendlyDate(created.slice(0,10))}</p>
          </div>
          ${!n.read ? `<span class="ios-badge new-dot">New</span>` : ``}
        </div>
        <p class="apple-note-message">${message}</p>
        <div class="apple-note-footer simple-footer">
          <button class="tiny apple-link-button" onclick="event.stopPropagation(); openNotification('${n.id}')">${notificationActionLabel(n)}</button>
          <button class="tiny apple-clear-button" onclick="event.stopPropagation(); clearNotification('${n.id}')">Clear</button>
        </div>
      </div>
    </article>`;
  }).join("")}
  </div>`;
}

function showAllNotifications(){
  currentView = "notifications";
  const host = document.getElementById("notificationListHost");
  const user = currentUser();
  const rows = state.notifications.filter(n => n.userId === user.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  if(host) host.innerHTML = myNotificationsCards(rows); else renderContent();
  document.querySelectorAll(".apple-segment button").forEach(btn => btn.classList.remove("active"));
  const first = document.querySelector(".apple-segment button:first-child");
  if(first) first.classList.add("active");
}

function showActionNeededOnly(){
  currentView = "notifications";
  const host = document.getElementById("notificationListHost");
  const user = currentUser();
  const rows = state.notifications.filter(n => n.userId === user.id && notificationNeedsAction(n)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  if(host) host.innerHTML = myNotificationsCards(rows); else renderContent();
  document.querySelectorAll(".apple-segment button").forEach(btn => btn.classList.remove("active"));
  const second = document.querySelector(".apple-segment button:nth-child(2)");
  if(second) second.classList.add("active");
}

function notificationHistoryForUser(user){
  return (state.notificationHistory || []).filter(n => n.userId === user.id).sort((a,b)=>(b.clearedAt || b.createdAt || "").localeCompare(a.clearedAt || a.createdAt || ""));
}
function notificationHistoryCards(rows){
  return `<div class="history-list">${rows.map(n => `<div class="history-row"><div><strong>${esc(n.originalSubject || n.subject || "Notification")}</strong><small>${esc(n.historyCategory || "Notification")} • ${dateTime(n.clearedAt || n.createdAt || now())}</small></div><button class="tiny" onclick="showHistoryNotification('${n.historyId || n.id}')">Details</button></div>`).join("")}</div>`;
}
function notificationHistoryCategory(n){
  const text = `${n.type || ""} ${n.originalSubject || n.subject || ""} ${n.originalMessage || n.message || ""}`.toLowerCase();
  if(text.includes("availability")) return "Availability";
  if(text.includes("swap")) return "Shift swap";
  if(text.includes("change")) return "Shift change";
  if(text.includes("schedule") || text.includes("roster") || text.includes("published")) return "Schedule";
  if(text.includes("email")) return "Email delivery";
  return "General";
}
function archiveNotification(n){
  if(!n) return;
  if(!Array.isArray(state.notificationHistory)) state.notificationHistory = [];
  const archived = {...n, historyId: uid(), clearedAt: now(), historyCategory: notificationHistoryCategory(n)};
  state.notificationHistory.unshift(archived);
  state.notificationHistory = state.notificationHistory.slice(0, 250);
}
function clearNotification(id){
  const idx = state.notifications.findIndex(n => n.id === id);
  if(idx < 0) return toast("Notification not found.");
  archiveNotification(state.notifications[idx]);
  state.notifications.splice(idx, 1);
  saveState();
  renderContent();
}
function showHistoryNotification(historyId){
  const n = (state.notificationHistory || []).find(x => x.historyId === historyId || x.id === historyId);
  if(!n) return toast("History item not found.");
  modal(`<h3>${esc(n.originalSubject || n.subject || "Notification")}</h3>
    <div class="apple-modal-summary"><strong>${esc(n.historyCategory || "Notification")}</strong><span>Cleared ${dateTime(n.clearedAt || now())}</span></div>
    <div class="readable-message">${esc(n.originalMessage || n.message || "")}</div>
    <div class="actions" style="margin-top:14px"><button onclick="closeModal()">Close</button></div>`);
}

function employeeHoursSummaryTable(shifts){
  const map = {};
  shifts.forEach(s => {
    if(!map[s.employeeId]) map[s.employeeId] = {hours:0,count:0};
    map[s.employeeId].hours += shiftHours(s);
    map[s.employeeId].count += 1;
  });
  const rows = Object.entries(map).map(([id,data])=>{
    const emp = state.employees.find(e => e.userId === id);
    const status = emp && data.hours > emp.weeklyLimit ? `<span class="badge medium">Above weekly alert</span>` : `<span class="badge low">OK</span>`;
    return `<tr><td>${esc(userName(id))}</td><td>${data.count}</td><td>${data.hours.toFixed(1)}</td><td>${emp ? emp.weeklyLimit : "-"}</td><td>${status}</td></tr>`;
  }).join("");
  return `<div class="table-wrap"><table><thead><tr><th>Employee</th><th>Shifts</th><th>Week Hours</th><th>Weekly Limit</th><th>Status</th></tr></thead><tbody>${rows || `<tr><td colspan="5">No hours this week.</td></tr>`}</tbody></table></div>`;
}

/* Schedule board */
function scheduleBoard(shifts){
  const days = Array.from({length:7},(_,i)=>addDays(rosterWeekStart,i));
  return `<div class="schedule-scroll-shell"><div class="schedule-board">
    ${days.map(day=>{
      const date = isoDate(day);
      const rows = shifts.filter(s => s.date === date);
      return `<div class="day-column" ondragover="allowDrop(event)" ondragleave="dragLeave(event)" ondrop="dropShift(event,'${date}')">
        <div class="day-head"><div><strong>${dayName(day)}</strong><br><span>${shortDate(day)}</span></div><div class="day-hours">${totalHours(rows).toFixed(1)} hrs</div></div>
        <button class="tiny full" onclick="openShiftModal('', '${date}')">+ Add</button>
        <div class="shift-cards">${rows.map(scheduleCard).join("") || `<div class="empty-shift">Drop shift here</div>`}</div>
      </div>`;
    }).join("")}
  </div></div>`;
}

function focusRosterBoard(){
  const board = document.querySelector(".schedule-scroll-shell");
  if(board) board.scrollIntoView({behavior:"smooth", block:"start"});
}

function scheduleCard(s){
  return `<div class="shift-card ${s.status}" draggable="true" ondragstart="dragShift(event,'${s.id}')" title="Drag to another day">
    <div class="shift-time">${s.start} - ${s.end}</div>
    <div><strong>${esc(userName(s.employeeId))}</strong></div>
    <div class="small muted">${esc(s.role)} • ${shiftHours(s).toFixed(1)} hrs</div>
    <div><span class="badge ${s.status}">${s.status}</span></div>
    <div class="actions" style="margin-top:8px">
      <button class="tiny" onclick="openShiftModal('${s.id}')">Edit</button>
      <button class="tiny" onclick="duplicateShift('${s.id}')">Copy</button>
      <button class="tiny" onclick="copyShiftNextDay('${s.id}')">+1 Day</button>
      <button class="tiny ghost" onclick="markReady('${s.id}')">Ready</button>
      <button class="tiny danger" onclick="deleteShift('${s.id}')">Delete</button>
    </div>
  </div>`;
}

/* Modals */
function openShiftModal(id="", presetDate=""){
  const b = business();
  const shift = id ? state.shifts.find(s => s.id === id) : null;
  const employees = state.users.filter(u => u.businessId === b.id && u.role === "employee" && u.status === "active");
  if(employees.length === 0) return toast("Add an employee first.");
  modal(`
    <h3>${shift ? "Edit" : "Add"} Shift</h3>
    <div class="form-grid">
      <div><label>Employee</label><select id="m-emp">${employees.map(e => `<option value="${e.id}" ${shift?.employeeId===e.id?"selected":""}>${esc(e.name)}</option>`).join("")}</select></div>
      <div><label>Date</label><input id="m-date" type="date" value="${shift?.date || presetDate || isoDate(new Date())}"></div>
      <div><label>Start</label><input id="m-start" type="time" value="${shift?.start || "09:00"}"></div>
      <div><label>End</label><input id="m-end" type="time" value="${shift?.end || "17:00"}"></div>
      <div><label>Break Minutes</label><input id="m-break" type="number" min="0" value="${shift?.breakMinutes || 0}"></div>
      <div><label>Status</label><select id="m-status"><option value="draft" ${shift?.status==="draft"?"selected":""}>Draft / Not sent</option><option value="published" ${shift?.status==="published"?"selected":""}>Published locally</option><option value="confirmed" ${shift?.status==="confirmed"?"selected":""}>Confirmed</option></select></div>
      <div><label>Role</label><input id="m-role" value="${attr(shift?.role || "Team Member")}"></div>
      <div><label>Location</label><input id="m-loc" value="${attr(shift?.location || "Main Store")}"></div>
    </div>
    <label>Notes</label><textarea id="m-notes">${esc(shift?.notes || "")}</textarea>
    <div class="actions" style="margin-top:14px"><button class="primary" onclick="saveShift('${id}')">Save Shift</button><button onclick="closeModal()">Cancel</button></div>
  `);
}

function openUserModal(){
  const owner = currentUser().role === "owner";
  modal(`
    <h3>Add User</h3>
    <p class="muted">The user will receive account setup instructions. You do not create or see their password.</p>
    <div class="form-grid">
      <div><label>Name</label><input id="u-name" placeholder="Full name"></div>
      <div><label>Email</label><input id="u-email" placeholder="employee@email.com"></div>
      <div><label>Role</label><select id="u-role">${owner ? `<option value="manager">Manager</option>` : ""}<option value="employee">Employee</option></select></div>
      <div><label>Hire date</label><input id="u-hire-date" type="date" value="${isoDate(new Date())}"></div>
      <div><label>Employment Type</label><select id="u-type"><option>casual</option><option>part-time</option><option>full-time</option></select></div>
      <div><label>Default Duty</label><input id="u-duty" value="Team Member"></div>
      <div><label>Weekly Alert Limit</label><input id="u-weekly" type="number" value="30"></div>
      <div><label>Fortnight Alert Limit</label><input id="u-fortnight" type="number" value="48"></div>
    </div>
    <div class="actions" style="margin-top:14px"><button class="primary" onclick="saveUser()">Send Account Setup</button><button onclick="closeModal()">Cancel</button></div>
  `);
}

function canEmployeeActOnShift(shiftId){
  const user = currentUser();
  const s = state.shifts.find(x => x.id === shiftId);
  if(!user || !s) return {ok:false, message:"Selected shift was not found."};
  if(s.employeeId !== user.id) return {ok:false, message:"This shift is not assigned to you."};
  if(s.status !== "published" && s.status !== "confirmed") return {ok:false, message:"Only published shifts can be requested."};
  if(isShiftGone(s)) return {ok:false, message:"This shift is already completed. Previous shifts are kept for records only."};
  return {ok:true, shift:s};
}

function openChangeModal(shiftId){
  const check = canEmployeeActOnShift(shiftId);
  if(!check.ok) return toast(check.message);
  modal(`<h3>Request Change</h3>
    ${shiftDetailsCard(shiftId)}
    <label>Reason</label><select id="c-reason"><option>Study/class</option><option>Transport issue</option><option>Health/personal reason</option><option>Family reason</option><option>Other</option></select>
    <label>Message</label><textarea id="c-msg" placeholder="Example: Can I start at 6pm instead?"></textarea>
    <div class="actions" style="margin-top:14px"><button class="primary" onclick="submitChange('${shiftId}')">Submit</button><button onclick="closeModal()">Cancel</button></div>`);
}

function openSwapModal(shiftId){
  const check = canEmployeeActOnShift(shiftId);
  if(!check.ok) return toast(check.message);
  const others = state.users.filter(u => u.businessId === business().id && u.role === "employee" && u.id !== currentUser().id);
  modal(`<h3>Request Swap</h3>
    ${shiftDetailsCard(shiftId)}
    <label>Swap With</label><select id="s-target"><option value="">Open to eligible staff</option>${others.map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join("")}</select>
    <label>Message</label><textarea id="s-msg" placeholder="Example: I need to swap this shift."></textarea>
    <div class="actions" style="margin-top:14px"><button class="primary" onclick="submitSwap('${shiftId}')">Submit</button><button onclick="closeModal()">Cancel</button></div>`);
}

function openAvailabilityModal(){
  const today = isoDate(new Date());
  modal(`<h3>Request Unavailable</h3>
    <div class="request-shift-card"><strong>Unavailable request</strong><br><span>Submitted: ${friendlyDate(today)}</span><br><span class="small muted">All days are available by default. Manager approval is required before this blocks scheduling.</span></div>
    <div class="form-grid">
      <div><label>Unavailable Date</label><input id="a-date" type="date" value="${today}" onchange="updateAvailabilityDayLabel()"></div>
      <div><label>Day</label><input id="a-day-label" value="${fullDayName(dateObj(today))}" readonly></div>
      <div><label>Start</label><input id="a-start" type="time" value="00:00"></div>
      <div><label>End</label><input id="a-end" type="time" value="23:59"></div>
      <div><label>Reason</label><select id="a-reason"><option>Sick leave</option><option>Emergency</option><option>Casual leave</option><option>Study/class</option><option>Family reason</option><option>Personal reason</option><option>Other</option></select></div>
    </div>
    <label>Extra note</label><textarea id="a-notes" placeholder="Optional short note"></textarea>
    <div class="actions" style="margin-top:14px"><button class="primary" onclick="saveAvailability()">Submit Request</button><button onclick="closeModal()">Cancel</button></div>`);
}

function updateAvailabilityDayLabel(){
  const date = val("a-date");
  const out = el("a-day-label");
  if(out) out.value = date ? fullDayName(dateObj(date)) : "";
}

function modal(content){
  document.body.insertAdjacentHTML("beforeend", `<div class="modal-backdrop" onclick="if(event.target.classList.contains('modal-backdrop')) closeModal()"><div class="modal" onclick="event.stopPropagation()">${content}</div></div>`);
}
function closeModal(){ const m = document.querySelector(".modal-backdrop"); if(m) m.remove(); }

/* Actions */
function requireManagerForBusiness(recordBusinessId=""){
  const u = currentUser();
  const b = business();
  if(!u || !b || !isManagerial(u) || u.businessId !== b.id){ toast("Owner or manager access is required."); return false; }
  if(recordBusinessId && recordBusinessId !== b.id){ toast("This item belongs to another workspace."); return false; }
  return true;
}
function requireEmployeeSelf(employeeId){
  const u = currentUser();
  if(!u || u.role !== "employee" || u.id !== employeeId){ toast("You can change only your own requests and availability."); return false; }
  return true;
}
function rangesOverlap(startA,endA,startB,endB){ return toMin(startA) < toMin(endB) && toMin(startB) < toMin(endA); }
function saveShift(id=""){
  const b = business();
  if(!requireManagerForBusiness(b && b.id)) return;
  const shift = {
    id: id || uuid(),
    businessId: b.id,
    employeeId: val("m-emp"),
    date: val("m-date"),
    start: val("m-start"),
    end: val("m-end"),
    breakMinutes: Number(val("m-break")) || 0,
    // Save/edit stays as draft work. Main Publish Week sends staff notifications.
    status: val("m-status") || "draft",
    role: val("m-role"),
    location: val("m-loc"),
    notes: val("m-notes")
  };
  if(!shift.employeeId || !shift.date || !shift.start || !shift.end) return toast("Complete shift details.");
  if(toMin(shift.end) <= toMin(shift.start)) return toast("End time must be after start time.");
  const availabilityBlock = availabilityConflict(shift);
  if(availabilityBlock) return toast(availabilityBlock);
  if(id){
    const idx = state.shifts.findIndex(s => s.id === id);
    state.shifts[idx] = shift;
  }else{
    shift.status = "draft";
    state.shifts.push(shift);
  }
  saveState();
  closeModal();
  renderContent();
  toast("Shift saved. No email sent until Publish Week.");
}

function saveUser(){
  const b = business();
  const name = val("u-name");
  const inviteEmail = normalizeEmail(val("u-email"));
  const role = val("u-role");
  const hireDate = val("u-hire-date") || isoDate(new Date());

  if(!name || !inviteEmail) return toast("Name and email required.");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(hireDate)) return toast("Select a valid hire date.");
  if(!isValidEmail(inviteEmail)) return toast("Enter a valid email address.");
  if(state.users.some(u => normalizeEmail(u.email) === inviteEmail && u.status !== "removed")) return toast("Email already exists.");

  const id = uuid();
  state.users.push({id,businessId:b.id,name,email:inviteEmail,role,status:"invited",hireDate,notifyEmail:true,notifyInApp:true,emailVerified:false,createdAt:now()});
  if(role === "employee"){
    state.employees.push({id,businessId:b.id,userId:id,hireDate,employmentType:val("u-type"),visaTracking:true,fortnightLimit:Number(val("u-fortnight"))||48,weeklyLimit:Number(val("u-weekly"))||30,preferredHours:20,roleLabel:val("u-duty"),status:"active"});
  }
  saveState();

  const loginUrl = window.location.href.split("#")[0];
  notifyUser(
    id,
    "invite",
    "Join your workplace on MySchedule",
    `Hi ${name}, your workplace has added you to MySchedule as ${role} for ${b.name}. Open this link: ${loginUrl}. Use this email address: ${inviteEmail}. Choose Create account > Join my workplace, verify your email, or use Forgot password if you already have an account.`,
    {forceToEmail: inviteEmail, recipientSource:"invite_box", templateType:"invite", loginUrl, tempPassword:""}
  );
  notifyRole(["owner","manager"], "invite", "New user added", `${name} was added as ${role}. Account setup email sent to ${inviteEmail}.`);

  closeModal();
  renderContent();
  showCredentialModal({id, name, email: inviteEmail, role, businessName:b.name});
  toast("User added. They can choose Create account > Join my workplace, then verify email before signing in.");
}

function resendInvite(userId){
  const u = state.users.find(x => x.id === userId);
  if(!u) return;
  notifyUser(u.id, "invite", "MySchedule account reminder", `Hi ${u.name}, this is your MySchedule account reminder. Login page: ${window.location.href.split("#")[0]}. Use email: ${u.email}. Choose Create account > Join my workplace, verify your email, or use Forgot password if needed.`, {forceToEmail:u.email, recipientSource:"resend_invite_user_profile", templateType:"invite", loginUrl:window.location.href.split("#")[0], tempPassword:""});
  saveState();
  renderContent();
  toast("Account setup email resent.");
}

function removeUser(userId){
  const u = state.users.find(x => x.id === userId);
  if(!u || !confirm("Remove this user?")) return;
  state.users = state.users.filter(x => x.id !== userId);
  state.employees = state.employees.filter(e => e.userId !== userId);
  state.shifts = state.shifts.filter(s => s.employeeId !== userId);
  saveState();
  notifyRole(["owner","manager"], "employee", "User removed", `${u.name} was removed from MySchedule.`);
  renderContent();
}

function markReady(id){
  const s = state.shifts.find(x => x.id === id);
  if(!s) return;
  s.status = "draft";
  saveState();
  renderContent();
  toast("Ready in draft. Use Publish Week to send staff emails.");
}
function publishShift(id){
  // Backward compatibility: individual publish no longer sends emails.
  markReady(id);
}

function deleteShift(id){
  const s = state.shifts.find(x => x.id === id);
  if(!s || !requireManagerForBusiness(s.businessId) || !confirm("Delete this shift? No email will be sent.")) return;
  state.shifts = state.shifts.filter(x => x.id !== id);
  saveState();
  renderContent();
  toast("Shift deleted. No email sent.");
}

function confirmShift(id){
  const s = state.shifts.find(x => x.id === id);
  if(!s) return;
  s.status = "confirmed";
  saveState();
  notifyRole(["owner","manager"], "confirmation", "Shift confirmed", `${currentUser().name} confirmed shift on ${s.date}.`);
  renderContent();
}

function submitChange(shiftId){
  const check = canEmployeeActOnShift(shiftId);
  if(!check.ok) return toast(check.message);
  if(!val("c-msg")) return toast("Enter message.");
  const shift = check.shift;
  const r = {id:uuid(),businessId:business().id,employeeId:currentUser().id,shiftId,type:"change",message:`Reason: ${val("c-reason")}. ${val("c-msg")}`,status:"pending",createdAt:now(),seenBy:[],shiftSnapshot: shift ? {date:shift.date, day:fullDayName(dateObj(shift.date)), time:`${shift.start}-${shift.end}`, role:shift.role, status:shift.status, notes:shift.notes || ""} : null};
  state.requests.push(r);
  saveState();
  notifyRole(["owner","manager"], "request", "Shift change request", `${currentUser().name} requested a shift change.`, {requestId:r.id, shiftId:shiftId, targetView:"requests"});
  closeModal(); renderContent(); toast("Change request submitted.");
}

function submitSwap(shiftId){
  const check = canEmployeeActOnShift(shiftId);
  if(!check.ok) return toast(check.message);
  if(!val("s-msg")) return toast("Enter message.");
  const shift = check.shift;
  const r = {id:uuid(),businessId:business().id,employeeId:currentUser().id,shiftId,type:"swap",targetEmployeeId:val("s-target"),message:val("s-msg"),status:"pending",createdAt:now(),seenBy:[],shiftSnapshot: shift ? {date:shift.date, day:fullDayName(dateObj(shift.date)), time:`${shift.start}-${shift.end}`, role:shift.role, status:shift.status, notes:shift.notes || ""} : null};
  state.requests.push(r);
  saveState();
  notifyRole(["owner","manager"], "request", "Shift swap request", `${currentUser().name} requested a shift swap.`, {requestId:r.id, shiftId:shiftId, targetView:"requests"});
  closeModal(); renderContent(); toast("Swap request submitted.");
}

function approveRequest(id){
  const r = state.requests.find(x => x.id === id);
  if(!r || !requireManagerForBusiness(r.businessId)) return;
  if(r.status !== "pending") return toast("This request has already been processed.");
  if(r.type === "swap" && r.targetEmployeeId){
    const s = state.shifts.find(x => x.id === r.shiftId);
    if(s){
      const testShift = {...s, employeeId:r.targetEmployeeId};
      const availabilityBlock = availabilityConflict(testShift);
      if(availabilityBlock) return toast(availabilityBlock);
      s.employeeId = r.targetEmployeeId;
      s.status = "published";
      notifyUser(r.targetEmployeeId, "swap", "Shift swap approved", "A shift swap was approved and assigned to you.");
    }
  }
  if(r.type === "availability"){
    const a = state.availability.find(x => x.id === r.availabilityId);
    if(a){
      if(a.requestAction === "remove"){
        state.availability = state.availability.filter(x => x.id !== a.id);
      }else{
        a.status = "approved";
      }
    }
  }
  r.status = "approved";
  saveState();
  notifyUser(r.employeeId, "approval", "Request approved", `Your ${requestTypeLabel(r).toLowerCase()} request has been approved.`, {requestId:r.id, shiftId:r.shiftId || "", targetView:"myrequests"});
  renderContent();
}
function rejectRequest(id){
  const r = state.requests.find(x => x.id === id);
  if(!r || !requireManagerForBusiness(r.businessId)) return;
  if(r.status !== "pending") return toast("This request has already been processed.");
  if(r.type === "availability"){
    const a = state.availability.find(x => x.id === r.availabilityId);
    if(a){
      if(a.status === "pending") a.status = "rejected";
      if(a.status === "pending_removal") a.status = "approved";
      a.requestAction = "add";
    }
  }
  r.status = "rejected";
  saveState();
  notifyUser(r.employeeId, "approval", "Request rejected", `Your ${requestTypeLabel(r).toLowerCase()} request has been rejected.`, {requestId:r.id, shiftId:r.shiftId || "", targetView:"myrequests"});
  renderContent();
}

function saveAvailability(){
  const user = currentUser();
  if(!user || !requireEmployeeSelf(user.id)) return;
  const date = val("a-date");
  if(!date) return toast("Please choose the unavailable date.");
  if(toMin(val("a-end")) <= toMin(val("a-start"))) return toast("End time must be after start time.");
  const day = fullDayName(dateObj(date));
  const reason = val("a-reason") || "Unavailable";
  const duplicate = state.availability.find(a => a.businessId === business().id && a.employeeId === user.id && a.date === date && ["pending","approved","pending_removal"].includes(a.status) && rangesOverlap(val("a-start"), val("a-end"), a.start, a.end));
  if(duplicate) return toast("An overlapping unavailable request already exists for this date and time.");
  const availability = {id:uuid(),businessId:business().id,employeeId:user.id,date,day,start:val("a-start"),end:val("a-end"),available:false,reason,notes:val("a-notes"),status:"pending",requestAction:"add",createdAt:now()};
  state.availability.push(availability);
  const detail = `${friendlyDate(date)}, ${availability.start}-${availability.end}`;
  const r = {id:uuid(),businessId:business().id,employeeId:user.id,type:"availability",availabilityId:availability.id,message:`${user.name} requested unavailable time for ${detail}. Reason: ${reason}.${availability.notes ? " Note: " + availability.notes : ""}`,status:"pending",createdAt:now(),seenBy:[]};
  state.requests.push(r);
  saveState();
  notifyRole(["owner","manager"], "availability", "Unavailability approval needed", `${user.name} is unavailable on ${detail}. Reason: ${reason}.`, {requestId:r.id, targetView:"requests"});
  closeModal(); renderContent(); toast("Unavailable request sent for manager approval.");
}

function deleteAvailability(id){
  const a = state.availability.find(x => x.id === id);
  if(!a || !requireEmployeeSelf(a.employeeId) || a.businessId !== business().id) return;
  if(a.status === "approved"){
    if(state.requests.some(r => r.availabilityId === a.id && r.status === "pending")) return toast("A removal request is already waiting for approval.");
    a.status = "pending_removal";
    a.requestAction = "remove";
    const r = {id:uuid(),businessId:business().id,employeeId:a.employeeId,type:"availability",availabilityId:a.id,message:`${userName(a.employeeId)} requested removal of approved unavailable time for ${a.date ? friendlyDate(a.date) : a.day} ${a.start}-${a.end}.`,status:"pending",createdAt:now(),seenBy:[]};
    state.requests.push(r);
    notifyRole(["owner","manager"], "availability", "Availability removal approval needed", `${userName(a.employeeId)} requested to remove approved availability.`, {requestId:r.id, targetView:"requests"});
    saveState(); renderContent(); toast("Removal request sent for manager approval.");
    return;
  }
  state.availability = state.availability.filter(x => x.id !== id);
  state.requests = state.requests.filter(r => r.availabilityId !== id);
  saveState(); renderContent(); toast("Availability request deleted.");
}

function clockIn(){
  const u = currentUser();
  state.timesheets.push({id:uuid(),businessId:business().id,employeeId:u.id,clockIn:now(),clockOut:null});
  saveState();
  notifyRole(["owner","manager"], "timesheet", "Employee clocked in", `${u.name} clocked in.`);
  renderContent();
}
function clockOut(){
  const u = currentUser();
  const t = state.timesheets.find(x => x.employeeId === u.id && !x.clockOut);
  if(t) t.clockOut = now();
  saveState();
  notifyRole(["owner","manager"], "timesheet", "Employee clocked out", `${u.name} clocked out.`);
  renderContent();
}

/* Roster copy/drag */
function changeRosterWeek(days){ rosterWeekStart = addDays(rosterWeekStart, days); renderContent(); }
function visibleWeekShifts(){
  const b = business();
  const start = rosterWeekStart, end = addDays(start,7);
  return state.shifts.filter(s => s.businessId === b.id && dateObj(s.date) >= start && dateObj(s.date) < end).sort(sortShift);
}
function copyVisibleWeek(){
  copiedWeekBuffer = visibleWeekShifts().map(s => ({...s}));
  renderContent();
  toast(`${copiedWeekBuffer.length} shifts copied.`);
}
function pasteCopiedWeek(){
  if(!copiedWeekBuffer || copiedWeekBuffer.length === 0) return toast("Nothing copied.");
  const sourceStart = getMonday(dateObj(copiedWeekBuffer[0].date));
  copiedWeekBuffer.forEach(s => {
    const offset = Math.round((dateObj(s.date) - sourceStart) / 86400000);
    state.shifts.push({...s, id:uuid(), date:isoDate(addDays(rosterWeekStart, offset)), status:"draft"});
  });
  saveState(); renderContent(); toast("Copied shifts pasted as draft.");
}
function copyWeekToNextWeek(){
  const rows = visibleWeekShifts();
  if(rows.length === 0) return toast("No shifts to copy.");
  rows.forEach(s => state.shifts.push({...s, id:uuid(), date:isoDate(addDays(dateObj(s.date),7)), status:"draft"}));
  saveState(); renderContent(); toast("Week copied to next week.");
}
function clearWeek(){
  if(!confirm("Clear all shifts from visible week?")) return;
  const ids = visibleWeekShifts().map(s => s.id);
  state.shifts = state.shifts.filter(s => !ids.includes(s.id));
  saveState(); renderContent(); toast("Visible week cleared.");
}
function publishWeek(){
  const rows = visibleWeekShifts();
  if(rows.length === 0) return toast("No shifts in this week to publish.");
  const blocked = rows.map(s => availabilityConflict(s)).find(Boolean);
  if(blocked) return toast(blocked);
  if(!confirm("Publish this week and email each assigned employee their schedule?")) return;

  const weekStartText = friendlyDate(isoDate(rosterWeekStart));
  const weekEndText = friendlyDate(isoDate(addDays(rosterWeekStart,6)));
  const byEmployee = {};

  rows.forEach(s => {
    s.businessId = s.businessId || business().id;
    s.status = "published";
    if(!byEmployee[s.employeeId]) byEmployee[s.employeeId] = [];
    byEmployee[s.employeeId].push(s);
  });

  Object.entries(byEmployee).forEach(([employeeId, empShifts]) => {
    empShifts.sort(sortShift);
    const totalHours = empShifts.reduce((sum, s) => sum + shiftHours(s), 0).toFixed(1);
    const rosterLines = empShifts
      .map((s, i) => `${i+1}. ${friendlyDate(s.date)} | ${s.start}-${s.end} | ${s.role || "Shift"} | ${s.location || "Location TBA"} | Break: ${Number(s.breakMinutes)||0} min | Hours: ${shiftHours(s).toFixed(1)} | Status: Published${s.notes ? " | Notes: " + s.notes : ""}`)
      .join("\n");

    notifyUser(
      employeeId,
      "roster",
      `Your upcoming shifts at ${business().name}`,
      `Your roster for ${weekStartText} to ${weekEndText} is now published.\n\nTotal shifts: ${empShifts.length}\nTotal paid hours: ${totalHours}\n\n${rosterLines}\n\nPlease login to MySchedule to view and confirm your shifts.`,
      {
        templateType:"roster",
        weekStartText,
        weekEndText,
        totalShifts: empShifts.length,
        totalHours,
        shifts: empShifts.map((s, idx) => ({
          ...s,
          number: idx + 1,
          dayName: fullDayName(dateObj(s.date)),
          shortDate: dateObj(s.date).toLocaleDateString(undefined,{month:"short", day:"numeric", year:"numeric"}),
          friendlyDate:friendlyDate(s.date),
          hours:shiftHours(s).toFixed(1),
          breakMinutes:Number(s.breakMinutes)||0,
          location:s.location || "Location TBA",
          role:s.role || "Shift",
          status:"Published",
          notes:s.notes || ""
        }))
      }
    );
  });

  saveState();
  renderContent();
  toast("Week published. Schedule emails prepared for assigned employees.");
}

function duplicateShift(id){
  const s = state.shifts.find(x => x.id === id);
  if(!s) return;
  const copy = {...s,id:uuid(),status:"draft",notes:(s.notes||"")+" (copy)"};
  const availabilityBlock = availabilityConflict(copy);
  if(availabilityBlock) return toast(availabilityBlock);
  state.shifts.push(copy);
  saveState(); renderContent();
}
function copyShiftNextDay(id){
  const s = state.shifts.find(x => x.id === id);
  if(!s) return;
  const copy = {...s,id:uuid(),date:isoDate(addDays(dateObj(s.date),1)),status:"draft"};
  const availabilityBlock = availabilityConflict(copy);
  if(availabilityBlock) return toast(availabilityBlock);
  state.shifts.push(copy);
  saveState(); renderContent();
}
function dragShift(e,id){ e.dataTransfer.setData("text/plain", id); e.dataTransfer.effectAllowed = "move"; }
function allowDrop(e){ e.preventDefault(); e.currentTarget.classList.add("drag-over"); }
function dragLeave(e){ e.currentTarget.classList.remove("drag-over"); }
function dropShift(e,newDate){
  e.preventDefault();
  e.currentTarget.classList.remove("drag-over");
  const id = e.dataTransfer.getData("text/plain");
  const s = state.shifts.find(x => x.id === id);
  if(!s) return;
  const oldDate = s.date;
  s.date = newDate;
  const availabilityBlock = availabilityConflict(s);
  if(availabilityBlock){ s.date = oldDate; return toast(availabilityBlock); }
  s.status = "draft";
  saveState();
  renderContent();
  toast("Shift moved as draft. No email sent until Publish Week.");
}


function formatEmailShiftTime(value){
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if(!match) return raw;
  let hour = Number(match[1]);
  const minute = match[2];
  const suffix = hour >= 12 ? "PM" : "AM";
  hour = hour % 12 || 12;
  return `${hour}:${minute} ${suffix}`;
}
function emailShiftCrossesMidnight(shift){
  const toMinutes = value => {
    const m = String(value || "").match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
  };
  return toMinutes(shift.end) <= toMinutes(shift.start);
}
function normalizePublicAppUrl(value){
  const raw = String(value || "").trim();
  if(!raw) return "";
  try{
    const u = new URL(raw);
    if(!/^https?:$/.test(u.protocol)) return "";
    u.hash = "";
    return u.href;
  }catch(_){ return ""; }
}
function getPublicAppUrl(){
  try{
    const source = document.baseURI || window.location.href;
    const u = new URL(source);
    if(/^https?:$/.test(u.protocol) && !["localhost","127.0.0.1"].includes(u.hostname)){
      u.hash = "";
      u.search = "";
      const last = u.pathname.split("/").pop() || "";
      if(/\.[a-z0-9]+$/i.test(last)) u.pathname = u.pathname.replace(/[^/]+$/, "");
      if(!u.pathname.endsWith("/")) u.pathname += "/";
      return u.href;
    }
  }catch(_){ }
  return "";
}
function getScheduleEmailUrl(explicitUrl){
  return normalizePublicAppUrl(explicitUrl) || getPublicAppUrl();
}
function getEmployeeScheduleEmailUrl(user, explicitUrl){
  const base = getScheduleEmailUrl(explicitUrl);
  if(!base) return "";
  try{
    const u = new URL(base);
    u.searchParams.set("ms_view", "myshifts");
    if(user && user.email) u.searchParams.set("ms_email", normalizeEmail(user.email));
    if(user && user.businessId) u.searchParams.set("ms_business", String(user.businessId));
    u.hash = "myshifts";
    return u.href;
  }catch(_){ return base; }
}
function requestedEmailViewForUser(user){
  try{
    const q = new URLSearchParams(window.location.search);
    const requested = String(q.get("ms_view") || "").toLowerCase();
    if(user && user.role === "employee" && requested === "myshifts") return "myshifts";
  }catch(_){ }
  return "";
}
function applyEmailDeepLinkToLogin(){
  try{
    const q = new URLSearchParams(window.location.search);
    const email = normalizeEmail(q.get("ms_email") || "");
    const input = el("login-email");
    if(input && email && !input.value) input.value = email;
  }catch(_){ }
}
function buildHtmlEmail({type, toName, subject, message, businessName, loginUrl, tempPassword, shifts=[], weekStartText="", weekEndText="", totalShifts="", totalHours=""}){
  const isInvite = type === "invite" || type === "login";
  const isRoster = type === "roster";
  const resolvedUrl = getScheduleEmailUrl(loginUrl);
  const safeUrl = esc(resolvedUrl);
  const computedTotalShifts = totalShifts || shifts.length;
  const computedTotalHours = totalHours || shifts.reduce((sum,s) => sum + Number(s.hours || shiftHours(s)), 0).toFixed(1);

  const rosterRows = shifts.map((s, idx) => {
    const date = dateObj(s.date);
    const dayDate = date.toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric"});
    const timeLabel = `${formatEmailShiftTime(s.start)} – ${formatEmailShiftTime(s.end)}${emailShiftCrossesMidnight(s) ? " next day" : ""}`;
    const role = s.role && s.role !== "Shift" ? s.role : "Team Member";
    const location = s.location && s.location !== "Location TBA" ? s.location : "";
    const meta = [role, location].filter(Boolean).join(" · ");
    const rowBg = idx % 2 === 0 ? "#ffffff" : "#f7faff";
    return `<tr>
      <td width="62%" valign="middle" style="padding:16px 18px;border-top:${idx ? "1px solid #dfe7f2" : "0"};background:${rowBg};">
        <div style="font-size:15px;line-height:21px;font-weight:700;color:#172033;">${esc(dayDate)}</div>
        <div style="margin-top:3px;font-size:12px;line-height:18px;color:#667085;">${esc(meta)}</div>
        ${s.notes ? `<div style="margin-top:3px;font-size:12px;line-height:18px;color:#7a8494;">${esc(s.notes)}</div>` : ""}
      </td>
      <td width="38%" align="right" valign="middle" style="padding:16px 18px;border-top:${idx ? "1px solid #dfe7f2" : "0"};background:${rowBg};">
        <div style="font-size:15px;line-height:21px;font-weight:800;color:#0b5cff;white-space:nowrap;">${esc(timeLabel)}</div>
        <div style="margin-top:3px;font-size:12px;line-height:18px;font-weight:700;color:#667085;">${esc(s.hours || shiftHours(s).toFixed(1))} hrs</div>
      </td>
    </tr>`;
  }).join("");

  const inviteBlock = isInvite ? `
    <div style="background:#f8fafc;border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin:18px 0;">
      <p style="margin:0 0 8px;color:#64748b;font-size:13px;">Your login details</p>
      <p style="margin:6px 0;"><strong>Email:</strong> ${esc(message.match(/Login email:\s*([^\.]+@[^\.]+\.[^\.\s]+)/)?.[1] || "") || "{{to_email}}"}</p>
      ${tempPassword ? `<p style="margin:6px 0;"><strong>Temporary password:</strong> <span style="background:#111827;color:#fff;padding:6px 10px;border-radius:8px;font-weight:700;">${esc(tempPassword)}</span></p>` : `<p style="margin:6px 0;color:#475569;">Use the secure sign-in page to create or reset your password.</p>`}
      <a href="${safeUrl}" style="display:inline-block;margin-top:12px;background:#0b5cff;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:999px;font-weight:700;">Open MySchedule</a>
    </div>` : "";

  if(isRoster){
    return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;margin:0;background:#f4f7fb;border-collapse:collapse;">
      <tr>
        <td align="center" style="padding:28px 12px;">
          <table role="presentation" width="780" cellspacing="0" cellpadding="0" border="0" align="center" style="width:100%;max-width:780px;margin:0 auto;border-collapse:separate;background:#ffffff;border:1px solid #dce4ef;border-radius:20px;overflow:hidden;">
            <tr>
              <td style="padding:30px 34px;background:#0b2f6b;color:#ffffff;">
                <div style="font-size:20px;line-height:26px;font-weight:800;">MySchedule</div>
                <div style="margin-top:22px;font-size:28px;line-height:34px;font-weight:800;">Hi ${esc(toName)} 👋</div>
                <div style="margin-top:7px;font-size:16px;line-height:24px;color:#eaf1ff;">Your upcoming shifts at <strong style="color:#ffffff;">${esc(businessName)}</strong> are ready.</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 34px 28px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;">
                  <tr>
                    <td valign="bottom" style="padding:0 10px 14px 0;">
                      <div style="font-size:11px;line-height:16px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:#7a8494;">Schedule period</div>
                      <div style="margin-top:5px;font-size:16px;line-height:23px;font-weight:800;color:#172033;">${esc(weekStartText)} – ${esc(weekEndText)}</div>
                    </td>
                    <td align="right" valign="bottom" style="padding:0 0 14px 10px;white-space:nowrap;">
                      <span style="display:inline-block;background:#eef4ff;color:#0b5cff;border-radius:999px;padding:7px 10px;font-size:12px;line-height:16px;font-weight:800;">${esc(computedTotalShifts)} shift${Number(computedTotalShifts) === 1 ? "" : "s"}</span>
                      <span style="display:inline-block;background:#edf9f2;color:#157347;border-radius:999px;padding:7px 10px;font-size:12px;line-height:16px;font-weight:800;margin-left:5px;">${esc(computedTotalHours)} hrs</span>
                    </td>
                  </tr>
                </table>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:separate;border-spacing:0;border:1px solid #dfe7f2;border-radius:14px;overflow:hidden;">
                  <tr>
                    <td width="62%" style="padding:11px 18px;background:#eef4ff;color:#49617f;font-size:11px;line-height:16px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;">Day, role and location</td>
                    <td width="38%" align="right" style="padding:11px 18px;background:#eef4ff;color:#49617f;font-size:11px;line-height:16px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;">Shift time</td>
                  </tr>
                  ${rosterRows}
                </table>
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-collapse:collapse;">
                  <tr>
                    <td align="center" style="padding-top:24px;">
                      ${resolvedUrl ? `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" style="display:inline-block;background:#0b5cff;color:#ffffff;text-decoration:none;font-size:15px;line-height:20px;font-weight:800;padding:13px 24px;border-radius:999px;">View my schedule</a><div style="margin-top:9px;font-size:11px;line-height:16px;color:#7a8494;word-break:break-all;">${safeUrl}</div>` : `<div style="font-size:13px;line-height:19px;color:#b42318;background:#fff1f0;border:1px solid #fecdca;border-radius:10px;padding:10px 12px;">Schedule link becomes available automatically from the live MySchedule website.</div>`}
                    </td>
                  </tr>
                </table>
                <div style="margin-top:18px;font-size:13px;line-height:20px;color:#6b7280;text-align:center;">Open MySchedule to review shift notes and the latest schedule changes.</div>
              </td>
            </tr>
            <tr>
              <td align="center" style="padding:16px 24px;background:#f8fafc;border-top:1px solid #e5e7eb;color:#798292;font-size:12px;line-height:18px;">Sent by MySchedule for ${esc(businessName)}.<br>This is an automated notification. Replies are sent to your workplace owner.</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>`;
  }

  return `
  <div style="margin:0;padding:0;background:#f4f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#111827;">
    <div style="max-width:620px;margin:0 auto;padding:24px 12px;">
      <div style="background:#0b2f6b;border-radius:20px 20px 0 0;padding:24px;color:#ffffff;">
        <h1 style="margin:0;font-size:24px;">MySchedule</h1>
        <p style="margin:5px 0 0;opacity:.88;">${esc(businessName)}</p>
      </div>
      <div style="background:#ffffff;border:1px solid #e5e7eb;border-top:0;border-radius:0 0 20px 20px;padding:26px;">
        <p style="margin:0 0 10px;color:#64748b;">Hi ${esc(toName)},</p>
        <h2 style="margin:0 0 14px;color:#111827;">${esc(subject)}</h2>
        <p style="font-size:15px;line-height:1.6;white-space:pre-line;color:#334155;">${esc(message)}</p>
        ${inviteBlock}
        <div style="margin-top:26px;padding-top:18px;border-top:1px solid #e5e7eb;color:#64748b;font-size:13px;">Sent by MySchedule for ${esc(businessName)}.</div>
      </div>
    </div>
  </div>`;
}

/* Email branding + notification IDs */
function generateNotificationRef(){
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for(let i=0;i<6;i++) code += chars[Math.floor(Math.random()*chars.length)];
  return `MS-${y}${m}${day}-${code}`;
}
function brandedEmailSubject(subject, ref){
  const clean = String(subject || 'Notification').replace(/^My\s*Schedule\s*Alert\s*:?\s*/i,'').trim();
  return `MySchedule Alert [${ref}]: ${clean}`;
}
function appendReferenceToMessage(message, ref){
  const text = String(message || '');
  return `${text}\n\nReference ID: ${ref}\nThis is an automated notification from MySchedule. Please do not reply to this email.`;
}

/* Notifications + Brevo through Cloudflare Worker */
function notifyUser(userId,type,subject,message,options={}){
  const user = state.users.find(u => u.id === userId);
  if(!user) return;
  const b = state.businesses.find(x => x.id === user.businessId) || business();

  // All notifications go to the respected user's own email.
  // For invitation, forceToEmail is the email typed in the invite box.
  const recipientEmail = String(options.forceToEmail || user.email || "").trim().toLowerCase();
  const recipientName = user.name || recipientEmail;

  if(!recipientEmail || !isValidEmail(recipientEmail)){
    toast("Notification blocked: invalid recipient email for " + recipientName);
    return;
  }

  const refId = generateNotificationRef();
  const emailSubject = brandedEmailSubject(subject, refId);
  const emailMessage = appendReferenceToMessage(message, refId);

  const note = {
    id:uuid(),
    refId,
    businessId:b.id,
    userId:user.id,
    toUserId:user.id,
    to:recipientEmail,
    toName:recipientName,
    role:user.role,
    type,
    subject: emailSubject,
    originalSubject: subject,
    message: emailMessage,
    originalMessage: message,
    recipientSource: options.recipientSource || "user_profile_email",
    emailStatus: user.notifyEmail === false ? "email_disabled" : (state.emailConfig.enabled ? "sending" : "sent_demo"),
    read:false,
    createdAt:now(),
    requestId: options.requestId || "",
    shiftId: options.shiftId || "",
    targetView: options.targetView || "",
    templateType: options.templateType || type || "",
    templateData: {
      weekStartText: options.weekStartText || "",
      weekEndText: options.weekEndText || "",
      totalShifts: options.totalShifts || "",
      totalHours: options.totalHours || "",
      shifts: Array.isArray(options.shifts) ? options.shifts.map(shift => ({...shift})) : []
    }
  };
  state.notifications.push(note);
  saveState();

  if(user.notifyEmail !== false && state.emailConfig.enabled){
    sendEmail({
      noteId: note.id,
      to_email: recipientEmail,
      to_name: recipientName,
      subject: emailSubject,
      message: emailMessage,
      notification_ref: refId,
      business_name: b.name,
      recipientSource: note.recipientSource,
      html_message: buildHtmlEmail({
        type: options.templateType || type,
        toName: recipientName,
        subject: emailSubject,
        message: emailMessage,
        businessName: b.name,
        loginUrl: getEmployeeScheduleEmailUrl(user, options.loginUrl || getPublicAppUrl()),
        tempPassword: options.tempPassword || "",
        shifts: options.shifts || [],
        weekStartText: options.weekStartText || "",
        weekEndText: options.weekEndText || "",
        totalShifts: options.totalShifts || "",
        totalHours: options.totalHours || ""
      })
    });
  }
}
function notifyRole(roles,type,subject,message,options={}){
  const b = business();
  state.users.filter(u => u.businessId === b.id && roles.includes(u.role) && u.status === "active").forEach(u => notifyUser(u.id,type,subject,message,options));
}
function notifyProfileAdmins(updatedUser, details){
  const b = state.businesses.find(x => x.id === updatedUser.businessId) || business();
  if(!b) return;
  const adminRoles = ['owner','manager'];
  state.users
    .filter(u => u.businessId === b.id && adminRoles.includes(u.role) && u.status === 'active' && u.id !== updatedUser.id)
    .forEach(u => notifyUser(
      u.id,
      'profile',
      'Team profile updated',
      `${updatedUser.name || updatedUser.email} updated their profile. Changes: ${details}`,
      {recipientSource:'profile_change_admin_alert'}
    ));
}

function compactEmailHtml(value){
  const html = String(value || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Keep generated transactional emails comfortably below common provider limits.
  const maxBytes = 44000;
  try{
    if(new TextEncoder().encode(html).length <= maxBytes) return html;
  }catch(_){
    if(html.length <= maxBytes) return html;
  }
  // Safe fallback: preserve a valid, readable email instead of sending an
  // oversized message that an email provider may reject.
  const plain = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return `<div style="font-family:Arial,sans-serif;color:#172033;line-height:1.6"><h2 style="color:#0b2f6b">MySchedule</h2><p>${esc(plain.slice(0,18000))}</p></div>`;
}
function businessOwnerEmailFor(payload={}){
  const businessId = payload.businessId || payload.business_id || business()?.id;
  const owner = state.users.find(u => u.businessId === businessId && u.role === "owner" && u.status !== "removed" && isValidEmail(u.email));
  return owner ? normalizeEmail(owner.email) : "";
}

async function sendEmail(payload){
  const c = state.emailConfig || EMAILJS_DEFAULTS;
  const actualRecipient = String(payload.to_email || "").trim().toLowerCase();
  const ownerReplyEmail = businessOwnerEmailFor(payload);
  const workerUrl = String(c.workerUrl || EMAILJS_DEFAULTS.workerUrl || "").trim().replace(/\/+$/, "");
  const html = compactEmailHtml(payload.html_message || payload.message || "");
  const plainText = String(payload.message || "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const requestBody = {
    to: actualRecipient,
    replyTo: ownerReplyEmail || undefined,
    employeeName: payload.to_name || actualRecipient,
    businessName: payload.business_name || business().name,
    subject: payload.subject || "MySchedule notification",
    html,
    text: plainText
  };

  saveEmailDebug(payload.noteId, {
    status: "prepared",
    provider: "Brevo via Cloudflare Worker",
    recipient: actualRecipient,
    replyTo: ownerReplyEmail,
    workerUrl,
    request: {...requestBody, html: `[HTML ${html.length} characters]`}
  });

  if(!c.enabled){
    updateEmailStatus(payload.noteId, "sent_demo", "Email notifications are paused. The notification was saved inside MySchedule only.");
    return;
  }
  if(!isValidEmail(actualRecipient)){
    updateEmailStatus(payload.noteId, "invalid_recipient", "Recipient email is invalid: " + actualRecipient);
    toast("Email blocked: invalid recipient.");
    return;
  }
  if(!/^https:\/\/[^\s]+\.workers\.dev(?:\/.*)?$/i.test(workerUrl)){
    updateEmailStatus(payload.noteId, "missing_settings", "A valid Cloudflare Worker URL is required.");
    toast("Email setup incomplete: check the Cloudflare Worker URL.");
    return;
  }

  try{
    const response = await fetch(workerUrl, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(requestBody)
    });
    let result = {};
    try{ result = await response.json(); }catch(e){}
    if(!response.ok || !result.success){
      throw new Error(result.error || `Email service returned HTTP ${response.status}.`);
    }
    saveEmailDebug(payload.noteId, {
      status: "sent",
      provider: "Brevo via Cloudflare Worker",
      recipient: actualRecipient,
      replyTo: ownerReplyEmail,
      messageId: result.messageId || ""
    });
    updateEmailStatus(payload.noteId, "sent_real", "Brevo accepted the email for " + actualRecipient);
    toast("Email sent to " + actualRecipient);
  }catch(err){
    console.error("Brevo Worker send failed:", err);
    const msg = err && err.message ? err.message : String(err || "Unknown email error.");
    saveEmailDebug(payload.noteId, {
      status: "failed",
      provider: "Brevo via Cloudflare Worker",
      recipient: actualRecipient,
      replyTo: ownerReplyEmail,
      error: msg
    });
    updateEmailStatus(payload.noteId, "failed", msg);
    toast("Email failed: " + msg);
  }
}
function updateEmailStatus(noteId,status,errorMessage=""){
  const n = state.notifications.find(x => x.id === noteId);
  if(n){
    n.emailStatus = status;
    n.emailError = errorMessage;
    saveState();
    try{ renderContent(); }catch(e){}
  }
}
function saveEmailDebug(noteId, debugInfo){
  const n = state.notifications.find(x => x.id === noteId);
  if(n){
    n.emailDebug = debugInfo;
    saveState();
  }
}
function getEmailJSErrorMessage(err){
  if(!err) return "Unknown EmailJS error.";
  if(typeof err === "string") return err;
  if(err.text) return err.text;
  if(err.message) return err.message;
  if(err.status) return "EmailJS status " + err.status + (err.text ? ": " + err.text : "");
  return safeStringify(err);
}
function safeStringify(obj){
  try{return JSON.stringify(obj);}
  catch(e){return String(obj);}
}

function unreadCount(userId){ return state.notifications.filter(n => n.userId === userId && !n.read).length; }
function actionNeededCount(user){
  if(!user) return 0;
  const unreadNotes = state.notifications.filter(n => n.userId === user.id && !n.read).length;
  const pendingRequests = isManagerial(user) ? state.requests.filter(r => r.businessId === user.businessId && r.status === "pending").length : state.requests.filter(r => r.employeeId === user.id && r.status === "pending").length;
  return unreadNotes + pendingRequests;
}
function markRead(id){ const n = state.notifications.find(x => x.id === id); if(n) n.read = true; saveState(); render(); }
function markAllRead(){ const u = currentUser(); state.notifications.forEach(n => { if(n.userId === u.id) n.read = true; }); saveState(); renderContent(); updateTopbarAuthVisibility(u); }
function clearMine(){
  const u = currentUser();
  const keep = [];
  state.notifications.forEach(n => {
    if(n.userId === u.id) archiveNotification(n);
    else keep.push(n);
  });
  state.notifications = keep;
  saveState();
  renderContent();
  updateTopbarAuthVisibility(u);
}
function saveEmailSettings(){
  state.emailConfig.enabled = val("email-enabled") === "true";
  state.emailConfig.pausedByOwner = !state.emailConfig.enabled;
  state.emailConfig.provider = "brevo_worker";
  state.emailConfig.fromName = "MySchedule Notification";
  state.emailConfig.workerUrl = String(val("email-worker-url") || EMAILJS_DEFAULTS.workerUrl).trim().replace(/\/+$/, "");
  state.emailConfig.mode = state.emailConfig.enabled ? "brevo" : "demo";
  delete state.emailConfig.publicKey;
  delete state.emailConfig.serviceId;
  delete state.emailConfig.templateId;
  delete state.emailConfig.replyTo;
  delete state.emailConfig.appUrl;
  saveState(); renderContent(); toast("Brevo email settings saved.");
}
function sendTestToMe(){
  const u = currentUser();
  const note = {id:uuid(),businessId:business().id,userId:u.id,to:u.email,toName:u.name,role:u.role,type:"test",recipientSource:"current_logged_in_user",subject:"MySchedule test email",message:"This is a test email from MySchedule.",emailStatus:"sending",read:false,createdAt:now()};
  state.notifications.push(note); saveState();
  sendEmail({noteId:note.id,to_email:u.email,to_name:u.name,subject:note.subject,message:note.message,business_name:business().name});
}
function sendCustomTest(){
  const email = val("custom-test-email");
  if(!email) return toast("Enter test email.");
  const u = currentUser();
  const note = {id:uuid(),businessId:business().id,userId:u.id,to:email,toName:email,role:u.role,type:"test",recipientSource:"custom_test_email_box",subject:"MySchedule custom test",message:"This is a custom test email from MySchedule.",emailStatus:"sending",read:false,createdAt:now()};
  state.notifications.push(note); saveState();
  sendEmail({noteId:note.id,to_email:email,to_name:email,subject:note.subject,message:note.message,business_name:business().name});
}
async function sendRawDiagnosticEmail(){
  const email = val("custom-test-email");
  if(!email) return toast("Enter test email first.");
  const note = {id:uuid(),businessId:business().id,userId:currentUser()?.id,to:email,toName:email,role:currentUser()?.role || "owner",type:"test",recipientSource:"custom_test_email_box",subject:"MySchedule Brevo diagnostic",message:"This is a direct Brevo and Cloudflare Worker diagnostic email from MySchedule.",emailStatus:"sending",read:false,createdAt:now()};
  state.notifications.push(note); saveState();
  await sendEmail({noteId:note.id,businessId:business().id,to_email:email,to_name:email,subject:note.subject,message:note.message,business_name:business().name});
}


function showEmailDebug(noteId){
  const n = state.notifications.find(x => x.id === noteId);
  if(!n) return toast("Notification not found.");
  const dbg = n.emailDebug || {};
  modal(`
    <h3>Email Debug</h3>
    <p><strong>Recipient:</strong> ${esc(n.to)}</p>
    <p><strong>Status:</strong> ${emailStatusLabel(n.emailStatus)}</p>
    <p><strong>Error:</strong> ${esc(n.emailError || "-")}</p>
    <p><strong>Service ID:</strong> ${esc(state.emailConfig.serviceId)}</p>
    <p><strong>Template ID:</strong> ${esc(state.emailConfig.templateId)}</p>
    <p><strong>Public Key Present:</strong> ${state.emailConfig.publicKey ? "Yes" : "No"}</p>
    <label>Params sent to EmailJS</label>
    <textarea readonly style="min-height:220px">${esc(JSON.stringify(dbg.params || {}, null, 2))}</textarea>
    <div class="notice">If this shows the correct recipient but no email arrives, the issue is in EmailJS template/service settings, spam, quota, or Google service connection.</div>
    <button onclick="closeModal()">Close</button>
  `);
}

/* Reports/calculations */
function buildAlerts(){
  const b = business(), alerts = [];
  state.employees.filter(e => e.businessId === b.id).forEach(e => {
    const u = state.users.find(x => x.id === e.userId);
    const week = sumHours(e.userId, rosterWeekStart, addDays(rosterWeekStart,7));
    const fortnight = sumFortnightHours(e.userId, new Date());
    if(e.visaTracking && fortnight >= e.fortnightLimit) alerts.push({severity:"high",employee:u?.name||"",message:`Fortnight hours ${fortnight.toFixed(1)} / ${e.fortnightLimit}.`});
    else if(e.visaTracking && fortnight >= e.fortnightLimit - 4) alerts.push({severity:"medium",employee:u?.name||"",message:`Near fortnight limit ${fortnight.toFixed(1)} / ${e.fortnightLimit}.`});
    if(week > e.weeklyLimit) alerts.push({severity:"medium",employee:u?.name||"",message:`Week hours ${week.toFixed(1)} above selected ${e.weeklyLimit}.`});
  });
  return alerts;
}
function reportChecked(id, fallback=false){ const x = el(id); return x ? x.checked : fallback; }
function selectedReportColumns(){
  const boxes = Array.from(document.querySelectorAll('.report-col'));
  const cols = boxes.filter(b => b.checked).map(b => b.dataset.col);
  return cols.length ? cols : ["no","date","day","employee","time","hours","role","location","status"];
}
function applyReportPreset(){
  const layout = el("report-layout")?.value || "weekly_board";
  const set = (id, checked) => { const x = el(id); if(x) x.checked = checked; };
  const group = el("report-group"), page = el("report-page");
  let cols = ["no","date","day","employee","time","hours","role","location","status","notes"];
  set("sec-cover", true); set("sec-kpis", true); set("sec-summary", true); set("sec-details", true); set("sec-signature", false); set("sec-notes", true);
  if(layout === "weekly_board") { if(group) group.value="employee"; if(page) page.value="landscape"; set("sec-summary", false); cols=["no","employee","role","time","break","notes"]; }
  if(layout === "daily_signin") { if(group) group.value="day"; if(page) page.value="landscape"; set("sec-summary", false); set("sec-signature", true); cols=["no","date","day","employee","time","role","location","signature"]; }
  if(layout === "employee_cards") { if(group) group.value="employee"; if(page) page.value="portrait"; set("sec-kpis", false); cols=["no","date","day","time","hours","role","location","notes"]; }
  if(layout === "hours_summary") { if(group) group.value="employee"; if(page) page.value="portrait"; set("sec-details", false); cols=["employee","hours","status"]; }
  if(layout === "detailed") { if(group) group.value="none"; if(page) page.value="landscape"; cols=["no","date","day","employee","email","time","break","hours","role","location","status","notes"]; }
  document.querySelectorAll('.report-col').forEach(b => b.checked = cols.includes(b.dataset.col));
}
function getReportOptions(){
  const layout = el("report-layout")?.value || "weekly_board";
  const period = el("report-period")?.value || "week";
  const employeeId = el("report-employee")?.value || "all";
  const status = el("report-status")?.value || "published_only";
  const page = el("report-page")?.value || "landscape";
  const groupBy = el("report-group")?.value || (layout === "employee_cards" ? "employee" : "day");
  let start = dateObj(el("report-start")?.value || isoDate(rosterWeekStart));
  let end = dateObj(el("report-end")?.value || isoDate(addDays(rosterWeekStart,7)));
  if(period === "week"){ start = getMonday(start); end = addDays(start,7); }
  if(period === "month"){ start = new Date(start.getFullYear(), start.getMonth(), 1); end = new Date(start.getFullYear(), start.getMonth()+1, 1); }
  if(end <= start) end = addDays(start,1);
  const sections = {
    cover: reportChecked("sec-cover", true),
    kpis: reportChecked("sec-kpis", true),
    summary: reportChecked("sec-summary", true),
    details: reportChecked("sec-details", true),
    signature: reportChecked("sec-signature", false),
    notes: reportChecked("sec-notes", true)
  };
  let columns = selectedReportColumns();
  if(sections.signature && !columns.includes("signature")) columns.push("signature");
  if(!sections.notes) columns = columns.filter(c => c !== "notes");
  return {layout, period, employeeId, status, start, end, page, groupBy, sections, columns};
}
function syncReportPeriod(){
  const startInput = el("report-start");
  const endInput = el("report-end");
  const period = el("report-period")?.value || "week";
  if(!startInput || !endInput) return;
  const base = dateObj(startInput.value || isoDate(rosterWeekStart));
  if(period === "week"){ const st = getMonday(base); startInput.value = isoDate(st); endInput.value = isoDate(addDays(st,7)); }
  if(period === "month"){ const st = new Date(base.getFullYear(), base.getMonth(), 1); startInput.value = isoDate(st); endInput.value = isoDate(new Date(st.getFullYear(), st.getMonth()+1, 1)); }
}
function getReportShifts(options=getReportOptions()){
  const b = business();
  return state.shifts.filter(s => {
    const d = dateObj(s.date);
    if(s.businessId !== b.id || d < options.start || d >= options.end) return false;
    if(options.employeeId !== "all" && s.employeeId !== options.employeeId) return false;
    if(options.status === "published_only" && !["published","confirmed"].includes(s.status)) return false;
    if(options.status === "draft" && s.status !== "draft") return false;
    return true;
  }).sort(sortShift);
}
function reportTitle(options){
  const map = {weekly_board:"Weekly Schedule Board", daily_signin:"Daily Sign-in Sheet", employee_cards:"Employee Schedule Cards", hours_summary:"Employee Hours Summary", detailed:"Detailed Shift List", custom:"Custom Schedule Report"};
  const periodText = options.period === "month" ? "Monthly" : options.period === "custom" ? "Custom Date" : "Weekly";
  return `${periodText} ${map[options.layout] || "Schedule Report"}`;
}
function formatReportRange(options){ return `${friendlyDate(isoDate(options.start))} to ${friendlyDate(isoDate(addDays(options.end,-1)))}`; }
function reportEmployeeTotals(shifts){
  const totals = {};
  shifts.forEach(s => {
    const key = s.employeeId || "unassigned";
    const u = state.users.find(x => x.id === s.employeeId);
    if(!totals[key]) totals[key] = {id:key,name:u?.name||"Unassigned",email:u?.email||"",shifts:0,hours:0,days:new Set()};
    totals[key].shifts += 1; totals[key].hours += shiftHours(s); totals[key].days.add(s.date);
  });
  return Object.values(totals).sort((a,b)=>a.name.localeCompare(b.name));
}
function columnLabel(c){
  return ({no:"No.",date:"Date",day:"Day",employee:"Employee",email:"Email",time:"Time",break:"Break",hours:"Hours",role:"Role",location:"Location",status:"Status",notes:"Notes",signature:"Signature"})[c] || c;
}
function shiftCell(s, col, i){
  const u = state.users.find(x => x.id === s.employeeId);
  if(col === "no") return `<td class="num">${i+1}</td>`;
  if(col === "date") return `<td>${esc(s.date)}</td>`;
  if(col === "day") return `<td><strong>${fullDayName(dateObj(s.date))}</strong></td>`;
  if(col === "employee") return `<td><strong>${esc(u?.name || "Unassigned")}</strong></td>`;
  if(col === "email") return `<td>${esc(u?.email || "")}</td>`;
  if(col === "time") return `<td><strong>${esc(s.start)} - ${esc(s.end)}</strong></td>`;
  if(col === "break") return `<td>${Number(s.breakMinutes)||0} min</td>`;
  if(col === "hours") return `<td>${shiftHours(s).toFixed(1)}</td>`;
  if(col === "role") return `<td>${esc(s.role || "Shift")}</td>`;
  if(col === "location") return `<td>${esc(s.location || "-")}</td>`;
  if(col === "status") return `<td><span class="status-pill">${esc(s.status || "-")}</span></td>`;
  if(col === "notes") return `<td>${esc(s.notes || "-")}</td>`;
  if(col === "signature") return `<td class="signature-cell"></td>`;
  return `<td></td>`;
}
function buildShiftTable(shifts, options){
  const cols = options.columns.filter(c => !(c === "signature" && !options.sections.signature));
  const header = cols.map(c=>`<th>${esc(columnLabel(c))}</th>`).join("");
  const rows = shifts.map((s,i)=>`<tr>${cols.map(c=>shiftCell(s,c,i)).join("")}</tr>`).join("") || `<tr><td colspan="${cols.length || 1}">No shifts found for selected filters.</td></tr>`;
  return `<div class="table-wrap"><table class="report-table"><thead><tr>${header}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
function buildGroupedShiftTables(shifts, options){
  if(options.groupBy === "none") return buildShiftTable(shifts, options);
  const groups = {};
  shifts.forEach(s => {
    const key = options.groupBy === "employee" ? (s.employeeId || "unassigned") : s.date;
    if(!groups[key]) groups[key] = [];
    groups[key].push(s);
  });
  const keys = Object.keys(groups).sort((a,b)=>{
    if(options.groupBy === "employee") return userName(a).localeCompare(userName(b));
    return a.localeCompare(b);
  });
  if(!keys.length) return buildShiftTable([], options);
  return keys.map(key => {
    const title = options.groupBy === "employee" ? `${userName(key)} — ${groups[key].length} shifts, ${totalHours(groups[key]).toFixed(1)} hrs` : `${fullDayName(dateObj(key))}, ${key} — ${groups[key].length} shifts`;
    return `<div class="report-group"><h3>${esc(title)}</h3>${buildShiftTable(groups[key], options)}</div>`;
  }).join("");
}
function buildEmployeeSummaryTable(totals){
  const rows = totals.map(r => `<tr><td><strong>${esc(r.name)}</strong><br><span>${esc(r.email)}</span></td><td>${r.shifts}</td><td>${r.days.size}</td><td>${r.hours.toFixed(1)}</td></tr>`).join("") || `<tr><td colspan="4">No records found for this report.</td></tr>`;
  return `<div class="table-wrap"><table class="report-table"><thead><tr><th>Employee</th><th>Shifts</th><th>Days</th><th>Total Hours</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function dayShortLabel(d){ return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][d.getDay()]; }
function monthDayLabel(d){ return d.toLocaleDateString(undefined,{month:"short",day:"numeric"}); }
function employeeRoleForBoard(userId, shifts){
  const emp = state.employees.find(e => e.userId === userId || e.id === userId);
  const roles = shifts.filter(s => s.employeeId === userId && s.role).map(s => s.role.trim()).filter(Boolean);
  if(roles.length){
    const counts = roles.reduce((m,r)=>((m[r]=(m[r]||0)+1),m),{});
    return Object.keys(counts).sort((a,b)=>counts[b]-counts[a] || a.localeCompare(b))[0];
  }
  return emp?.roleLabel || emp?.employmentType || "Team Member";
}
function buildWeeklyScheduleBoard(shifts, options){
  const start = getMonday(options.start || rosterWeekStart);
  const days = Array.from({length:7}, (_,i)=>addDays(start,i));
  const businessId = business().id;
  let employeeIds = Array.from(new Set(shifts.map(s => s.employeeId).filter(Boolean)));
  if(options.employeeId !== "all") employeeIds = employeeIds.filter(id => id === options.employeeId);
  const activeEmployees = state.users.filter(u => u.businessId === businessId && u.role === "employee" && u.status === "active");
  if(options.employeeId === "all"){
    const activeIds = activeEmployees.map(u => u.id);
    employeeIds = Array.from(new Set([...activeIds, ...employeeIds]));
  }
  employeeIds.sort((a,b)=>userName(a).localeCompare(userName(b)));
  if(!employeeIds.length) return `<div class="empty-report">No employees found for this weekly schedule.</div>`;
  const dayTotals = days.map(d => totalHours(shifts.filter(s => s.date === isoDate(d))));
  const header = days.map((d,i)=>`<th class="week-day-head"><strong>${esc(dayShortLabel(d))}</strong><span>${esc(monthDayLabel(d))}</span><em>${dayTotals[i].toFixed(1)} hrs</em></th>`).join("");
  const rows = employeeIds.map((id,idx)=>{
    const empShifts = shifts.filter(s => s.employeeId === id);
    const roleText = employeeRoleForBoard(id, empShifts);
    const employeeWeekHours = totalHours(empShifts);
    const cells = days.map(d=>{
      const date = isoDate(d);
      const list = empShifts.filter(s => s.date === date).sort(sortShift);
      if(!list.length) return `<td class="weekly-empty"><span>—</span><small>0.0 hrs</small></td>`;
      const dayEmployeeHours = totalHours(list);
      return `<td>${list.map(s=>`
        <div class="weekly-shift-block">
          <strong>${esc(s.start)} - ${esc(s.end)}</strong>
          <span class="weekly-shift-hours">${shiftHours(s).toFixed(1)} hrs</span>
          ${(Number(s.breakMinutes)||0) ? `<em>Break: ${Number(s.breakMinutes)||0} mins</em>` : `<em>Break: 0 mins</em>`}
          ${s.notes ? `<small>${esc(s.notes)}</small>` : ""}
        </div>`).join("")}</td>`;
    }).join("");
    return `<tr><td class="weekly-employee-cell"><div class="weekly-employee-no">${idx+1}</div><div><strong>${esc(userName(id))}</strong><span>${esc(roleText)}</span><b>${employeeWeekHours.toFixed(1)} hrs total</b></div></td>${cells}</tr>`;
  }).join("");
  return `<div class="weekly-board-print"><table class="weekly-board-table"><thead><tr><th class="associate-head">Associate / Role</th>${header}</tr></thead><tbody>${rows}</tbody></table></div>`;
}
function buildEmployeeCards(shifts, options){
  const byEmployee = {};
  shifts.forEach(s => { const key=s.employeeId||"unassigned"; (byEmployee[key] ||= []).push(s); });
  const keys = Object.keys(byEmployee).sort((a,b)=>userName(a).localeCompare(userName(b)));
  if(!keys.length) return `<div class="empty-report">No shifts found for selected filters.</div>`;
  return `<div class="employee-card-grid">${keys.map(key => {
    const list = byEmployee[key];
    return `<div class="employee-print-card"><h3>${esc(userName(key))}</h3><p>${list.length} shifts • ${totalHours(list).toFixed(1)} hours</p>${buildShiftTable(list, options)}</div>`;
  }).join("")}</div>`;
}
function buildPrintableReport(options=getReportOptions()){
  const b = business();
  const shifts = getReportShifts(options);
  const totals = reportEmployeeTotals(shifts);
  const generated = new Date().toLocaleString();
  const employeeText = options.employeeId === "all" ? "All Employees" : userName(options.employeeId);
  const header = options.sections.cover ? `
    <div class="report-letterhead">
      <div class="report-logo">MS</div>
      <div>
        <h1>${esc(b.name || "My Schedule")}</h1>
        <p>${esc(reportTitle(options))} • ${esc(formatReportRange(options))}</p>
      </div>
    </div>
    <div class="report-meta">
      <div><strong>Employee:</strong> ${esc(employeeText)}</div>
      <div><strong>Status:</strong> ${options.status === "published_only" ? "Published + Confirmed" : esc(options.status)}</div>
      <div><strong>Grouped by:</strong> ${esc(options.groupBy)}</div>
      <div><strong>Generated:</strong> ${esc(generated)}</div>
    </div>` : "";
  const kpis = "";
  const summary = options.sections.summary ? `<h2>Employee Hours Summary</h2>${buildEmployeeSummaryTable(totals)}` : "";
  let details = "";
  if(options.sections.details){
    if(options.layout === "weekly_board") details = `<h2>Weekly Schedule</h2>${buildWeeklyScheduleBoard(shifts, options)}`;
    else if(options.layout === "employee_cards") details = `<h2>Employee Schedule Cards</h2>${buildEmployeeCards(shifts, options)}`;
    else details = `<h2>${options.layout === "daily_signin" ? "Daily Sign-in Sheet" : "Shift Details"}</h2>${buildGroupedShiftTables(shifts, options)}`;
  }
  return `<div class="print-report ${options.layout} ${options.page}">${header}${kpis}${summary}${details}<p class="report-footnote">Generated by My Schedule. Use custom builder options to show/hide sections and columns before printing.</p></div>`;
}
function updateReportPreview(){ const box = el("report-preview"); if(box) box.innerHTML = buildPrintableReport(getReportOptions()); }
function printReport(){ const options = getReportOptions(); openPrintWindow(buildPrintableReport(options), `${reportTitle(options)} - ${business().name}`, options); }
function quickPrintWeek(){
  const options = {layout:"weekly_board", period:"week", employeeId:"all", status:"published_only", start:rosterWeekStart, end:addDays(rosterWeekStart,7), page:"landscape", groupBy:"employee", sections:{cover:true,kpis:true,summary:false,details:true,signature:false,notes:true}, columns:["no","employee","role","time","break","notes"]};
  openPrintWindow(buildPrintableReport(options), `${reportTitle(options)} - ${business().name}`, options);
}
function openPrintWindow(reportHtml, title, options=getReportOptions()){
  const pageMode = options.page === "portrait" ? "portrait" : "landscape";
  const styles = `
    <style>
      *{box-sizing:border-box} body{font-family:Arial,Helvetica,sans-serif;color:#111827;margin:0;padding:20px;background:#fff} .print-report{max-width:1200px;margin:0 auto}.print-report.portrait{max-width:820px}.report-letterhead{display:flex;gap:14px;align-items:center;border-bottom:3px solid #111827;padding-bottom:14px;margin-bottom:12px}.report-logo{width:52px;height:52px;border-radius:13px;background:#111827;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:900}.report-letterhead h1{font-size:22px;margin:0}.report-letterhead p{margin:4px 0 0;color:#475467}.report-meta{display:grid;grid-template-columns:repeat(2,1fr);gap:7px;background:#f8fafc;border:1px solid #e5e7eb;border-radius:12px;padding:10px;margin:12px 0}.report-kpis{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:12px 0}.report-kpis div{border:1px solid #e5e7eb;border-radius:12px;padding:10px}.report-kpis span{display:block;color:#64748b;font-size:11px;text-transform:uppercase;font-weight:700}.report-kpis strong{font-size:24px}.report-group{margin:14px 0}.report-group h3{font-size:15px;margin:0 0 7px;padding:8px 10px;background:#eef2ff;border-left:4px solid #111827}.table-wrap{overflow:visible;border:1px solid #d7dde7;border-radius:10px;margin-bottom:10px}table{width:100%;border-collapse:collapse;font-size:11.5px}th{background:#f1f5f9;text-align:left;text-transform:uppercase;font-size:10.5px;letter-spacing:.03em}td,th{border-bottom:1px solid #e5e7eb;padding:7px;vertical-align:top}td span{color:#64748b}.num{text-align:center;font-weight:800}.status-pill{display:inline-block;border:1px solid #cbd5e1;border-radius:999px;padding:2px 6px;background:#fff}.signature-cell{height:34px;min-width:110px}.employee-card-grid{display:grid;grid-template-columns:1fr;gap:14px}.employee-print-card{border:1px solid #cbd5e1;border-radius:12px;padding:12px;break-inside:avoid}.employee-print-card h3{margin:0}.employee-print-card p{margin:3px 0 10px;color:#64748b}.empty-report{padding:20px;border:1px dashed #cbd5e1;border-radius:12px;color:#64748b}.weekly-board-print{overflow:visible;border:1px solid #cbd5e1;border-radius:12px}.weekly-board-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:10.5px}.weekly-board-table th,.weekly-board-table td{border:1px solid #dbe3ef;padding:7px;vertical-align:top}.weekly-board-table th{background:#eef2ff;text-align:center;color:#111827}.weekly-board-table .associate-head{width:160px;text-align:left}.weekly-board-table .weekly-total-head{width:62px}.week-day-head strong{display:block;font-size:13px}.week-day-head span{display:block;font-size:10px;color:#64748b;margin-top:2px}.week-day-head em{display:inline-block;margin-top:4px;padding:2px 6px;border-radius:999px;background:#111827;color:#fff;font-style:normal;font-size:9.5px;font-weight:800}.weekly-employee-cell{display:flex;gap:8px;align-items:flex-start;background:#f8fafc}.weekly-employee-no{min-width:22px;height:22px;border-radius:999px;background:#111827;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:10px}.weekly-employee-cell strong{display:block}.weekly-employee-cell span{display:block;color:#64748b;font-size:10px;margin-top:2px}.weekly-employee-cell b{display:block;margin-top:4px;color:#111827;font-size:10px}.weekly-empty{text-align:center;color:#94a3b8}.weekly-empty span{display:block}.weekly-empty small{display:block;margin-top:5px;color:#cbd5e1}.weekly-shift-block{border:1px solid #dbeafe;background:#f8fbff;border-radius:8px;padding:6px;margin-bottom:5px}.weekly-shift-block:last-child{margin-bottom:0}.weekly-shift-block strong{display:block;font-size:11.5px}.weekly-shift-block span,.weekly-shift-block em,.weekly-shift-block small{display:block;color:#475467;font-style:normal;font-size:9.5px;margin-top:2px}.weekly-shift-block .weekly-shift-hours{font-weight:800;color:#0f172a}.weekly-shift-block em{font-weight:700;color:#0f172a}.weekly-cell-total{margin-top:5px;border-top:1px dashed #cbd5e1;padding-top:4px;font-weight:800;color:#111827;font-size:9.5px}.weekly-row-total{text-align:center;background:#f8fafc}.weekly-row-total strong{display:block;font-size:14px}.weekly-row-total span{display:block;color:#64748b;font-size:9px}.report-footnote{font-size:10.5px;color:#64748b;margin-top:14px}@page{size:A4 ${pageMode};margin:9mm}@media print{body{padding:0}.print-report{max-width:none}.report-letterhead{break-after:avoid}tr,.report-group,.employee-print-card{break-inside:avoid}}
    </style>`;
  const win = window.open("", "_blank");
  if(!win) return toast("Popup blocked. Allow popups, then try Print again.");
  win.document.write(`<!DOCTYPE html><html><head><title>${esc(title)}</title>${styles}</head><body>${reportHtml}<script>window.onload=function(){setTimeout(function(){window.print()},300)}<\/script></body></html>`);
  win.document.close();
}
function buildReportCSV(options=getReportOptions()){
  const cols = options.columns.filter(c => c !== "signature");
  const rows = [cols.map(columnLabel)];
  getReportShifts(options).forEach((s,i)=>{
    const u = state.users.find(x => x.id === s.employeeId) || {};
    const map = {no:i+1,date:s.date,day:fullDayName(dateObj(s.date)),employee:u.name||"Unassigned",email:u.email||"",time:`${s.start}-${s.end}`,break:Number(s.breakMinutes)||0,hours:shiftHours(s).toFixed(2),role:s.role||"",location:s.location||"",status:s.status||"",notes:s.notes||""};
    rows.push(cols.map(c => map[c] ?? ""));
  });
  return rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
}
function downloadReportCSV(){
  const options = getReportOptions();
  const csv = buildReportCSV(options);
  const blob = new Blob([csv], {type:"text/csv;charset=utf-8"});
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `myschedule-${options.period}-${options.layout}-report.csv`; a.click();
  URL.revokeObjectURL(url);
}
function buildCSV(){ return buildReportCSV({type:"hours",period:"week",employeeId:"all",status:"published_only",start:rosterWeekStart,end:addDays(rosterWeekStart,7)}); }
function downloadCSV(){ downloadReportCSV(); }
function saveBusinessSettings(){
  const b = business();
  b.name = val("biz-name"); b.industry = val("biz-industry"); b.country = val("biz-country"); b.timezone = val("biz-timezone");
  saveState(); render(); toast("Business settings saved.");
}

/* Utility */
function currentUser(){
  const u = state && state.users ? state.users.find(u => u.id === currentUserId && u.status !== "removed") : null;
  if(!u) return null;
  if(firebaseAuth && firebaseAuth.currentUser && u.authUid && firebaseAuth.currentUser.uid !== u.authUid) return null;
  return u;
}
function business(){ const u = currentUser(); return u ? (state.businesses.find(b => b.id === u.businessId) || state.businesses[0]) : null; }
function isManagerial(u=currentUser()){ return u && (u.role === "owner" || u.role === "manager"); }
function userName(id){ return state.users.find(u => u.id === id)?.name || "Unknown"; }
function openMyShifts(){
  go("myshifts");
}

function go(view){ currentView = view; renderContent(); }
function requestTypeLabel(r){
  if(!r) return "Request";
  if(r.type === "availability") return "Availability";
  if(r.type === "swap") return "Shift Swap";
  if(r.type === "change") return "Shift Change";
  return String(r.type || "Request");
}
function availabilityStatusLabel(a){
  if(!a) return "pending";
  if(a.status === "pending_removal") return "pending removal";
  return a.status || "pending";
}
function shiftDayFullName(shift){ return fullDayName(dateObj(shift.date)); }
function timesOverlap(startA,endA,startB,endB){ return toMin(startA) < toMin(endB) && toMin(startB) < toMin(endA); }
function availabilityConflict(shift){
  if(!shift || !shift.employeeId || !shift.date || !shift.start || !shift.end) return "";
  const shiftDay = shiftDayFullName(shift);
  const blocker = state.availability.find(a =>
    a.employeeId === shift.employeeId &&
    ["approved","pending_removal"].includes(a.status) &&
    a.available === false &&
    (a.date ? a.date === shift.date : a.day === shiftDay) &&
    timesOverlap(shift.start, shift.end, a.start, a.end)
  );
  if(!blocker) return "";
  return `${userName(shift.employeeId)} is approved unavailable on ${blocker.date ? friendlyDate(blocker.date) : blocker.day} ${blocker.start}-${blocker.end}. Manager cannot add this shift.`;
}
function sortShift(a,b){ return String(a.date||"").localeCompare(String(b.date||"")) || String(a.start||"").localeCompare(String(b.start||"")); }
function isPublishedStatus(s){ return ["published","confirmed"].includes(String(s?.status || "").toLowerCase()); }
function shiftHours(s){ return Math.max(0, ((toMin(s?.end || "00:00") - toMin(s?.start || "00:00")) - (Number(s?.breakMinutes)||0)) / 60); }
function totalHours(shifts){ return (shifts || []).reduce((sum,s)=>sum+shiftHours(s),0); }
function employeeIdentityIds(user=currentUser()){
  if(!user) return [];
  const ids = new Set([user.id]);
  state.employees.filter(e => e.userId === user.id || e.authUid === user.authUid || normalizeEmail(e.email) === normalizeEmail(user.email)).forEach(e => ids.add(e.id));
  return [...ids];
}
function employeeVisibleShifts(user=currentUser()){
  if(!user) return [];
  const ids = employeeIdentityIds(user);
  return state.shifts.filter(s => ids.includes(s.employeeId) && s.businessId === user.businessId && isPublishedStatus(s));
}
function inDateRange(s,start,end){ const d = dateObj(s.date); return d >= start && d < end; }
function safeShiftDateTime(s){ const d = new Date(`${s?.date || "1970-01-01"}T${s?.start || "00:00"}`); return isNaN(d) ? new Date(0) : d; }
function safeShiftEndDateTime(s){
  const start = safeShiftDateTime(s);
  if(!s || !s.end) return start;
  const end = new Date(`${s.date || "1970-01-01"}T${s.end || "00:00"}`);
  if(isNaN(end)) return start;
  if(toMin(s.end) < toMin(s.start || "00:00")) end.setDate(end.getDate()+1);
  return end;
}
function isShiftGone(s, ref=new Date()){ return safeShiftEndDateTime(s) < ref; }
function sumHours(employeeId,start,end, publishedOnly=false){
  return state.shifts
    .filter(s => s.employeeId === employeeId && (!publishedOnly || isPublishedStatus(s)) && inDateRange(s,start,end))
    .reduce((sum,s)=>sum+shiftHours(s),0);
}
function fortnightStart(date){
  const monday = getMonday(date);
  const weekNum = Math.floor((monday - new Date(monday.getFullYear(),0,1))/604800000);
  return weekNum % 2 === 0 ? monday : addDays(monday,-7);
}
function sumFortnightHours(employeeId,date,publishedOnly=false){
  const start = fortnightStart(date);
  return sumHours(employeeId,start,addDays(start,14),publishedOnly);
}
function getMonday(d){ const x = new Date(d); x.setHours(0,0,0,0); const day=x.getDay(); x.setDate(x.getDate()-day+(day===0?-6:1)); return x; }
function addDays(d,n){ const x = new Date(d); x.setDate(x.getDate()+n); return x; }
function dateObj(s){ return new Date(String(s||"1970-01-01")+"T12:00:00"); }
function isoDate(d){ return new Date(d).toISOString().slice(0,10); }
function now(){ return new Date().toISOString(); }
function shortDate(d){ return new Date(d).toLocaleDateString(undefined,{month:"short",day:"numeric"}); }
function dayName(d){ return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(d).getDay()]; }
function fullDayName(d){ return ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][new Date(d).getDay()]; }
function shortWeekday(d){ return ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"][new Date(d).getDay()]; }
function shortMonthDay(dateString){ const d = dateObj(dateString); return d.toLocaleDateString(undefined,{month:"short", day:"numeric"}); }
function friendlyDate(dateString){ const d = dateObj(dateString); return `${fullDayName(d)}, ${d.toLocaleDateString(undefined,{month:"short", day:"numeric", year:"numeric"})}`; }
function dateTime(s){ return new Date(s).toLocaleString(); }
function toMin(t){ const [h,m] = String(t).split(":").map(Number); return h*60 + m; }
function el(id){ return document.getElementById(id); }
function val(id){ return cleanText(el(id)?.value || ""); }
function uuid(){ return crypto.randomUUID ? crypto.randomUUID() : "id_"+Date.now()+"_"+Math.random().toString(16).slice(2); }
function isValidEmail(email){ return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || "").trim()); }
function cleanText(value){
  return String(value || "")
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // zero-width chars
    .replace(/\u00A0/g, " ") // non-breaking spaces
    .trim();
}
function normalizeEmail(email){
  return cleanText(email)
    .replace(/^email\s*:\s*/i, "")
    .toLowerCase()
    .replace(/\s+/g, "");
}
function cleanPassword(password){
  return cleanText(password)
    .replace(/^password\s*:\s*/i, "")
    .replace(/^temporary password\s*:\s*/i, "");
}
function readCredentialFromInput(inputId, type){
  const raw = cleanText(el(inputId)?.value || "");
  if(type === "email"){
    const match = raw.match(/(?:^|\n)\s*email\s*:\s*([^\n]+)/i);
    return match ? match[1] : raw;
  }
  if(type === "password"){
    const match = raw.match(/(?:^|\n)\s*(?:temporary\s+)?password\s*:\s*([^\n]+)/i);
    return match ? match[1] : raw;
  }
  return raw;
}
function generateTempPassword(){
  const parts = ["MS", Math.floor(1000 + Math.random()*9000), Math.random().toString(36).slice(2,5).toUpperCase()];
  return parts.join("-");
}
function esc(s=""){ return String(s).replace(/[&<>"']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[ch])); }
function escAttr(s=""){ return String(s).replace(/[&<>"\']/g, ch => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","\'":"&#039;"}[ch])); }
function attr(s=""){ return esc(s).replace(/"/g,"&quot;"); }
function emailStatusLabel(s){ const map={sent_demo:"Logged only",sending:"Sending...",sent_real:"Email sent",failed:"Failed",missing_settings:"Missing setup",sdk_missing:"Service unavailable",email_disabled:"Email off",invalid_recipient:"Invalid recipient"}; return map[s] || esc(s || "-"); }
const QUIET_TOAST_PATTERNS = [
  /live update received/i,
  /refreshing/i,
  /synced/i,
  /no email sent/i,
  /logged only/i
];
const toastMemory = { last:"", at:0, once:new Set() };
function toast(msg, opts={}){
  msg = cleanText(msg);
  if(!msg) return;

  const important = opts.important === true || /failed|error|missing|required|invalid|incorrect|blocked|unavailable|verify|sent|created|saved|published|approved|rejected|removed|deleted|offline|connection|password|email|request/i.test(msg);
  if(!important && QUIET_TOAST_PATTERNS.some(rx => rx.test(msg))) return;

  const nowMs = Date.now();
  const fingerprint = msg.toLowerCase();
  if(toastMemory.last === fingerprint && nowMs - toastMemory.at < 5000) return;
  toastMemory.last = fingerprint;
  toastMemory.at = nowMs;

  const box = el("toast");
  if(!box) return;
  box.setAttribute("role", "status");
  box.setAttribute("aria-live", "polite");

  const div = document.createElement("div");
  const tone = opts.tone || (/failed|error|incorrect|invalid|blocked|unavailable/i.test(msg) ? "toast-error" : /saved|sent|created|published|approved/i.test(msg) ? "toast-ok" : "toast-info");
  div.className = `toast-msg ${tone}`;
  div.innerHTML = `<span class="toast-dot" aria-hidden="true"></span><span>${esc(msg)}</span>`;
  box.appendChild(div);
  while(box.children.length > 2) box.removeChild(box.firstChild);
  setTimeout(()=>{ div.classList.add("toast-leave"); setTimeout(()=>div.remove(),260); }, opts.duration || 2800);
}
function firebaseErrorMessage(e){
  const code = e && e.code ? String(e.code) : "";
  const map = {
    "auth/email-already-in-use":"This email already has an account. Use Sign in or Forgot password.",
    "auth/user-not-found":"No account found for this email. Ask your owner/manager to add you, then choose Create account > Join my workplace.",
    "auth/wrong-password":"Password is incorrect. Use Forgot password to receive a reset link.",
    "auth/invalid-credential":"Login failed. Check your email/password or use Forgot password.",
    "auth/weak-password":"Password is too weak. Use at least 6 characters.",
    "auth/invalid-email":"Enter a valid email address.",
    "auth/operation-not-allowed":"Firebase Email/Password sign-in is not enabled. In Firebase Console, go to Authentication > Sign-in method and enable Email/Password.",
    "auth/too-many-requests":"Too many attempts. Wait a few minutes and try again.",
    "auth/network-request-failed":"Network error. Check internet connection and try again."
  };
  return map[code] || (e && e.message ? e.message : "Authentication failed. Please try again.");
}

async function syncFirebaseAuthSession(){
  initFirebase();
  if(!firebaseAuth) return;
  // Do not auto-open a remembered Firebase user into the app.
  // A tab/window must have its own MySchedule session and the UID must match.
  await enforceSessionSecurity(false, firebaseAuth.currentUser);
}


/* v50 QA/QT Apple-style practical workflow overrides */

function pageHero(title, subtitle, actionHtml=""){
  return `<div class="qa-page-hero"><div><span class="eyebrow">MySchedule</span><h2>${esc(title)}</h2><p>${esc(subtitle)}</p></div>${actionHtml ? `<div class="qa-hero-actions">${actionHtml}</div>` : ""}</div>`;
}

function managerDashboard(){
  const b = business();
  const employees = state.users.filter(u => u.businessId === b.id && u.role === "employee" && u.status === "active");
  const weekShifts = visibleWeekShifts();
  const pending = state.requests.filter(r => r.businessId === b.id && r.status === "pending");
  const alerts = buildAlerts();
  const publishCheck = buildPublishCheck();
  const notes = state.notifications.filter(n => n.businessId === b.id && n.userId === currentUser().id).slice(-5).reverse();
  const title = pending.length ? `${pending.length} request${pending.length === 1 ? "" : "s"} need review` : publishCheck.blockers.length ? `${publishCheck.blockers.length} publishing issue${publishCheck.blockers.length === 1 ? "" : "s"}` : alerts.length ? `${alerts.length} schedule alert${alerts.length === 1 ? "" : "s"}` : "Ready for the week";
  const subtitle = pending.length ? "Handle staff requests before publishing roster changes." : publishCheck.blockers.length ? "Fix blocked items before sending the roster to staff." : alerts.length ? "Review suggestions before publishing." : "No urgent action. Build, review, or publish your roster.";
  return `<section class="qa-dashboard">
    ${pageHero(b?.name || "Manager Dashboard", subtitle, `<button class="primary" onclick="go('${pending.length ? "requests" : "roster"}')">${pending.length ? "Review" : "Open roster"}</button>`)}
    <button class="qa-focus-card ${pending.length || publishCheck.blockers.length ? "needs-action" : "all-clear"}" onclick="go('${pending.length ? "requests" : "roster"}')">
      <span class="qa-focus-symbol">${pending.length || publishCheck.blockers.length ? "!" : "✓"}</span>
      <span><strong>${esc(title)}</strong><em>${esc(subtitle)}</em></span>
    </button>
    <div class="qa-metric-strip">
      <button onclick="go('employees')"><strong>${employees.length}</strong><span>Team</span></button>
      <button onclick="go('roster')"><strong>${totalHours(weekShifts).toFixed(1)}</strong><span>Week hrs</span></button>
      <button class="${pending.length ? "attention" : ""}" data-open-requests="true" onclick="openWorkspaceSection('requests',event)"><strong>${pending.length || "Clear"}</strong><span>Requests</span></button>
      <button class="${publishCheck.blockers.length ? "attention" : ""}" onclick="openPublishReview()"><strong>${publishCheck.blockers.length || "Ready"}</strong><span>Publish check</span></button>
    </div>
    <div class="dashboard-two-col qa-two-col">
      <div class="apple-panel qa-panel">
        <div class="apple-panel-head"><div><h3>Next best actions</h3><p>Only items that help you decide what to do now.</p></div></div>
        ${qaActionList(pending, publishCheck, alerts)}
      </div>
      <div class="apple-panel qa-panel">
        <div class="apple-panel-head"><div><h3>Inbox</h3><p>Important schedule and request messages.</p></div><button class="tiny" onclick="go('notifications')">Open</button></div>
        ${dashboardNotificationList(notes)}
      </div>
    </div>
  </section>`;
}

function qaActionList(pending, publishCheck, alerts){
  const items = [];
  pending.slice(0,3).forEach(r => items.push(`<button class="action-item" onclick="go('requests')"><span class="dot urgent"></span><div><strong>${esc(userName(r.employeeId || r.userId))}</strong><small>${esc(requestLabel(r))} waiting for approval</small></div><em>Review</em></button>`));
  publishCheck.blockers.slice(0,3-pending.length).forEach(b => items.push(`<button class="action-item" onclick="openPublishReview()"><span class="dot urgent"></span><div><strong>Cannot publish yet</strong><small>${esc(b)}</small></div><em>Fix</em></button>`));
  if(items.length < 3) alerts.slice(0,3-items.length).forEach(a => items.push(`<button class="action-item" onclick="go('roster')"><span class="dot warn"></span><div><strong>${esc(a.employee || "Schedule alert")}</strong><small>${esc(a.message)}</small></div><em>Check</em></button>`));
  if(!items.length) items.push(`<button class="action-item" onclick="go('roster')"><span class="dot"></span><div><strong>Roster is calm</strong><small>No current requests, conflicts, or urgent alerts.</small></div><em>Open</em></button>`);
  return `<div class="action-list">${items.join("")}</div>`;
}

function rosterView(){
  const b = business();
  const weekShifts = visibleWeekShifts();
  const monthStart = new Date(rosterWeekStart.getFullYear(), rosterWeekStart.getMonth(), 1);
  const monthEnd = new Date(rosterWeekStart.getFullYear(), rosterWeekStart.getMonth()+1, 1);
  const monthHours = totalHours(state.shifts.filter(s => s.businessId === b.id && dateObj(s.date) >= monthStart && dateObj(s.date) < monthEnd));
  const check = buildPublishCheck();
  return `<section class="qa-roster-page">
    ${pageHero("Roster Builder", "Draft safely, check conflicts, then publish with confidence.", `<button class="primary" onclick="openShiftModal()">Add shift</button>`)}
    <div class="qa-metric-strip compact">
      <button onclick="focusRosterBoard()"><strong>${totalHours(weekShifts).toFixed(1)}</strong><span>Week hrs</span></button>
      <button onclick="focusRosterBoard()"><strong>${monthHours.toFixed(1)}</strong><span>Month hrs</span></button>
      <button onclick="focusRosterBoard()"><strong>${weekShifts.length}</strong><span>Shifts</span></button>
      <button class="${check.blockers.length ? "attention" : ""}" onclick="openPublishReview()"><strong>${check.blockers.length ? check.blockers.length : "OK"}</strong><span>Checks</span></button>
    </div>
    <div class="panel roster-panel qa-roster-shell">
      <div class="schedule-toolbar apple-week-toolbar qa-week-toolbar">
        <div class="week-switcher">
          <button class="week-arrow" aria-label="Previous week" title="Previous week" onclick="changeRosterWeek(-7)">‹</button>
          <button class="week-pill" onclick="focusRosterBoard()">${shortDate(rosterWeekStart)} – ${shortDate(addDays(rosterWeekStart,6))}</button>
          <button class="week-arrow" aria-label="Next week" title="Next week" onclick="changeRosterWeek(7)">›</button>
        </div>
        <div class="week-actions qa-week-actions">
          <button onclick="copyVisibleWeek()">Copy</button>
          <button onclick="pasteCopiedWeek()">Paste</button>
          <button onclick="copyWeekToNextWeek()">Next</button>
          <button class="primary publish-main" onclick="openPublishReview()">Publish</button>
          <button class="success" onclick="quickPrintWeek()">Print</button>
          <button class="danger" onclick="clearWeek()">Clear</button>
        </div>
      </div>
      ${check.blockers.length ? `<div class="qa-warning-line"><strong>Publish blocked</strong><span>${esc(check.blockers[0])}</span><button class="tiny" onclick="openPublishReview()">Review</button></div>` : `<div class="qa-ok-line"><strong>Ready check passed</strong><span>Availability and overlap checks look clear for this week.</span></div>`}
      ${scheduleBoard(weekShifts)}
    </div>
    <details class="qa-details"><summary>More roster details</summary><div class="panel"><h3>Employee hour summary</h3>${employeeHoursSummaryTable(weekShifts)}</div><div class="panel"><h3>Shift list</h3>${shiftsTable(weekShifts, true)}</div></details>
  </section>`;
}

function scheduleBoard(shifts){
  const days = Array.from({length:7},(_,i)=>addDays(rosterWeekStart,i));
  return `<div class="schedule-scroll-shell" id="schedule-scroll-shell"><div class="schedule-board qa-schedule-board">
    ${days.map(day=>{
      const date = isoDate(day);
      const rows = shifts.filter(s => s.date === date).sort(sortShift);
      return `<div class="day-column qa-day-column" ondragover="allowDrop(event)" ondragleave="dragLeave(event)" ondrop="dropShift(event,'${date}')">
        <div class="day-head qa-day-head"><div><strong>${dayName(day)}</strong><span>${shortDate(day)}</span></div><em>${totalHours(rows).toFixed(1)} hrs</em></div>
        <button class="tiny full qa-add-shift" onclick="openShiftModal('', '${date}')">Add</button>
        <div class="shift-cards">${rows.map(scheduleCard).join("") || `<div class="empty-shift">No shifts</div>`}</div>
      </div>`;
    }).join("")}
  </div></div>`;
}

function scheduleCard(s){
  return `<div class="shift-card qa-shift-card ${s.status}" draggable="true" ondragstart="dragShift(event,'${s.id}')" title="Drag to another day">
    <div class="shift-time">${esc(s.start)} – ${esc(s.end)}</div>
    <div class="qa-shift-person"><strong>${esc(userName(s.employeeId))}</strong><span>${esc(s.role || "Shift")}</span></div>
    <div class="qa-shift-meta"><span>${shiftHours(s).toFixed(1)} hrs</span><span class="badge ${s.status}">${esc(s.status)}</span></div>
    <div class="actions qa-shift-actions">
      <button class="tiny" onclick="openShiftModal('${s.id}')">Edit</button>
      <button class="tiny" onclick="duplicateShift('${s.id}')">Copy</button>
      <button class="tiny ghost" onclick="markReady('${s.id}')">Ready</button>
      <button class="tiny danger" onclick="deleteShift('${s.id}')">Delete</button>
    </div>
  </div>`;
}

function buildPublishCheck(){
  const rows = visibleWeekShifts().slice().sort(sortShift);
  const blockers = [];
  const warnings = [];
  rows.forEach(s => {
    if(!s.employeeId || userName(s.employeeId) === "Unknown") blockers.push(`${friendlyDate(s.date)} has a shift with no valid employee.`);
    if(!s.date || !s.start || !s.end) blockers.push(`A shift is missing date or time.`);
    if(toMin(s.end) <= toMin(s.start)) blockers.push(`${userName(s.employeeId)} has an invalid time on ${friendlyDate(s.date)}.`);
    const av = availabilityConflict(s);
    if(av) blockers.push(av);
  });
  const byEmpDay = {};
  rows.forEach(s => {
    const key = `${s.employeeId}|${s.date}`;
    byEmpDay[key] = byEmpDay[key] || [];
    byEmpDay[key].push(s);
  });
  Object.values(byEmpDay).forEach(list => {
    list.sort((a,b)=>a.start.localeCompare(b.start));
    for(let i=0;i<list.length;i++){
      for(let j=i+1;j<list.length;j++){
        if(timesOverlap(list[i].start, list[i].end, list[j].start, list[j].end)) blockers.push(`${userName(list[i].employeeId)} has overlapping shifts on ${friendlyDate(list[i].date)}.`);
      }
    }
  });
  const exactSeen = new Set();
  rows.forEach(s => {
    const key = [s.employeeId,s.date,s.start,s.end,s.role || ""].join("|");
    if(exactSeen.has(key)) warnings.push(`${userName(s.employeeId)} may have a duplicate shift on ${friendlyDate(s.date)} ${s.start}-${s.end}.`);
    exactSeen.add(key);
  });
  const employees = state.users.filter(u => u.businessId === business().id && u.role === "employee" && u.status === "active");
  employees.forEach(u => {
    const emp = state.employees.find(e => e.userId === u.id || e.id === u.id);
    const limit = Number(emp?.weeklyLimit) || 0;
    const hrs = totalHours(rows.filter(s => s.employeeId === u.id));
    if(limit && hrs > limit) warnings.push(`${u.name} is ${hrs.toFixed(1)} hrs, above selected ${limit}.`);
  });
  return {rows, blockers:[...new Set(blockers)], warnings:[...new Set(warnings)]};
}

function openPublishReview(){
  const check = buildPublishCheck();
  const total = totalHours(check.rows).toFixed(1);
  const employees = new Set(check.rows.map(s => s.employeeId)).size;
  modal(`<div class="qa-publish-modal"><span class="eyebrow">Publish review</span><h3>Ready to publish?</h3><p class="muted">MySchedule checked availability, overlap, missing details, and hour warnings before staff are notified.</p>
    <div class="qa-publish-stats"><div><strong>${check.rows.length}</strong><span>Shifts</span></div><div><strong>${total}</strong><span>Hours</span></div><div><strong>${employees}</strong><span>Employees</span></div></div>
    ${check.blockers.length ? `<div class="qa-review-box danger-box"><strong>Fix before publishing</strong>${check.blockers.map(x=>`<p>${esc(x)}</p>`).join("")}</div>` : `<div class="qa-review-box ok-box"><strong>No blocking issues</strong><p>Roster can be published. Employees will receive important notifications only.</p></div>`}
    ${check.warnings.length ? `<div class="qa-review-box warn-box"><strong>Worth checking</strong>${check.warnings.slice(0,6).map(x=>`<p>${esc(x)}</p>`).join("")}</div>` : ``}
    <div class="actions" style="margin-top:16px"><button onclick="closeModal()">Cancel</button><button class="primary" ${check.blockers.length ? "disabled" : ""} onclick="confirmPublishWeekFromReview()">Publish week</button></div></div>`);
}

function confirmPublishWeekFromReview(){
  const check = buildPublishCheck();
  if(check.blockers.length) return toast("Fix blocked schedule items before publishing.");
  closeModal();
  publishWeek(true);
}

function publishWeek(fromReview=false){
  const rows = visibleWeekShifts();
  if(rows.length === 0) return toast("No shifts in this week to publish.");
  const check = buildPublishCheck();
  if(check.blockers.length) return openPublishReview();
  if(!fromReview) return openPublishReview();
  const weekStartText = friendlyDate(isoDate(rosterWeekStart));
  const weekEndText = friendlyDate(isoDate(addDays(rosterWeekStart,6)));
  const byEmployee = {};
  rows.forEach(s => {
    s.businessId = s.businessId || business().id;
    s.status = "published";
    if(!byEmployee[s.employeeId]) byEmployee[s.employeeId] = [];
    byEmployee[s.employeeId].push(s);
  });
  Object.entries(byEmployee).forEach(([employeeId, empShifts]) => {
    empShifts.sort(sortShift);
    const totalHours = empShifts.reduce((sum, s) => sum + shiftHours(s), 0).toFixed(1);
    const rosterLines = empShifts.map((s, i) => {
      const d = dateObj(s.date);
      const dateLabel = d.toLocaleDateString(undefined,{weekday:"long",month:"short",day:"numeric",year:"numeric"});
      return `${i+1}. ${dateLabel}\n   ${formatEmailShiftTime(s.start)} – ${formatEmailShiftTime(s.end)}${emailShiftCrossesMidnight(s) ? " next day" : ""} · ${shiftHours(s).toFixed(1)} hrs · ${s.role || "Shift"}${s.location ? ` · ${s.location}` : ""}${s.notes ? `\n   Note: ${s.notes}` : ""}`;
    }).join("\n\n");
    notifyUser(employeeId,"roster",`Your upcoming shifts at ${business().name}`,`Your roster for ${weekStartText} to ${weekEndText} is published.\n\n${rosterLines}\n\nSummary\n${empShifts.length} shift${empShifts.length === 1 ? "" : "s"} · ${totalHours} total hours\n\nOpen MySchedule to review the latest shift details.`,{templateType:"roster",weekStartText,weekEndText,totalShifts:empShifts.length,totalHours,shifts:empShifts.map((s, idx) => ({...s,number:idx+1,dayName:fullDayName(dateObj(s.date)),shortDate:dateObj(s.date).toLocaleDateString(undefined,{month:"short", day:"numeric", year:"numeric"}),friendlyDate:friendlyDate(s.date),hours:shiftHours(s).toFixed(1),breakMinutes:Number(s.breakMinutes)||0,location:s.location || "",role:s.role || "Shift",status:"Published",notes:s.notes || ""}))});
  });
  saveState();
  renderContent();
  toast("Week published and staff notified.");
}

function notificationsView(filter="all"){
  const user = currentUser();
  const allRows = state.notifications.filter(n => n.userId === user.id).sort((a,b)=>(b.createdAt || "").localeCompare(a.createdAt || ""));
  const actionRows = allRows.filter(notificationNeedsAction);
  const rows = filter === "action" ? actionRows : allRows;
  const historyRows = notificationHistoryForUser(user).slice(0,8);
  return `<section class="apple-notification-page simple-inbox apple-clean-page qa-notifications">
    ${pageHero("Inbox", "Important roster, request, and approval messages only.", `<button class="ghost" onclick="markAllRead()">Mark read</button><button class="danger" onclick="clearMine()">Clear all</button>`)}
    <div class="qa-inbox-tabs apple-segment"><button class="${filter !== "action" ? "active" : ""}" onclick="showAllNotifications()">All <span>${allRows.length}</span></button><button class="${filter === "action" ? "active" : ""}" onclick="showActionNeededOnly()">Action needed <span>${actionRows.length}</span></button></div>
    <div id="notificationListHost">${myNotificationsCards(rows)}</div>
    ${historyRows.length ? `<details class="apple-history notification-history"><summary>Cleared history</summary>${notificationHistoryCards(historyRows)}</details>` : ``}
  </section>`;
}

function myNotificationsCards(rows){
  if(!rows.length) return `<div class="apple-empty-state qa-empty"><div class="apple-empty-icon">✓</div><h3>All clear</h3><p class="muted">No notifications in this view.</p></div>`;
  return `<div class="apple-notification-list simple-list qa-note-list">${rows.map(n => {
    const title = esc(cleanNotificationSubject(n));
    const message = esc(cleanNotificationMessage(n));
    const created = n.createdAt || now();
    return `<article class="apple-note-card simple-note qa-note-card ${n.read ? "is-read" : "is-new"}" onclick="openNotification('${n.id}')">
      <div class="qa-note-icon">${notificationIcon(n)}</div><div class="apple-note-main"><div class="apple-note-top"><div><h3>${title}</h3><p class="apple-note-meta">${friendlyDate(created.slice(0,10))} · ${relativeTime(created)}</p></div>${!n.read ? `<span class="ios-badge new-dot">New</span>` : ``}</div><p class="apple-note-message">${message}</p><div class="apple-note-footer simple-footer"><button class="tiny apple-link-button" onclick="event.stopPropagation(); openNotification('${n.id}')">${notificationActionLabel(n)}</button><button class="tiny apple-clear-button" onclick="event.stopPropagation(); clearNotification('${n.id}')">Clear</button></div></div>
    </article>`;}).join("")}</div>`;
}

function showAllNotifications(){
  const host = document.getElementById("notificationListHost");
  const user = currentUser();
  const rows = state.notifications.filter(n => n.userId === user.id).sort((a,b)=>(b.createdAt||"").localeCompare(a.createdAt||""));
  if(host) host.innerHTML = myNotificationsCards(rows); else renderContent();
  document.querySelectorAll(".qa-inbox-tabs button").forEach((btn,i)=>btn.classList.toggle("active", i===0));
}
function showActionNeededOnly(){
  const host = document.getElementById("notificationListHost");
  const user = currentUser();
  const rows = state.notifications.filter(n => n.userId === user.id && notificationNeedsAction(n)).sort((a,b)=>(b.createdAt||"").localeCompare(a.createdAt||""));
  if(host) host.innerHTML = myNotificationsCards(rows); else renderContent();
  document.querySelectorAll(".qa-inbox-tabs button").forEach((btn,i)=>btn.classList.toggle("active", i===1));
}

function requestsView(managerMode){
  const allRows = managerMode ? state.requests.filter(r => r.businessId === business().id).sort((a,b)=>(b.createdAt||"").localeCompare(a.createdAt||"")) : state.requests.filter(r => r.employeeId === currentUser().id).sort((a,b)=>(b.createdAt||"").localeCompare(a.createdAt||""));
  const currentRows = allRows.filter(r => r.status === "pending");
  const completedCount = allRows.length - currentRows.length;
  return `<section class="apple-requests-page qa-requests-page">
    ${pageHero(managerMode ? "Requests" : "My Requests", "Current items only. Finished requests stay in history for later clarification.", `${currentRows.length ? `<span class="apple-count-bubble">${currentRows.length}</span>` : `<span class="apple-clear-bubble">0</span>`}`)}
    ${currentRows.length ? requestsCards(currentRows, managerMode) : `<div class="apple-empty-state qa-empty"><div class="apple-empty-icon">✓</div><h3>No current requests</h3><p class="muted">Availability, swap, and change requests will appear here only when action is needed.</p></div>`}
    ${completedCount ? `<details class="apple-history"><summary>Request history (${completedCount})</summary>${requestsCards(allRows.filter(r => r.status !== "pending"), managerMode, true)}</details>` : ``}
  </section>`;
}

function employeeWorkView(){
  const user = currentUser();
  if(!user) return `<div class="panel"><h2>My Shifts</h2><p class="muted">Please sign in again to view your published shifts.</p></div>`;
  const publishedAll = employeeVisibleShifts(user).sort(sortShift);
  const nowTime = new Date();
  const activePublished = publishedAll.filter(s => !isShiftGone(s, nowTime)).sort(sortShift);
  const pastPublished = publishedAll.filter(s => isShiftGone(s, nowTime)).sort(sortShift).reverse();
  const weekEnd = addDays(rosterWeekStart,7);
  const weekShifts = activePublished.filter(s => inDateRange(s, rosterWeekStart, weekEnd));
  const week = totalHours(weekShifts);
  const fortnightShifts = activePublished.filter(s => inDateRange(s, fortnightStart(new Date()), addDays(fortnightStart(new Date()), 14)));
  const fortnight = totalHours(fortnightShifts);
  const upcomingShifts = activePublished.filter(s => safeShiftDateTime(s) >= nowTime).sort(sortShift);
  const nextShift = upcomingShifts[0];
  const pendingMine = state.requests.filter(r => r.employeeId === user.id && r.status === "pending").length;
  return `<section class="employee-apple-dashboard qa-employee-page">
    ${pageHero("My Shifts", "Your active published roster, requests, and availability in one calm view.")}
    <button class="dashboard-focus-card ${nextShift ? "all-clear" : ""}" onclick="${nextShift ? "document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})" : "go('availability')"}">
      <span class="focus-icon">${nextShift ? "→" : "✓"}</span><div><strong>${nextShift ? `${fullDayName(dateObj(nextShift.date))}, ${friendlyDate(nextShift.date)}` : "No upcoming published shift"}</strong><span>${nextShift ? `${esc(nextShift.start)} – ${esc(nextShift.end)} · ${shiftHours(nextShift).toFixed(1)} hrs` : "Completed shifts are stored under previous shifts only when you need them."}</span></div>
    </button>
    <div class="qa-metric-strip compact emp-metrics">
      <button onclick="document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})"><strong>${week.toFixed(1)}</strong><span>This week</span></button>
      <button onclick="document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})"><strong>${upcomingShifts.length}</strong><span>Upcoming</span></button>
      <button class="${pendingMine ? "attention" : ""}" onclick="go('myrequests')"><strong>${pendingMine ? pendingMine : "0"}</strong><span>Requests</span></button>
      <button onclick="go('availability')"><strong>Set</strong><span>Availability</span></button>
    </div>
    <div class="dashboard-two-col qa-two-col"><div class="apple-panel qa-panel"><div class="apple-panel-head"><div><h3>Upcoming</h3><p>Your next active published shifts.</p></div></div>${upcomingShiftMiniList(upcomingShifts.slice(0,4))}</div><div class="apple-panel qa-panel"><div class="apple-panel-head"><div><h3>Quick actions</h3><p>Request changes only for active/upcoming shifts.</p></div></div><div class="action-list"><button class="action-item" onclick="go('availability')"><span class="dot"></span><div><strong>Request unavailable</strong><small>Submit date, day, time and reason.</small></div><em>Open</em></button><button class="action-item" onclick="go('myrequests')"><span class="dot"></span><div><strong>My requests</strong><small>Track current approvals.</small></div><em>View</em></button><button class="action-item" onclick="go('notifications')"><span class="dot"></span><div><strong>Inbox</strong><small>Roster and approval updates.</small></div><em>Open</em></button>${nextShift ? `<button class="action-item" onclick="openChangeModal('${nextShift.id}')"><span class="dot"></span><div><strong>Request change</strong><small>For your next shift only.</small></div><em>Ask</em></button>` : ``}</div></div></div>
    <div class="apple-panel" id="my-published-schedule"><div class="apple-panel-head"><div><h3>Published schedule</h3><p>Only active/upcoming shifts appear here. Completed shifts stay in history without actions.</p></div><span class="status-pill">${upcomingShifts.length} upcoming</span></div>${activePublished.length ? employeeShiftCardList(activePublished) : `<div class="apple-empty-mini"><strong>No active published shifts</strong><span>Past shifts are moved to history. New shifts will appear here after publishing.</span></div>`}${employeePastShiftHistory(pastPublished)}</div>
  </section>`;
}




/* v51 QA/QT hardening: employee-side actions and safe fallbacks */
function upcomingShiftMiniList(rows){
  if(!rows || !rows.length) return `<div class="apple-empty-mini"><strong>No upcoming shifts</strong><span>You are clear for now.</span></div>`;
  return `<div class="employee-shift-list compact qa-upcoming-mini">${rows.map(s => employeeShiftCard(s, true)).join("")}</div>`;
}

function quickPrintMySchedule(){
  const user = currentUser();
  if(!user) return toast("Please sign in again before printing.");
  const shifts = employeeVisibleShifts(user).filter(s => !isShiftGone(s)).sort(sortShift);
  if(!shifts.length) return toast("No active published shifts to print yet.");
  window.print();
}

function openNotificationTarget(id){
  return openNotification(id);
}

function safeGo(viewName){
  try { go(viewName); } catch(e) { console.warn(e); toast("Could not open that section. Please try again."); }
}

/* v52 QA/QT hardening: employee cards respect shift lifecycle */
const _v52EmployeeShiftCard = employeeShiftCard;
function employeeShiftCard(s, compact, past=false){
  if(!s) return "";
  const d = s.date ? dateObj(s.date) : new Date();
  const start = s.start || "--:--";
  const end = s.end || "--:--";
  const hrs = (s.start && s.end) ? shiftHours(s).toFixed(1) : "0.0";
  const safeStatus = esc(s.status || "published");
  const gone = past || isShiftGone(s);
  const canManage = !compact && !gone;
  return `<div class="employee-shift-row ${gone ? "is-past" : ""}">
    <div class="employee-date-badge"><strong>${shortWeekday(d)}</strong><span>${s.date ? shortMonthDay(s.date) : "Date"}</span></div>
    <div class="employee-shift-main">
      <strong>${esc(start)} - ${esc(end)}</strong>
      <span>${hrs} hrs${s.notes ? " · " + esc(s.notes) : ""}</span>
    </div>
    ${compact ? `<span class="status-pill ${safeStatus}">${safeStatus}</span>` : canManage ? `<details class="action-menu"><summary>Manage</summary><div class="action-menu-list"><button onclick="openChangeModal('${s.id}')">Request Change</button><button onclick="openSwapModal('${s.id}')">Request Swap</button></div></details>` : `<span class="status-pill muted-pill">Completed</span>`}
  </div>`;
}


/* v51 QA/QT hardening: clearer published-schedule print fallback */
function printMySchedule(){
  return quickPrintMySchedule();
}


/* v53 deep QA/QT: clean copied labels, week-wise previous shifts, safer employee lifecycle */
function cleanShiftNoteForEmployee(note){
  return String(note || "")
    .replace(/\s*\(copy\)\s*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
function cleanShiftNoteForStorage(note){
  return cleanShiftNoteForEmployee(note);
}
function weekKeyForShift(s){
  return isoDate(getMonday(dateObj(s.date)));
}
function weekLabelFromKey(key){
  const start = dateObj(key);
  const end = addDays(start, 6);
  return `${shortDate(start)} - ${shortDate(end)}`;
}
function groupShiftsByWeek(rows){
  const groups = new Map();
  (rows || []).slice().sort((a,b)=>sortShift(b,a)).forEach(s => {
    const key = weekKeyForShift(s);
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  });
  return [...groups.entries()].sort((a,b)=>String(b[0]).localeCompare(String(a[0])));
}
function employeePastShiftHistory(rows){
  if(!rows || !rows.length) return "";
  const groups = groupShiftsByWeek(rows);
  return `<details class="history-fold employee-history-fold week-history">
    <summary>Previous shifts <span>${rows.length}</span></summary>
    <div class="week-history-list">
      ${groups.map(([key, shifts], index) => {
        const weekHours = totalHours(shifts).toFixed(1);
        return `<details class="week-history-card" ${index === 0 ? "open" : ""}>
          <summary><div><strong>${weekLabelFromKey(key)}</strong><small>${shifts.length} shift${shifts.length === 1 ? "" : "s"} · ${weekHours} hrs</small></div><em>View</em></summary>
          <div class="employee-shift-list history-list">${shifts.sort(sortShift).map(s => employeeShiftCard(s, false, true)).join("")}</div>
        </details>`;
      }).join("")}
    </div>
  </details>`;
}
function employeeShiftCard(s, compact, past=false){
  if(!s) return "";
  const d = s.date ? dateObj(s.date) : new Date();
  const start = s.start || "--:--";
  const end = s.end || "--:--";
  const hrs = (s.start && s.end) ? shiftHours(s).toFixed(1) : "0.0";
  const safeStatus = esc(s.status || "published");
  const gone = past || isShiftGone(s);
  const canManage = !compact && !gone;
  const employeeNote = cleanShiftNoteForEmployee(s.notes);
  return `<div class="employee-shift-row ${gone ? "is-past" : ""}">
    <div class="employee-date-badge"><strong>${shortWeekday(d)}</strong><span>${s.date ? shortMonthDay(s.date) : "Date"}</span></div>
    <div class="employee-shift-main">
      <strong>${esc(start)} - ${esc(end)}</strong>
      <span>${hrs} hrs${employeeNote ? " · " + esc(employeeNote) : ""}</span>
    </div>
    ${compact ? `<span class="status-pill ${safeStatus}">${safeStatus}</span>` : canManage ? `<details class="action-menu"><summary>Manage</summary><div class="action-menu-list"><button onclick="openChangeModal('${s.id}')">Request Change</button><button onclick="openSwapModal('${s.id}')">Request Swap</button></div></details>` : `<span class="status-pill muted-pill">Completed</span>`}
  </div>`;
}
function duplicateShift(id){
  const s = state.shifts.find(x => x.id === id);
  if(!s) return;
  const copy = {...s,id:uuid(),status:"draft",notes:cleanShiftNoteForStorage(s.notes)};
  const availabilityBlock = availabilityConflict(copy);
  if(availabilityBlock) return toast(availabilityBlock);
  state.shifts.push(copy);
  saveState(); renderContent();
}
function copyShiftNextDay(id){
  const s = state.shifts.find(x => x.id === id);
  if(!s) return;
  const copy = {...s,id:uuid(),date:isoDate(addDays(dateObj(s.date),1)),status:"draft",notes:cleanShiftNoteForStorage(s.notes)};
  const availabilityBlock = availabilityConflict(copy);
  if(availabilityBlock) return toast(availabilityBlock);
  state.shifts.push(copy);
  saveState(); renderContent();
}
function copyVisibleWeek(){
  copiedWeekBuffer = visibleWeekShifts().map(s => ({...s, notes: cleanShiftNoteForStorage(s.notes)}));
  renderContent();
  toast(`${copiedWeekBuffer.length} shifts copied.`);
}
function pasteCopiedWeek(){
  if(!copiedWeekBuffer || copiedWeekBuffer.length === 0) return toast("Nothing copied.");
  const sourceStart = getMonday(dateObj(copiedWeekBuffer[0].date));
  copiedWeekBuffer.forEach(s => {
    const offset = Math.round((dateObj(s.date) - sourceStart) / 86400000);
    state.shifts.push({...s, id:uuid(), date:isoDate(addDays(rosterWeekStart, offset)), status:"draft", notes: cleanShiftNoteForStorage(s.notes)});
  });
  saveState(); renderContent(); toast("Copied shifts pasted as draft.");
}
function copyWeekToNextWeek(){
  const rows = visibleWeekShifts();
  if(rows.length === 0) return toast("No shifts to copy.");
  rows.forEach(s => state.shifts.push({...s, id:uuid(), date:isoDate(addDays(dateObj(s.date),7)), status:"draft", notes: cleanShiftNoteForStorage(s.notes)}));
  saveState(); renderContent(); toast("Week copied to next week.");
}

async function boot(){
  startInactivityGuard();
  updateTopbarAuthVisibility(null);
  const app = el("app");
  if(app) app.innerHTML = `<section class="auth-wrap"><div class="auth-card card"><h2>Loading MySchedule...</h2><p class="muted">Connecting securely.</p></div></section>`;
  initFirebase();
  await waitForFirebaseAuthInitialState();
  state = await loadState();
  startAuthGuard();
  if(firebaseAuth && firebaseAuth.currentUser) startFirebaseLiveUpdates();
  await syncFirebaseAuthSession();
  render();
}
boot();

/* v57 workforce essentials: clock, breaks, timesheets, shift acknowledgement, notice board */
function ensureOperationsData(){
  if(!state) return;
  if(!Array.isArray(state.timesheets)) state.timesheets = [];
  if(!Array.isArray(state.notices)) state.notices = [];
  if(!Array.isArray(state.noticeReads)) state.noticeReads = [];
  if(Array.isArray(state.shifts)) state.shifts.forEach(s => { if(!Array.isArray(s.acknowledgedBy)) s.acknowledgedBy = []; });
}

const _v57OldShellView = shellView;
function shellView(user){
  ensureOperationsData();
  const nav = isManagerial(user) ? `
    <button data-view="dashboard" onclick="go('dashboard')">Dashboard</button>
    <button data-view="roster" onclick="go('roster')">Roster</button>
    <button data-view="employees" onclick="go('employees')">Employees</button>
    <button data-view="credentials" onclick="go('credentials')">Access</button>
    <button data-view="requests" onclick="go('requests')">Requests</button>
    <button data-view="timesheets" onclick="go('timesheets')">Timesheets</button>
    <button data-view="notices" onclick="go('notices')">Notices</button>
    <button data-view="reports" onclick="go('reports')">Reports</button>
    ${user.role === "owner" ? `<button data-view="settings" onclick="go('settings')">Settings</button>` : ""}
  ` : `
    <button data-view="myshifts" onclick="go('myshifts')">My Shifts</button>
    <button data-view="clock" onclick="go('clock')">Clock</button>
    <button data-view="availability" onclick="go('availability')">Availability</button>
    <button data-view="myrequests" onclick="go('myrequests')">Requests</button>
    <button data-view="notices" onclick="go('notices')">Notices</button>
  `;
  return `<section class="layout mobile-ready-shell role-${user.role}">
    <aside class="sidebar" aria-label="Workspace navigation"><nav class="nav">${nav}</nav></aside>
    <section class="content"><div id="view"></div></section>
  </section>`;
}

function renderContent(){
  ensureOperationsData();
  document.querySelectorAll(".nav button").forEach(btn => btn.classList.toggle("active", btn.dataset.view === currentView));
  const view = el("view");
  if(!view) return;
  const user = currentUser();
  if(!user){ render(); return; }
  if(currentView === "profile"){ view.innerHTML = profileView(); return; }
  if(isManagerial(user)){
    if(currentView === "dashboard") view.innerHTML = managerDashboard();
    else if(currentView === "roster") view.innerHTML = rosterView();
    else if(currentView === "employees") view.innerHTML = employeesView();
    else if(currentView === "credentials") view.innerHTML = credentialsView();
    else if(currentView === "requests") view.innerHTML = requestsView(true);
    else if(currentView === "timesheets") view.innerHTML = timesheetsView();
    else if(currentView === "notices") view.innerHTML = noticesView(true);
    else if(currentView === "reports") view.innerHTML = reportsView();
    else if(currentView === "notifications") view.innerHTML = notificationsView();
    else if(currentView === "settings") view.innerHTML = settingsView();
    else view.innerHTML = managerDashboard();
  }else{
    if(currentView === "myshifts" || currentView === "mywork" || currentView === "myhours") view.innerHTML = employeeWorkView();
    else if(currentView === "availability") view.innerHTML = availabilityView();
    else if(currentView === "myrequests") view.innerHTML = requestsView(false);
    else if(currentView === "clock") view.innerHTML = clockView();
    else if(currentView === "notices") view.innerHTML = noticesView(false);
    else if(currentView === "notifications") view.innerHTML = notificationsView();
    else view.innerHTML = employeeWorkView();
  }
}

function currentOpenTimesheet(employeeId){
  ensureOperationsData();
  return state.timesheets.find(t => t.employeeId === employeeId && !t.clockOut) || null;
}
function activeBreak(t){ return t && Array.isArray(t.breaks) ? t.breaks.find(b => b.start && !b.end) : null; }
function breakMinutesFor(t){
  if(!t || !Array.isArray(t.breaks)) return Number(t.breakMinutes)||0;
  return t.breaks.reduce((sum,b)=>{
    if(!b.start) return sum;
    const end = b.end ? new Date(b.end) : new Date();
    return sum + Math.max(0, Math.round((end - new Date(b.start))/60000));
  }, 0);
}
function workedHoursFor(t){
  if(!t || !t.clockIn) return 0;
  const out = t.clockOut ? new Date(t.clockOut) : new Date();
  const gross = Math.max(0, (out - new Date(t.clockIn))/3600000);
  return Math.max(0, gross - breakMinutesFor(t)/60);
}
function todaysScheduledShift(user){
  const today = isoDate(new Date());
  const visible = employeeVisibleShifts(user)
    .filter(s => s.date === today && !isShiftGone(s))
    .sort(sortShift);
  if(!visible.length) return null;
  const nowTime = new Date();
  return visible.slice().sort((a,b)=>{
    const da = Math.abs(nowTime - scheduledStartDate(a));
    const db = Math.abs(nowTime - scheduledStartDate(b));
    return da - db;
  })[0] || visible[0];
}
function scheduledStartDate(shift){
  if(!shift || !shift.date || !shift.start) return new Date(NaN);
  return new Date(`${shift.date}T${shift.start}:00`);
}
function clockWindowInfo(user){
  const shift = todaysScheduledShift(user);
  if(!shift){
    return {shift:null, canClock:false, mode:"unscheduled", title:"No scheduled shift today", message:"Normal Clock In is available only for a published shift assigned to you. Use Emergency Clock In only if a manager asked you to work or there is an urgent business reason."};
  }
  const start = scheduledStartDate(shift);
  if(isNaN(start.getTime())){
    return {shift, canClock:false, mode:"invalid", title:"Shift time needs review", message:"This shift has an invalid start time. Ask a manager to correct the roster before clocking in."};
  }
  const diff = Math.round((new Date() - start) / 60000);
  const earlyLimit = -10;
  const lateLimit = 10;
  if(diff >= earlyLimit && diff <= lateLimit){
    return {shift, canClock:true, mode:"normal", title:"Clock In available", message:`You are within the 10-minute clock-in window for your ${shift.start} shift.`};
  }
  if(diff < earlyLimit){
    return {shift, canClock:false, mode:"too_early", title:"Clock In opens soon", message:`You can clock in from 10 minutes before your ${shift.start} shift. Emergency Clock In is only for manager-approved exceptions.`};
  }
  return {shift, canClock:false, mode:"late", title:"Outside normal window", message:`The normal clock-in window for your ${shift.start} shift has passed. Use Emergency Clock In only if you need manager review.`};
}

function timeAddMinutes(time, minutes){
  if(!time || !/^\d{2}:\d{2}$/.test(time)) return time || "";
  const [h,m] = time.split(":").map(Number);
  const base = new Date(2000,0,1,h,m,0,0);
  base.setMinutes(base.getMinutes() + minutes);
  return `${String(base.getHours()).padStart(2,"0")}:${String(base.getMinutes()).padStart(2,"0")}`;
}

function timesheetStatusPill(t){
  const status = t.status || (t.clockOut ? "pending" : "open");
  let label = "Manager review";
  if(status === "approved") label = "Approved";
  else if(status === "open") label = "Clocked in";
  else if(t.isException) label = "Emergency review";
  return `<span class="status-pill ts-${esc(status)}">${label}</span>`;
}
function clockView(){
  ensureOperationsData();
  const user = currentUser();
  const active = currentOpenTimesheet(user.id);
  const br = activeBreak(active);
  const info = clockWindowInfo(user);
  const todayShift = active && active.shiftId ? state.shifts.find(s=>s.id===active.shiftId) : info.shift;
  const rows = state.timesheets.filter(t => t.employeeId === user.id).sort((a,b)=>(b.clockIn||"").localeCompare(a.clockIn||"")).slice(0,12);
  const emergencyAllowed = !active && !info.canClock;
  const disabledClockLabel = info.shift && info.mode === "too_early" ? `Clock In opens at ${info.shift.start ? timeAddMinutes(info.shift.start, -10) : "shift window"}` : (info.shift && info.mode === "late" ? "Normal Clock In closed" : "Clock In unavailable");
  return `<section class="apple-clean-page timeclock-page">
    ${pageHero("Clock", "Track real worked time, breaks, and attendance clearly.")}
    <div class="clock-status-guide apple-panel">
      <div><strong>Status guide</strong><span><b>Clocked in</b> means still working. <b>Manager review</b> means the completed record waits for approval. <b>Approved</b> means it is final.</span></div>
    </div>
    <div class="timeclock-focus apple-panel">
      <div>
        <span class="eyebrow">Today</span>
        <h3>${active ? "You are clocked in" : info.title}</h3>
        <p class="muted">${todayShift ? `Scheduled ${esc(todayShift.start)} – ${esc(todayShift.end)} · ${shiftHours(todayShift).toFixed(1)} hrs` : "No active published shift found for today."}</p>
        <div class="clock-rule-card ${info.canClock ? "ok" : emergencyAllowed ? "warn" : "soft"}">${esc(active ? "Complete your shift by ending breaks and clocking out when finished." : info.message)}</div>
        ${active ? `<p class="small muted">Clocked in ${dateTime(active.clockIn)} · Break ${breakMinutesFor(active)} mins · Worked ${workedHoursFor(active).toFixed(2)} hrs${active.isException ? ` · Emergency: ${esc(active.exceptionReason || "Manager review")}` : ""}</p>` : ""}
      </div>
      <div class="clock-actions">
        ${active ? `${br ? `<button class="secondary" onclick="endBreak()">End Break</button>` : `<button class="secondary" onclick="startBreak()">Start Break</button>`}<button class="danger" onclick="clockOut()">Clock Out</button>` : `${info.canClock ? `<button class="primary" onclick="clockIn()">Clock In</button>` : `<button class="disabled-action" disabled aria-disabled="true" title="${esc(info.message)}">${esc(disabledClockLabel)}</button>`}${emergencyAllowed ? `<button class="warning" onclick="openEmergencyClockIn()">Emergency Clock In</button>` : ""}`}
      </div>
    </div>
    <div class="apple-panel">
      <div class="apple-panel-head"><div><h3>My time records</h3><p>Recent clock activity and manager approval status.</p></div></div>
      ${employeeTimesheetCards(rows)}
    </div>
  </section>`;
}
function employeeTimesheetCards(rows){
  if(!rows.length) return `<div class="apple-empty-mini"><strong>No time records yet</strong><span>Your clock-in/out records will appear here.</span></div>`;
  return `<div class="ts-card-list">${rows.map(t => `<div class="ts-card ${t.isException ? "exception" : ""}">
    <div><strong>${dateObj((t.clockIn||now()).slice(0,10)).toLocaleDateString(undefined,{weekday:"short", month:"short", day:"numeric"})}</strong><span>${dateTime(t.clockIn)} → ${t.clockOut ? dateTime(t.clockOut) : "Still clocked in"}</span>${t.isException ? `<small>Emergency: ${esc(t.exceptionReason || "Manager review")}</small>` : ""}</div>
    <div><strong>${workedHoursFor(t).toFixed(2)} hrs</strong><span>Break ${breakMinutesFor(t)} mins</span></div>
    ${timesheetStatusPill(t)}
  </div>`).join("")}</div>`;
}
function openEmergencyClockIn(){
  const u = currentUser();
  if(!u) return toast("Please sign in again.");
  if(currentOpenTimesheet(u.id)) return toast("You are already clocked in.");
  const info = clockWindowInfo(u);
  modal(`<h2>Emergency Clock In</h2><div class="notice"><strong>Manager review required</strong><br>This creates an exception record. Use it only if your manager asked you to work, you were called in, or there is an urgent reason.</div>
    <label>Reason</label>
    <select id="emergency-clock-reason">
      <option value="Manager requested emergency shift">Manager requested emergency shift</option>
      <option value="Called in to cover staff shortage">Called in to cover staff shortage</option>
      <option value="System did not show assigned shift">System did not show assigned shift</option>
      <option value="Forgot to clock in during normal window">Forgot to clock in during normal window</option>
      <option value="Other urgent business reason">Other urgent business reason</option>
    </select>
    <label>Note for manager</label><textarea id="emergency-clock-note" placeholder="Write a short explanation for approval"></textarea>
    <p class="small muted">Current clock rule: ${esc(info.message)}</p>
    <div class="actions" style="margin-top:14px"><button class="primary" onclick="confirmEmergencyClockIn()">Submit emergency clock-in</button><button onclick="closeModal()">Cancel</button></div>`);
}
function confirmEmergencyClockIn(){
  const reason = val("emergency-clock-reason") || "Emergency clock-in";
  const note = val("emergency-clock-note");
  if(!note || note.trim().length < 4) return toast("Add a short note for manager review.");
  closeModal();
  clockIn({emergency:true, reason, note});
}
function clockIn(options={}){
  ensureOperationsData();
  const u = currentUser();
  if(!u) return toast("Please sign in again.");
  if(currentOpenTimesheet(u.id)) return toast("You are already clocked in.");
  const info = clockWindowInfo(u);
  if(!options.emergency && !info.canClock){
    return toast("Clock In is only available within 10 minutes of your shift start. Use Emergency Clock In if needed.");
  }
  const sched = info.shift;
  const isException = !!options.emergency;
  state.timesheets.push({
    id: uuid(), businessId: business().id, employeeId: u.id,
    shiftId: sched ? sched.id : "", scheduledStart: sched ? sched.start : "", scheduledEnd: sched ? sched.end : "",
    role: sched ? sched.role : u.role, clockIn: now(), clockOut: null, breaks: [], status: "open", managerNote: "",
    isException, exceptionReason: isException ? options.reason : "", exceptionNote: isException ? options.note : "", exceptionCreatedAt: isException ? now() : ""
  });
  saveState();
  notifyRole(["owner","manager"], "timesheet", isException ? "Emergency clock-in" : "Clocked in", `${u.name} clocked in${sched ? ` for ${sched.start}-${sched.end}` : " without a scheduled shift"}${isException ? `. Reason: ${options.reason}` : ""}.`);
  toast(isException ? "Emergency clock-in submitted for review." : "Clocked in.");
  renderContent();
}
function startBreak(){
  ensureOperationsData();
  const u = currentUser();
  const t = currentOpenTimesheet(u.id);
  if(!t) return toast("Clock in before starting a break.");
  if(!Array.isArray(t.breaks)) t.breaks = [];
  if(activeBreak(t)) return toast("Break is already running.");
  t.breaks.push({start: now(), end: null});
  saveState();
  toast("Break started.");
  renderContent();
}
function endBreak(){
  ensureOperationsData();
  const u = currentUser();
  const t = currentOpenTimesheet(u.id);
  const br = activeBreak(t);
  if(!br) return toast("No active break to end.");
  br.end = now();
  saveState();
  toast("Break ended.");
  renderContent();
}
function clockOut(){
  ensureOperationsData();
  const u = currentUser();
  const t = currentOpenTimesheet(u.id);
  if(!t) return toast("No active clock-in found.");
  const br = activeBreak(t);
  if(br) br.end = now();
  t.clockOut = now();
  t.breakMinutes = breakMinutesFor(t);
  t.workedHours = Number(workedHoursFor(t).toFixed(2));
  t.status = "pending";
  saveState();
  notifyRole(["owner","manager"], "timesheet", t.isException ? "Emergency timesheet needs review" : "Timesheet needs review", `${u.name} clocked out. Worked ${t.workedHours.toFixed(2)} hrs with ${t.breakMinutes} mins break${t.isException ? `. Emergency reason: ${t.exceptionReason || "Review required"}` : ""}.`);
  toast("Clocked out. Timesheet sent for review.");
  renderContent();
}
function timesheetsView(){
  ensureOperationsData();
  const rows = state.timesheets.filter(t => t.businessId === business().id).sort((a,b)=>(b.clockIn||"").localeCompare(a.clockIn||""));
  const pending = rows.filter(t => (t.status || (t.clockOut ? "pending" : "open")) === "pending");
  const open = rows.filter(t => !t.clockOut);
  return `<section class="apple-clean-page manager-timesheets">
    ${pageHero("Timesheets", "Review actual worked hours, breaks, and attendance before payroll.", `<span class="apple-count-bubble">${pending.length}</span>`)}
    <div class="qa-metric-strip compact">
      <button><strong>${open.length}</strong><span>Clocked in</span></button>
      <button><strong>${pending.length}</strong><span>Needs review</span></button>
      <button><strong>${rows.filter(t=>t.status==="approved").length}</strong><span>Approved</span></button>
    </div>
    <div class="apple-panel">
      <div class="apple-panel-head"><div><h3>Review records</h3><p>Approve completed time records or reopen if correction is needed.</p></div></div>
      ${managerTimesheetCards(rows)}
    </div>
  </section>`;
}
function managerTimesheetCards(rows){
  if(!rows.length) return `<div class="apple-empty-mini"><strong>No time records yet</strong><span>Employee clock activity will appear here.</span></div>`;
  return `<div class="ts-card-list manager">${rows.map(t => {
    const u = state.users.find(x=>x.id===t.employeeId) || {};
    const variance = t.scheduledStart && t.clockIn ? attendanceVarianceText(t) : "";
    const status = t.status || (t.clockOut ? "pending" : "open");
    const timeRange = `${dateTime(t.clockIn)} → ${t.clockOut ? dateTime(t.clockOut) : "Still clocked in"}`;
    let actions = `<span class="tiny ghost disabled" aria-disabled="true">Awaiting clock out</span>`;
    if(t.clockOut && status !== "approved") actions = `<button type="button" class="tiny primary" data-timesheet-action="approve" data-id="${esc(t.id)}">Approve</button>`;
    if(status === "approved") actions = `<button type="button" class="tiny" data-timesheet-action="reopen" data-id="${esc(t.id)}">Reopen</button>`;
    return `<div class="ts-card ${t.isException ? "exception" : ""}" data-timesheet-id="${esc(t.id)}">
      <div><strong>${esc(u.name || "Employee")}</strong><span>${timeRange}</span>${variance ? `<small>${esc(variance)}</small>` : ""}${t.isException ? `<small>Emergency: ${esc(t.exceptionReason || "Manager review")}${t.exceptionNote ? ` — ${esc(t.exceptionNote)}` : ""}</small>` : ""}</div>
      <div><strong>${workedHoursFor(t).toFixed(2)} hrs</strong><span>Break ${breakMinutesFor(t)} mins</span></div>
      ${timesheetStatusPill(t)}
      <div class="ts-actions">${actions}</div>
    </div>`;
  }).join("")}</div>`;
}
function attendanceVarianceText(t){
  try{
    const ci = new Date(t.clockIn);
    const scheduled = new Date(`${t.clockIn.slice(0,10)}T${t.scheduledStart}:00`);
    const diff = Math.round((ci - scheduled)/60000);
    if(diff > 5) return `Late by ${diff} mins`;
    if(diff < -5) return `Early by ${Math.abs(diff)} mins`;
    return "On time";
  }catch(e){ return ""; }
}
function approveTimesheet(id){
  const t = state.timesheets.find(x=>x.id===id);
  if(!t) return toast("Timesheet not found.");
  t.status = "approved";
  t.approvedAt = now();
  t.approvedBy = currentUser().id;
  saveState();
  notifyUser(t.employeeId, "timesheet", "Timesheet approved", `Your time record from ${dateTime(t.clockIn)} has been approved.`);
  toast("Timesheet approved.");
  renderContent();
}
function reopenTimesheet(id){
  const t = state.timesheets.find(x=>x.id===id);
  if(!t) return toast("Timesheet not found.");
  t.status = "pending";
  t.reopenedAt = now();
  t.reopenedBy = currentUser().id;
  saveState();
  notifyUser(t.employeeId, "timesheet", "Timesheet reopened", `Your time record from ${dateTime(t.clockIn)} needs review.`);
  toast("Timesheet reopened.");
  renderContent();
}

function isShiftAcknowledgedByMe(s){
  const u = currentUser();
  return !!(u && s && Array.isArray(s.acknowledgedBy) && s.acknowledgedBy.includes(u.id));
}
function acknowledgeShift(shiftId){
  ensureOperationsData();
  const u = currentUser();
  const s = state.shifts.find(x=>x.id===shiftId);
  if(!u || !s) return toast("Shift not found.");
  if(s.employeeId !== u.id) return toast("This shift is not assigned to you.");
  if(isShiftGone(s)) return toast("Completed shifts cannot be acknowledged.");
  if(!Array.isArray(s.acknowledgedBy)) s.acknowledgedBy = [];
  if(!s.acknowledgedBy.includes(u.id)) s.acknowledgedBy.push(u.id);
  saveState();
  notifyRole(["owner","manager"], "schedule", "Shift acknowledged", `${u.name} acknowledged ${friendlyDate(s.date)} ${s.start}-${s.end}.`);
  toast("Shift acknowledged.");
  renderContent();
}

function employeeShiftCard(s, compact, past=false){
  ensureOperationsData();
  if(!s) return "";
  const d = s.date ? dateObj(s.date) : new Date();
  const start = s.start || "--:--";
  const end = s.end || "--:--";
  const hrs = (s.start && s.end) ? shiftHours(s).toFixed(1) : "0.0";
  const gone = past || isShiftGone(s);
  const acknowledged = isShiftAcknowledgedByMe(s);
  const safeStatus = gone ? "completed" : (acknowledged ? "seen" : "published");
  const notes = cleanShiftNotes(s.notes || "");
  const canManage = !compact && !gone;
  return `<div class="employee-shift-row ${gone ? "is-past" : ""}">
    <div class="employee-date-badge"><strong>${shortWeekday(d)}</strong><span>${s.date ? shortMonthDay(s.date) : "Date"}</span></div>
    <div class="employee-shift-main">
      <strong>${esc(start)} - ${esc(end)}</strong>
      <span>${hrs} hrs${notes ? " · " + esc(notes) : ""}</span>
    </div>
    ${gone ? `<span class="status-pill muted-pill">Completed</span>` : compact ? `<span class="status-pill ${safeStatus}">${acknowledged ? "Seen" : "Published"}</span>` : `<div class="shift-actions-inline">${acknowledged ? `<span class="status-pill seen">Seen</span>` : `<button class="tiny primary" onclick="acknowledgeShift('${s.id}')">Acknowledge</button>`}<details class="action-menu"><summary>Manage</summary><div class="action-menu-list"><button onclick="openChangeModal('${s.id}')">Request Change</button><button onclick="openSwapModal('${s.id}')">Request Swap</button></div></details></div>`}
  </div>`;
}

function employeeWorkView(){
  ensureOperationsData();
  const user = currentUser();
  if(!user) return `<div class="panel"><h2>My Shifts</h2><p class="muted">Please sign in again to view your published shifts.</p></div>`;
  const publishedAll = employeeVisibleShifts(user).sort(sortShift);
  const nowTime = new Date();
  const activePublished = publishedAll.filter(s => !isShiftGone(s, nowTime)).sort(sortShift);
  const pastPublished = publishedAll.filter(s => isShiftGone(s, nowTime)).sort(sortShift).reverse();
  const weekEnd = addDays(rosterWeekStart,7);
  const weekShifts = activePublished.filter(s => inDateRange(s, rosterWeekStart, weekEnd));
  const week = totalHours(weekShifts);
  const upcomingShifts = activePublished.filter(s => safeShiftDateTime(s) >= nowTime).sort(sortShift);
  const nextShift = upcomingShifts[0];
  const pendingMine = state.requests.filter(r => r.employeeId === user.id && r.status === "pending").length;
  const activeClock = currentOpenTimesheet(user.id);
  const unreadNotices = unreadNoticesFor(user.id).length;
  return `<section class="employee-apple-dashboard qa-employee-page">
    ${pageHero("My Shifts", "Your active roster, time clock, requests, and notices in one calm view.")}
    <button class="dashboard-focus-card ${nextShift ? "all-clear" : ""}" onclick="${nextShift ? "document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})" : "go('availability')"}">
      <span class="focus-icon">${nextShift ? "→" : "✓"}</span><div><strong>${nextShift ? `${fullDayName(dateObj(nextShift.date))}, ${friendlyDate(nextShift.date)}` : "No upcoming published shift"}</strong><span>${nextShift ? `${esc(nextShift.start)} – ${esc(nextShift.end)} · ${shiftHours(nextShift).toFixed(1)} hrs` : "Completed shifts stay in previous shifts history only."}</span></div>
    </button>
    <div class="qa-metric-strip compact emp-metrics">
      <button onclick="document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})"><strong>${week.toFixed(1)}</strong><span>This week</span></button>
      <button onclick="go('clock')"><strong>${activeClock ? "On" : "Clock"}</strong><span>${activeClock ? "Working" : "In/Out"}</span></button>
      <button class="${pendingMine ? "attention" : ""}" onclick="go('myrequests')"><strong>${pendingMine ? pendingMine : "0"}</strong><span>Requests</span></button>
      <button class="${unreadNotices ? "attention" : ""}" onclick="go('notices')"><strong>${unreadNotices || "Read"}</strong><span>Notices</span></button>
    </div>
    <div class="dashboard-two-col qa-two-col"><div class="apple-panel qa-panel"><div class="apple-panel-head"><div><h3>Upcoming</h3><p>Your next active published shifts.</p></div></div>${upcomingShiftMiniList(upcomingShifts.slice(0,4))}</div><div class="apple-panel qa-panel"><div class="apple-panel-head"><div><h3>Quick actions</h3><p>Daily actions without clutter.</p></div></div><div class="action-list"><button class="action-item" onclick="go('clock')"><span class="dot"></span><div><strong>Clock in/out</strong><small>Track actual work and breaks.</small></div><em>Open</em></button><button class="action-item" onclick="go('availability')"><span class="dot"></span><div><strong>Request unavailable</strong><small>Submit date, day, time and reason.</small></div><em>Open</em></button><button class="action-item" onclick="go('myrequests')"><span class="dot"></span><div><strong>My requests</strong><small>Track current approvals.</small></div><em>View</em></button>${nextShift ? `<button class="action-item" onclick="openChangeModal('${nextShift.id}')"><span class="dot"></span><div><strong>Request change</strong><small>For your next shift only.</small></div><em>Ask</em></button>` : ``}</div></div></div>
    <div class="apple-panel" id="my-published-schedule"><div class="apple-panel-head"><div><h3>Published schedule</h3><p>Active/upcoming shifts only. Acknowledge shifts after viewing.</p></div><span class="status-pill">${upcomingShifts.length} upcoming</span></div>${activePublished.length ? employeeShiftCardList(activePublished) : `<div class="apple-empty-mini"><strong>No active published shifts</strong><span>Past shifts are moved to history. New shifts will appear after publishing.</span></div>`}${employeePastShiftHistory(pastPublished)}</div>
  </section>`;
}

function unreadNoticesFor(userId){
  ensureOperationsData();
  return state.notices.filter(n => n.businessId === business().id && noticeVisibleToUser(n, userId) && !state.noticeReads.some(r => r.noticeId === n.id && r.userId === userId));
}
function noticeVisibleToUser(n, userId){
  const u = state.users.find(x=>x.id===userId);
  if(!u || !n) return false;
  return n.audience === "all" || n.audience === u.role || (Array.isArray(n.userIds) && n.userIds.includes(userId));
}
function noticesView(managerMode){
  ensureOperationsData();
  const user = currentUser();
  const rows = state.notices.filter(n => n.businessId === business().id && (managerMode || noticeVisibleToUser(n, user.id))).sort((a,b)=>(b.createdAt||"").localeCompare(a.createdAt||""));
  return `<section class="apple-clean-page notice-board-page">
    ${pageHero("Notice Board", managerMode ? "Post clear team announcements without noisy chat." : "Important team notices in one simple place.")}
    ${managerMode ? noticeComposer() : ""}
    <div class="apple-panel"><div class="apple-panel-head"><div><h3>${managerMode ? "Team notices" : "Notices"}</h3><p>${managerMode ? "Latest announcements shown to staff." : "Tap read after reviewing."}</p></div></div>${noticeCards(rows, managerMode)}</div>
  </section>`;
}
function noticeComposer(){
  return `<div class="apple-panel notice-composer"><div class="apple-panel-head"><div><h3>New notice</h3><p>Short, important updates only.</p></div></div><div class="form-grid"><div><label>Title</label><input id="notice-title" placeholder="Roster reminder"></div><div><label>Audience</label><select id="notice-audience"><option value="employee">Employees</option><option value="all">Everyone</option><option value="manager">Managers</option></select></div><div class="full"><label>Message</label><textarea id="notice-message" rows="3" placeholder="Write a clear notice..."></textarea></div></div><button class="primary" onclick="createNotice()">Post Notice</button></div>`;
}
function noticeCards(rows, managerMode){
  if(!rows.length) return `<div class="apple-empty-mini"><strong>No notices yet</strong><span>Important team updates will appear here.</span></div>`;
  const u = currentUser();
  return `<div class="notice-card-list">${rows.map(n => {
    const read = state.noticeReads.some(r => r.noticeId === n.id && r.userId === u.id);
    return `<div class="notice-card ${read ? "is-read" : ""}"><div><strong>${esc(n.title || "Notice")}</strong><p>${esc(n.message || "")}</p><span>${dateTime(n.createdAt)} · ${esc(n.audience || "team")}</span></div><div class="notice-actions">${!managerMode && !read ? `<button class="tiny primary" onclick="markNoticeRead('${n.id}')">Mark read</button>` : ""}${managerMode ? `<button class="tiny danger-text" onclick="deleteNotice('${n.id}')">Delete</button>` : ""}</div></div>`;
  }).join("")}</div>`;
}
function createNotice(){
  ensureOperationsData();
  const title = (el("notice-title")?.value || "").trim();
  const message = (el("notice-message")?.value || "").trim();
  const audience = el("notice-audience")?.value || "employee";
  if(!title || !message) return toast("Add a notice title and message.");
  const n = {id:uuid(), businessId:business().id, title, message, audience, createdAt:now(), createdBy:currentUser().id};
  state.notices.push(n);
  saveState();
  const roles = audience === "all" ? ["owner","manager","employee"] : [audience];
  notifyRole(roles, "notice", title, message);
  toast("Notice posted.");
  renderContent();
}
function markNoticeRead(id){
  ensureOperationsData();
  const u = currentUser();
  if(!state.noticeReads.some(r => r.noticeId === id && r.userId === u.id)) state.noticeReads.push({noticeId:id,userId:u.id,readAt:now()});
  saveState();
  renderContent();
}
function deleteNotice(id){
  if(!confirm("Delete this notice?")) return;
  state.notices = state.notices.filter(n=>n.id!==id);
  state.noticeReads = state.noticeReads.filter(r=>r.noticeId!==id);
  saveState();
  toast("Notice deleted.");
  renderContent();
}

/* v58 QA/QT fix: My Shifts undefined/clear-label hardening */
function cleanShiftNotes(note){
  const raw = String(note ?? "").trim();
  if(!raw) return "";
  const lower = raw.toLowerCase();
  if(["undefined","null","nan","none","-"].includes(lower)) return "";
  return raw
    .replace(/\bundefined\b/gi, "")
    .replace(/\bnull\b/gi, "")
    .replace(/\s*\(copy\)\s*/gi, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function validEmployeeShift(s){
  return !!(s && s.id && s.date && s.start && s.end && isPublishedStatus(s));
}

const _v58EmployeeVisibleShiftsBase = employeeVisibleShifts;
function employeeVisibleShifts(user=currentUser()){
  try{
    return (_v58EmployeeVisibleShiftsBase(user) || []).filter(validEmployeeShift).map(s => ({...s, notes: cleanShiftNotes(s.notes)}));
  }catch(e){
    console.warn("Employee shift load failed", e);
    return [];
  }
}

function employeeMetricValue(value, fallback="0"){
  if(value === undefined || value === null || value === "") return fallback;
  return String(value);
}

function employeeShiftCard(s, compact=false, past=false){
  ensureOperationsData();
  if(!validEmployeeShift(s)) return "";
  const d = dateObj(s.date);
  const start = s.start || "--:--";
  const end = s.end || "--:--";
  const hrs = shiftHours(s).toFixed(1);
  const gone = past || isShiftGone(s);
  const acknowledged = isShiftAcknowledgedByMe(s);
  const safeStatus = gone ? "completed" : (acknowledged ? "seen" : "published");
  const notes = cleanShiftNotes(s.notes);
  return `<div class="employee-shift-row ${gone ? "is-past" : ""}">
    <div class="employee-date-badge"><strong>${shortWeekday(d)}</strong><span>${shortMonthDay(s.date)}</span></div>
    <div class="employee-shift-main">
      <strong>${esc(start)} - ${esc(end)}</strong>
      <span>${hrs} hrs${notes ? " · " + esc(notes) : ""}</span>
    </div>
    ${gone ? `<span class="status-pill muted-pill">Completed</span>` : compact ? `<span class="status-pill ${safeStatus}">${acknowledged ? "Seen" : "Published"}</span>` : `<div class="shift-actions-inline">${acknowledged ? `<span class="status-pill seen">Seen</span>` : `<button class="tiny primary" onclick="acknowledgeShift('${s.id}')">Acknowledge</button>`}<details class="action-menu"><summary>Manage</summary><div class="action-menu-list"><button onclick="openChangeModal('${s.id}')">Request Change</button><button onclick="openSwapModal('${s.id}')">Request Swap</button></div></details></div>`}
  </div>`;
}

function upcomingShiftMiniList(rows){
  const cleanRows = (rows || []).filter(validEmployeeShift);
  if(!cleanRows.length) return `<div class="apple-empty-mini"><strong>No upcoming shifts</strong><span>You are clear for now.</span></div>`;
  return `<div class="employee-shift-list compact qa-upcoming-mini">${cleanRows.map(s => employeeShiftCard(s, true)).join("")}</div>`;
}

function employeeShiftCardList(rows){
  const cleanRows = (rows || []).filter(validEmployeeShift);
  if(!cleanRows.length) return `<div class="apple-empty-mini"><strong>No active published shifts</strong><span>New shifts will appear after publishing.</span></div>`;
  return `<div class="employee-shift-list">${cleanRows.map(s => employeeShiftCard(s, false)).join("")}</div>`;
}

function employeePastShiftHistory(rows){
  const cleanRows = (rows || []).filter(validEmployeeShift);
  if(!cleanRows.length) return "";
  const groups = groupShiftsByWeek(cleanRows);
  return `<details class="history-fold employee-history-fold week-history">
    <summary>Previous shifts <span>${cleanRows.length}</span></summary>
    <div class="week-history-list">
      ${groups.map(([key, shifts], index) => {
        const weekHours = totalHours(shifts).toFixed(1);
        return `<details class="week-history-card" ${index === 0 ? "open" : ""}>
          <summary><div><strong>${weekLabelFromKey(key)}</strong><small>${shifts.length} shift${shifts.length === 1 ? "" : "s"} · ${weekHours} hrs</small></div><em>View</em></summary>
          <div class="employee-shift-list history-list">${shifts.sort(sortShift).map(s => employeeShiftCard(s, false, true)).join("")}</div>
        </details>`;
      }).join("")}
    </div>
  </details>`;
}

function employeeWorkView(){
  ensureOperationsData();
  const user = currentUser();
  if(!user) return `<div class="panel"><h2>My Shifts</h2><p class="muted">Please sign in again to view your published shifts.</p></div>`;
  let publishedAll = [];
  try{ publishedAll = employeeVisibleShifts(user).sort(sortShift); }catch(e){ console.warn(e); publishedAll = []; }
  const nowTime = new Date();
  const activePublished = publishedAll.filter(s => !isShiftGone(s, nowTime)).sort(sortShift);
  const pastPublished = publishedAll.filter(s => isShiftGone(s, nowTime)).sort(sortShift).reverse();
  const weekEnd = addDays(rosterWeekStart,7);
  const weekShifts = activePublished.filter(s => inDateRange(s, rosterWeekStart, weekEnd));
  const week = totalHours(weekShifts);
  const upcomingShifts = activePublished.filter(s => safeShiftDateTime(s) >= nowTime).sort(sortShift);
  const nextShift = upcomingShifts[0];
  const pendingMine = state.requests.filter(r => r.employeeId === user.id && r.status === "pending").length;
  const activeClock = currentOpenTimesheet(user.id);
  const unreadNotices = unreadNoticesFor(user.id).length;
  const focusTitle = nextShift ? `${fullDayName(dateObj(nextShift.date))}, ${friendlyDate(nextShift.date)}` : "No upcoming published shift";
  const focusSub = nextShift ? `${esc(nextShift.start)} – ${esc(nextShift.end)} · ${shiftHours(nextShift).toFixed(1)} hrs` : "New shifts will appear here after your manager publishes the roster.";
  return `<section class="employee-apple-dashboard qa-employee-page">
    ${pageHero("My Shifts", "Your active roster, time clock, requests, and notices in one calm view.")}
    <button class="dashboard-focus-card ${nextShift ? "all-clear" : ""}" onclick="${nextShift ? "document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})" : "go('availability')"}">
      <span class="focus-icon">${nextShift ? "→" : "✓"}</span><div><strong>${esc(focusTitle)}</strong><span>${focusSub}</span></div>
    </button>
    <div class="qa-metric-strip compact emp-metrics">
      <button onclick="document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})"><strong>${week.toFixed(1)}</strong><span>This week</span></button>
      <button onclick="go('clock')"><strong>${activeClock ? "On" : "Clock"}</strong><span>${activeClock ? "Working" : "In/Out"}</span></button>
      <button class="${pendingMine ? "attention" : ""}" onclick="go('myrequests')"><strong>${pendingMine ? employeeMetricValue(pendingMine) : "0"}</strong><span>Requests</span></button>
      <button class="${unreadNotices ? "attention" : ""}" onclick="go('notices')"><strong>${unreadNotices ? employeeMetricValue(unreadNotices) : "0"}</strong><span>Notices</span></button>
    </div>
    <div class="dashboard-two-col qa-two-col"><div class="apple-panel qa-panel"><div class="apple-panel-head"><div><h3>Upcoming</h3><p>Your next active published shifts.</p></div></div>${upcomingShiftMiniList(upcomingShifts.slice(0,4))}</div><div class="apple-panel qa-panel"><div class="apple-panel-head"><div><h3>Quick actions</h3><p>Daily actions without clutter.</p></div></div><div class="action-list"><button class="action-item" onclick="go('clock')"><span class="dot"></span><div><strong>Clock in/out</strong><small>Track actual work and breaks.</small></div><em>Open</em></button><button class="action-item" onclick="go('availability')"><span class="dot"></span><div><strong>Request unavailable</strong><small>Submit date, day, time and reason.</small></div><em>Open</em></button><button class="action-item" onclick="go('myrequests')"><span class="dot"></span><div><strong>My requests</strong><small>Track current approvals.</small></div><em>View</em></button>${nextShift ? `<button class="action-item" onclick="openChangeModal('${nextShift.id}')"><span class="dot"></span><div><strong>Request change</strong><small>For your next shift only.</small></div><em>Ask</em></button>` : ``}</div></div></div>
    <div class="apple-panel" id="my-published-schedule"><div class="apple-panel-head"><div><h3>Published schedule</h3><p>Active/upcoming shifts only. Completed shifts stay in previous shifts history.</p></div><span class="status-pill">${upcomingShifts.length} upcoming</span></div>${activePublished.length ? employeeShiftCardList(activePublished) : `<div class="apple-empty-mini"><strong>No active published shifts</strong><span>Past shifts are moved to history. New shifts will appear after publishing.</span></div>`}${employeePastShiftHistory(pastPublished)}</div>
  </section>`;
}


/* v59 QA fix: robust timesheet review buttons */
function handleTimesheetAction(action, id){
  if(!id) return toast("Time record not found.");
  if(action === "approve") return approveTimesheet(id);
  if(action === "reopen") return reopenTimesheet(id);
}
if(!window.__timesheetActionDelegate){
  window.__timesheetActionDelegate = true;
  document.addEventListener("click", function(event){
    const btn = event.target.closest("[data-timesheet-action]");
    if(!btn) return;
    event.preventDefault();
    event.stopPropagation();
    handleTimesheetAction(btn.dataset.timesheetAction, btn.dataset.id);
  });
}
window.approveTimesheet = approveTimesheet;
window.reopenTimesheet = reopenTimesheet;
window.handleTimesheetAction = handleTimesheetAction;

/* v63 QA fix: robust published-shift visibility for employee My Shifts
   - Handles shifts saved with either user.id or employee record id.
   - Handles older data missing businessId on shifts.
   - Uses linked email/authUid/userId so published shifts appear after manager/owner publishes.
*/
function linkedEmployeeRecordsForUser(user=currentUser()){
  if(!user || !state || !Array.isArray(state.employees)) return [];
  const email = normalizeEmail(user.email);
  return state.employees.filter(e => {
    if(!e) return false;
    const sameBusiness = !e.businessId || !user.businessId || e.businessId === user.businessId;
    if(!sameBusiness) return false;
    return e.id === user.id || e.userId === user.id || e.authUid === user.authUid || normalizeEmail(e.email) === email;
  });
}

function employeeIdentityIds(user=currentUser()){
  if(!user) return [];
  const ids = new Set();
  if(user.id) ids.add(user.id);
  linkedEmployeeRecordsForUser(user).forEach(e => {
    if(e.id) ids.add(e.id);
    if(e.userId) ids.add(e.userId);
  });
  return [...ids].filter(Boolean);
}

function shiftBelongsToUser(shift, user=currentUser()){
  if(!shift || !user) return false;
  const sameBusiness = !shift.businessId || !user.businessId || shift.businessId === user.businessId;
  if(!sameBusiness) return false;
  const ids = employeeIdentityIds(user);
  if(ids.includes(shift.employeeId) || ids.includes(shift.userId) || ids.includes(shift.employeeUserId)) return true;
  const email = normalizeEmail(user.email);
  if(email && (normalizeEmail(shift.employeeEmail) === email || normalizeEmail(shift.email) === email)) return true;
  const linked = linkedEmployeeRecordsForUser(user);
  return linked.some(e => e.id === shift.employeeId || e.userId === shift.employeeId || normalizeEmail(e.email) === normalizeEmail(shift.employeeEmail));
}

function employeeVisibleShifts(user=currentUser()){
  try{
    if(!user || !state || !Array.isArray(state.shifts)) return [];
    return state.shifts
      .filter(s => validEmployeeShift(s) && shiftBelongsToUser(s, user) && isPublishedStatus(s))
      .map(s => ({...s, notes: cleanShiftNotes(s.notes)}))
      .sort(sortShift);
  }catch(e){
    console.warn("Employee published shift visibility failed", e);
    return [];
  }
}

function employeePublishedShiftDebugSummary(user=currentUser()){
  if(!user || !state || !Array.isArray(state.shifts)) return "";
  const allPublished = state.shifts.filter(s => isPublishedStatus(s));
  const mine = allPublished.filter(s => shiftBelongsToUser(s, user));
  if(mine.length) return "";
  const sameBusinessPublished = allPublished.filter(s => !s.businessId || s.businessId === user.businessId);
  if(!sameBusinessPublished.length) return "";
  return `<div class="apple-empty-mini subtle-debug"><strong>No shift assigned to this employee profile.</strong><span>Manager published shifts exist, but none are linked to this signed-in employee. Edit the shift and select this employee, then publish again.</span></div>`;
}

function canEmployeeActOnShift(shiftId){
  const user = currentUser();
  const s = state.shifts.find(x => x.id === shiftId);
  if(!user || !s) return {ok:false, message:"Selected shift was not found."};
  if(!shiftBelongsToUser(s, user)) return {ok:false, message:"This shift is not assigned to you."};
  if(!isPublishedStatus(s)) return {ok:false, message:"Only published shifts can be requested."};
  if(isShiftGone(s)) return {ok:false, message:"This shift is already completed. Previous shifts are kept for records only."};
  return {ok:true, shift:s};
}

function employeeWorkView(){
  ensureOperationsData();
  const user = currentUser();
  if(!user) return `<div class="panel"><h2>My Shifts</h2><p class="muted">Please sign in again to view your published shifts.</p></div>`;
  let publishedAll = [];
  try{ publishedAll = employeeVisibleShifts(user).sort(sortShift); }catch(e){ console.warn(e); publishedAll = []; }
  const nowTime = new Date();
  const activePublished = publishedAll.filter(s => !isShiftGone(s, nowTime)).sort(sortShift);
  const pastPublished = publishedAll.filter(s => isShiftGone(s, nowTime)).sort(sortShift).reverse();
  const weekEnd = addDays(rosterWeekStart,7);
  const weekShifts = activePublished.filter(s => inDateRange(s, rosterWeekStart, weekEnd));
  const week = totalHours(weekShifts);
  const upcomingShifts = activePublished.filter(s => safeShiftDateTime(s) >= nowTime).sort(sortShift);
  const nextShift = upcomingShifts[0];
  const employeeIds = employeeIdentityIds(user);
  const pendingMine = state.requests.filter(r => employeeIds.includes(r.employeeId) && r.status === "pending").length;
  const activeClock = currentOpenTimesheet(user.id);
  const unreadNotices = unreadNoticesFor(user.id).length;
  const focusTitle = nextShift ? `${fullDayName(dateObj(nextShift.date))}, ${friendlyDate(nextShift.date)}` : "No upcoming published shift";
  const focusSub = nextShift ? `${esc(nextShift.start)} – ${esc(nextShift.end)} · ${shiftHours(nextShift).toFixed(1)} hrs` : "New shifts will appear here after your manager publishes the roster.";
  const diagnostic = (!activePublished.length && !pastPublished.length) ? employeePublishedShiftDebugSummary(user) : "";
  return `<section class="employee-apple-dashboard qa-employee-page">
    ${pageHero("My Shifts", "Your active roster, time clock, requests, and notices in one calm view.")}
    <button class="dashboard-focus-card ${nextShift ? "all-clear" : ""}" onclick="${nextShift ? "document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})" : "go('availability')"}">
      <span class="focus-icon">${nextShift ? "→" : "✓"}</span><div><strong>${esc(focusTitle)}</strong><span>${focusSub}</span></div>
    </button>
    <div class="qa-metric-strip compact emp-metrics">
      <button onclick="document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})"><strong>${week.toFixed(1)}</strong><span>This week</span></button>
      <button onclick="go('clock')"><strong>${activeClock ? "On" : "Clock"}</strong><span>${activeClock ? "Working" : "In/Out"}</span></button>
      <button class="${pendingMine ? "attention" : ""}" onclick="go('myrequests')"><strong>${pendingMine ? employeeMetricValue(pendingMine) : "0"}</strong><span>Requests</span></button>
      <button class="${unreadNotices ? "attention" : ""}" onclick="go('notices')"><strong>${unreadNotices ? employeeMetricValue(unreadNotices) : "0"}</strong><span>Notices</span></button>
    </div>
    <div class="dashboard-two-col qa-two-col employee-compact-row"><div class="apple-panel qa-panel"><div class="apple-panel-head"><div><h3>Quick actions</h3><p>Clock, availability and requests without repeating your schedule.</p></div></div><div class="action-list"><button class="action-item" onclick="go('clock')"><span class="dot"></span><div><strong>Clock in/out</strong><small>Track actual work and breaks.</small></div><em>Open</em></button><button class="action-item" onclick="go('availability')"><span class="dot"></span><div><strong>Request unavailable</strong><small>Submit date, day, time and reason.</small></div><em>Open</em></button><button class="action-item" onclick="go('myrequests')"><span class="dot"></span><div><strong>My requests</strong><small>Track current approvals.</small></div><em>View</em></button>${nextShift ? `<button class="action-item" onclick="openChangeModal('${nextShift.id}')"><span class="dot"></span><div><strong>Request change</strong><small>For your next shift only.</small></div><em>Ask</em></button>` : ``}</div></div></div>
    <div class="apple-panel employee-single-schedule" id="my-published-schedule"><div class="apple-panel-head"><div><h3>Published schedule</h3><p>Your active and upcoming published shifts in one place. Completed shifts stay in previous shifts history.</p></div><span class="status-pill">${upcomingShifts.length} upcoming</span></div>${activePublished.length ? employeeShiftCardList(activePublished) : `<div class="apple-empty-mini"><strong>No active published shifts</strong><span>Past shifts are moved to history. New shifts will appear after publishing.</span></div>`}${diagnostic}${employeePastShiftHistory(pastPublished)}</div>
  </section>`;
}

/* v63 QA self-check helpers available in browser console */
window.__myscheduleShiftVisibilityQA = function(){
  const user = currentUser();
  return {
    user: user ? {id:user.id, email:user.email, businessId:user.businessId, role:user.role} : null,
    identityIds: employeeIdentityIds(user),
    visibleShiftIds: employeeVisibleShifts(user).map(s => s.id),
    publishedShiftIds: (state?.shifts || []).filter(isPublishedStatus).map(s => ({id:s.id, employeeId:s.employeeId, businessId:s.businessId, date:s.date, status:s.status}))
  };
};

/* v65 QA: request approval roster effects + swap target approval + Ctrl+C/Ctrl+V shift copy */
let selectedRosterShiftId = null;
let selectedRosterDate = null;
let keyboardShiftBuffer = null;

function rosterEmployeeUsers(){
  try{ return state.users.filter(u => u.businessId === business().id && u.role === "employee" && u.status === "active"); }
  catch(e){ return []; }
}

function selectRosterShift(event, id){
  if(event && event.target && event.target.closest && event.target.closest("button,details,summary,input,select,textarea")) return;
  selectedRosterShiftId = id;
  const s = state.shifts.find(x => x.id === id);
  if(s) selectedRosterDate = s.date;
  document.querySelectorAll(".qa-shift-card.is-selected").forEach(x => x.classList.remove("is-selected"));
  const card = document.querySelector(`[data-shift-id="${id}"]`);
  if(card) card.classList.add("is-selected");
}

function selectRosterDate(event, date){
  if(event && event.target && event.target.closest && event.target.closest("button,.shift-card,details,summary,input,select,textarea")) return;
  selectedRosterDate = date;
  document.querySelectorAll(".qa-day-column.is-selected-day").forEach(x => x.classList.remove("is-selected-day"));
  const col = document.querySelector(`[data-roster-date="${date}"]`);
  if(col) col.classList.add("is-selected-day");
}

function scheduleCard(s){
  const isSelected = selectedRosterShiftId === s.id ? " is-selected" : "";
  return `<div class="shift-card qa-shift-card compact-shift-card ${esc(s.status || "draft")}${isSelected}" data-shift-id="${esc(s.id)}" tabindex="0" draggable="true" ondragstart="dragShift(event,'${s.id}')" onclick="selectRosterShift(event,'${s.id}'); openShiftModal('${s.id}')" title="Click to edit. Ctrl+C copies the selected shift; Ctrl+V pastes it as draft. Delete removes selected shift.">
    <div class="shift-time">${esc(s.start)} – ${esc(s.end)}</div>
    <div class="qa-shift-person"><strong>${esc(userName(s.employeeId))}</strong><span>${esc(s.role || "Shift")}</span></div>
    <div class="qa-shift-meta compact-meta"><span>${shiftHours(s).toFixed(1)} hrs</span></div>
  </div>`;
}

function scheduleBoard(shifts){
  const days = Array.from({length:7},(_,i)=>addDays(rosterWeekStart,i));
  return `<div class="schedule-scroll-shell" id="schedule-scroll-shell"><div class="schedule-board qa-schedule-board">
    ${days.map(day=>{
      const date = isoDate(day);
      const rows = shifts.filter(s => s.date === date).sort(sortShift);
      const selectedDay = selectedRosterDate === date ? " is-selected-day" : "";
      return `<div class="day-column qa-day-column${selectedDay}" data-roster-date="${date}" onclick="selectRosterDate(event,'${date}')" ondragover="allowDrop(event)" ondragleave="dragLeave(event)" ondrop="dropShift(event,'${date}')">
        <div class="day-head qa-day-head"><div><strong>${dayName(day)}</strong><span>${shortDate(day)}</span></div><em>${totalHours(rows).toFixed(1)} hrs</em></div>
        <button class="tiny full qa-add-shift" onclick="openShiftModal('', '${date}')">Add</button>
        <div class="shift-cards">${rows.map(scheduleCard).join("") || `<div class="empty-shift">No shifts</div>`}</div>
      </div>`;
    }).join("")}
  </div></div>`;
}

function copySelectedRosterShift(){
  if(currentView !== "roster") return false;
  const s = state.shifts.find(x => x.id === selectedRosterShiftId);
  if(!s){ toast("Select a shift first, then press Ctrl+C."); return true; }
  keyboardShiftBuffer = {...s, notes: cleanShiftNoteForStorage(s.notes)};
  copiedWeekBuffer = null;
  toast("Shift copied. Select a day and press Ctrl+V to paste.");
  return true;
}

function pasteSelectedRosterShift(){
  if(currentView !== "roster") return false;
  if(!keyboardShiftBuffer){ toast("No shift copied. Select a shift and press Ctrl+C first."); return true; }
  const date = selectedRosterDate || keyboardShiftBuffer.date || isoDate(rosterWeekStart);
  const copy = {...keyboardShiftBuffer, id:uuid(), date, status:"draft", notes:cleanShiftNoteForStorage(keyboardShiftBuffer.notes)};
  const availabilityBlock = availabilityConflict(copy);
  if(availabilityBlock){ toast(availabilityBlock); return true; }
  state.shifts.push(copy);
  selectedRosterShiftId = copy.id;
  selectedRosterDate = copy.date;
  saveState();
  renderContent();
  toast("Shift pasted as draft.");
  return true;
}

function installRosterKeyboardShortcuts(){
  if(window.__myscheduleRosterKeyboardInstalled) return;
  window.__myscheduleRosterKeyboardInstalled = true;
  document.addEventListener("keydown", function(event){
    if(!currentUser() || currentView !== "roster") return;
    const tag = (event.target && event.target.tagName || "").toLowerCase();
    if(["input","textarea","select"].includes(tag) || event.target?.isContentEditable) return;
    const key = String(event.key || "").toLowerCase();
    if((event.ctrlKey || event.metaKey) && key === "c"){
      if(copySelectedRosterShift()) event.preventDefault();
    }
    if((event.ctrlKey || event.metaKey) && key === "v"){
      if(pasteSelectedRosterShift()) event.preventDefault();
    }
    if((key === "delete" || key === "backspace") && selectedRosterShiftId){
      const s = state.shifts.find(x => x.id === selectedRosterShiftId);
      if(s && confirm(`Delete ${userName(s.employeeId)} ${s.start}-${s.end} on ${friendlyDate(s.date)}?`)){
        deleteShift(selectedRosterShiftId);
        selectedRosterShiftId = null;
        event.preventDefault();
      }
    }
  });
}
installRosterKeyboardShortcuts();

function approveRequest(id){
  const r = state.requests.find(x => x.id === id);
  if(!r) return;
  if(r.status !== "pending") return toast("This request is already handled.");

  if(r.type === "change"){
    const s = state.shifts.find(x => x.id === r.shiftId);
    if(s){
      state.shifts = state.shifts.filter(x => x.id !== s.id);
      r.rosterAction = "removed_shift";
      r.rosterActionAt = now();
    }
    r.status = "approved";
    saveState();
    notifyUser(r.employeeId, "approval", "Shift change approved", "Your shift change was approved and the shift was removed from the roster.", {requestId:r.id, shiftId:r.shiftId || "", targetView:"myrequests"});
    notifyRole(["owner","manager"], "request", "Roster updated", `${userName(r.employeeId)}'s change request was approved and the shift was removed from the roster.`, {requestId:r.id, targetView:"requests"});
    renderContent();
    toast("Change approved. Shift removed from roster.");
    return;
  }

  if(r.type === "swap"){
    if(!r.targetEmployeeId){
      openSwapApprovalTargetModal(r.id);
      return;
    }
    return approveSwapWithTarget(r.id, r.targetEmployeeId);
  }

  if(r.type === "availability"){
    const a = state.availability.find(x => x.id === r.availabilityId);
    if(a){
      if(a.requestAction === "remove"){
        state.availability = state.availability.filter(x => x.id !== a.id);
      }else{
        a.status = "approved";
      }
    }
  }

  r.status = "approved";
  saveState();
  notifyUser(r.employeeId, "approval", "Request approved", `Your ${requestTypeLabel(r).toLowerCase()} request has been approved.`, {requestId:r.id, shiftId:r.shiftId || "", targetView:"myrequests"});
  renderContent();
  toast("Request approved.");
}

function openSwapApprovalTargetModal(requestId){
  const r = state.requests.find(x => x.id === requestId);
  if(!r) return toast("Request not found.");
  const s = state.shifts.find(x => x.id === r.shiftId);
  if(!s) return toast("Original shift was not found.");
  const employees = rosterEmployeeUsers().filter(u => u.id !== r.employeeId);
  if(!employees.length) return toast("No other employee is available to receive this swap.");
  modal(`<h3>Approve Swap</h3>
    <p class="muted">Choose who should receive this shift. The shift will move from ${esc(userName(r.employeeId))} to the selected employee.</p>
    ${shiftDetailsCard(r.shiftId)}
    <label>Assign shift to</label>
    <select id="swap-approval-target">${employees.map(u => `<option value="${u.id}">${esc(u.name)}</option>`).join("")}</select>
    <div class="actions" style="margin-top:14px"><button class="primary" onclick="approveSwapWithTarget('${requestId}', val('swap-approval-target')); closeModal();">Approve Swap</button><button onclick="closeModal()">Cancel</button></div>`);
}

function approveSwapWithTarget(requestId, targetEmployeeId){
  const r = state.requests.find(x => x.id === requestId);
  if(!r) return toast("Request not found.");
  const s = state.shifts.find(x => x.id === r.shiftId);
  if(!s) return toast("Original shift was not found.");
  if(!targetEmployeeId || targetEmployeeId === r.employeeId) return toast("Choose another employee for the swap.");
  const target = state.users.find(u => u.id === targetEmployeeId && u.businessId === business().id && u.role === "employee" && u.status === "active");
  if(!target) return toast("Selected employee is not valid for this workplace.");
  const testShift = {...s, employeeId:targetEmployeeId};
  const availabilityBlock = availabilityConflict(testShift);
  if(availabilityBlock) return toast(availabilityBlock);
  s.employeeId = targetEmployeeId;
  s.status = "published";
  s.notes = cleanShiftNoteForStorage(s.notes);
  r.targetEmployeeId = targetEmployeeId;
  r.status = "approved";
  r.rosterAction = "reassigned_shift";
  r.rosterActionAt = now();
  saveState();
  notifyUser(r.employeeId, "approval", "Shift swap approved", "Your swap request was approved and the shift was removed from your roster.", {requestId:r.id, shiftId:r.shiftId, targetView:"myrequests"});
  notifyUser(targetEmployeeId, "swap", "New swapped shift assigned", `A shift was assigned to you after a manager approved a swap request from ${userName(r.employeeId)}.`, {requestId:r.id, shiftId:r.shiftId, targetView:"myshifts"});
  notifyRole(["owner","manager"], "request", "Swap approved", `Shift moved from ${userName(r.employeeId)} to ${userName(targetEmployeeId)}.`, {requestId:r.id, shiftId:r.shiftId, targetView:"roster"});
  renderContent();
  toast("Swap approved. Shift reassigned on the roster.");
}

function submitSwap(shiftId){
  const check = canEmployeeActOnShift(shiftId);
  if(!check.ok) return toast(check.message);
  if(!val("s-msg")) return toast("Enter message.");
  const shift = check.shift;
  const targetEmployeeId = val("s-target");
  const r = {id:uuid(),businessId:business().id,employeeId:currentUser().id,shiftId,type:"swap",targetEmployeeId,message:val("s-msg"),status:"pending",createdAt:now(),seenBy:[],shiftSnapshot: shift ? {date:shift.date, day:fullDayName(dateObj(shift.date)), time:`${shift.start}-${shift.end}`, role:shift.role, status:shift.status, notes:shift.notes || ""} : null};
  state.requests.push(r);
  saveState();
  notifyRole(["owner","manager"], "request", "Shift swap request", `${currentUser().name} requested a shift swap${targetEmployeeId ? " with " + userName(targetEmployeeId) : " and needs another employee assigned"}.`, {requestId:r.id, shiftId:shiftId, targetView:"requests"});
  if(targetEmployeeId){
    notifyUser(targetEmployeeId, "swap", "Swap requested", `${currentUser().name} asked to swap a shift with you. Manager approval is required before the roster changes.`, {requestId:r.id, shiftId:shiftId, targetView:"myrequests"});
  }
  closeModal(); renderContent(); toast("Swap request submitted.");
}

window.__myscheduleV65QA = function(){
  return {
    selectedRosterShiftId,
    selectedRosterDate,
    keyboardShiftBuffer: keyboardShiftBuffer ? {date: keyboardShiftBuffer.date, employeeId: keyboardShiftBuffer.employeeId, start: keyboardShiftBuffer.start, end: keyboardShiftBuffer.end} : null,
    pendingRequests: (state?.requests || []).filter(r => r.status === "pending").map(r => ({id:r.id,type:r.type,shiftId:r.shiftId,targetEmployeeId:r.targetEmployeeId || ""}))
  };
};

/* v66 QA: employee permissions cleanup
   - My Shifts shows ONLY shifts assigned to signed-in employee.
   - Team Schedule is a separate read-only weekly view for awareness.
   - Employees may ask manager to take/swap another employee's shift from Team Schedule.
*/
function nonEmpty(value){ return value !== undefined && value !== null && String(value).trim() !== ""; }
function sameNonEmpty(a,b){ return nonEmpty(a) && nonEmpty(b) && String(a).trim() === String(b).trim(); }
function sameEmailNonEmpty(a,b){ const aa = normalizeEmail(a || ""); const bb = normalizeEmail(b || ""); return !!aa && !!bb && aa === bb; }

function linkedEmployeeRecordsForUser(user=currentUser()){
  if(!user || !state || !Array.isArray(state.employees)) return [];
  const email = normalizeEmail(user.email || "");
  return state.employees.filter(e => {
    if(!e) return false;
    const sameBusiness = !e.businessId || !user.businessId || e.businessId === user.businessId;
    if(!sameBusiness) return false;
    return sameNonEmpty(e.id, user.id)
      || sameNonEmpty(e.userId, user.id)
      || sameNonEmpty(e.authUid, user.authUid)
      || (!!email && sameEmailNonEmpty(e.email, email));
  });
}

function employeeIdentityIds(user=currentUser()){
  if(!user) return [];
  const ids = new Set();
  if(nonEmpty(user.id)) ids.add(String(user.id));
  linkedEmployeeRecordsForUser(user).forEach(e => {
    if(nonEmpty(e.id)) ids.add(String(e.id));
    if(nonEmpty(e.userId)) ids.add(String(e.userId));
  });
  return [...ids];
}

function shiftBelongsToUser(shift, user=currentUser()){
  if(!shift || !user) return false;
  const sameBusiness = !shift.businessId || !user.businessId || shift.businessId === user.businessId;
  if(!sameBusiness) return false;
  const ids = employeeIdentityIds(user);
  const candidateIds = [shift.employeeId, shift.userId, shift.employeeUserId].filter(nonEmpty).map(x => String(x));
  if(candidateIds.some(id => ids.includes(id))) return true;
  if(sameEmailNonEmpty(shift.employeeEmail, user.email) || sameEmailNonEmpty(shift.email, user.email)) return true;
  return false;
}

function employeeVisibleShifts(user=currentUser()){
  try{
    if(!user || !state || !Array.isArray(state.shifts)) return [];
    return state.shifts
      .filter(s => validEmployeeShift(s) && isPublishedStatus(s) && shiftBelongsToUser(s, user))
      .map(s => ({...s, notes: cleanShiftNotes(s.notes)}))
      .sort(sortShift);
  }catch(e){
    console.warn("Employee own-shift visibility failed", e);
    return [];
  }
}

function employeeTeamScheduleShifts(user=currentUser()){
  if(!user || !state || !Array.isArray(state.shifts)) return [];
  const weekEnd = addDays(rosterWeekStart, 7);
  return state.shifts
    .filter(s => validEmployeeShift(s) && isPublishedStatus(s))
    .filter(s => !s.businessId || !user.businessId || s.businessId === user.businessId)
    .filter(s => inDateRange(s, rosterWeekStart, weekEnd))
    .map(s => ({...s, notes: cleanShiftNotes(s.notes)}))
    .sort(sortShift);
}

function teamScheduleEmployeeCard(s){
  const mine = shiftBelongsToUser(s, currentUser());
  const gone = isShiftGone(s);
  return `<div class="team-shift-card ${mine ? "is-mine" : ""}">
    <div>
      <strong>${esc(userName(s.employeeId))}</strong>
      <span>${esc(s.role || "Team Member")}</span>
    </div>
    <div class="team-shift-time"><b>${esc(s.start)} – ${esc(s.end)}</b><small>${shiftHours(s).toFixed(1)} hrs</small></div>
    <div class="team-shift-action">
      ${mine ? `<span class="badge good">Your shift</span>` : gone ? `<span class="badge draft">Completed</span>` : `<button class="tiny primary" onclick="openCoverShiftModal('${s.id}')">Request swap</button>`}
    </div>
  </div>`;
}

function employeeTeamScheduleView(){
  const user = currentUser();
  const days = Array.from({length:7},(_,i)=>addDays(rosterWeekStart,i));
  const shifts = employeeTeamScheduleShifts(user);
  return `<section class="employee-apple-dashboard qa-employee-page">
    ${pageHero("Team Schedule", "Read-only weekly roster. You can only manage your own shifts; use Request swap if you want to ask for another shift.")}
    <div class="qa-week-toolbar compact-toolbar">
      <div class="week-switcher"><button onclick="moveWeek(-7)">‹</button><span class="week-pill">${shortDate(rosterWeekStart)} - ${shortDate(addDays(rosterWeekStart,6))}</span><button onclick="moveWeek(7)">›</button></div>
      <button class="ghost" onclick="go('myshifts')">Back to My Shifts</button>
    </div>
    <div class="schedule-scroll-shell"><div class="team-week-board">
      ${days.map(day => {
        const date = isoDate(day);
        const rows = shifts.filter(s => s.date === date).sort(sortShift);
        return `<div class="team-day-column"><div class="team-day-head"><strong>${dayName(day)}</strong><span>${shortDate(day)}</span></div>${rows.length ? rows.map(teamScheduleEmployeeCard).join("") : `<div class="empty-shift">No published shifts</div>`}</div>`;
      }).join("")}
    </div></div>
  </section>`;
}

function openCoverShiftModal(shiftId){
  const user = currentUser();
  const s = state.shifts.find(x => x.id === shiftId);
  if(!user || !s) return toast("Shift not found.");
  if(shiftBelongsToUser(s, user)) return toast("This is already your shift. Use My Shifts to manage it.");
  if(isShiftGone(s)) return toast("Completed shifts cannot be requested.");
  modal(`<h3>Request swap</h3>
    <p class="muted">Ask the manager if this shift can be reassigned to you. The roster will not change until a manager approves it.</p>
    ${shiftDetailsCard(shiftId)}
    <label>Reason</label><textarea id="cover-msg" placeholder="Example: I am available and can cover this shift."></textarea>
    <div class="actions" style="margin-top:14px"><button class="primary" onclick="submitCoverShiftRequest('${shiftId}')">Submit request</button><button onclick="closeModal()">Cancel</button></div>`);
}

function submitCoverShiftRequest(shiftId){
  const user = currentUser();
  const s = state.shifts.find(x => x.id === shiftId);
  if(!user || !s) return toast("Shift not found.");
  if(shiftBelongsToUser(s, user)) return toast("This shift is already assigned to you.");
  const message = val("cover-msg");
  if(!message) return toast("Enter a reason for this swap request.");
  const duplicate = state.requests.find(r => r.type === "cover" && r.shiftId === shiftId && r.employeeId === user.id && r.status === "pending");
  if(duplicate) return toast("You already have a pending request for this shift.");
  const r = {id:uuid(), businessId:business().id, employeeId:user.id, originalEmployeeId:s.employeeId, shiftId, type:"cover", message, status:"pending", createdAt:now(), seenBy:[], shiftSnapshot:{date:s.date, day:fullDayName(dateObj(s.date)), time:`${s.start}-${s.end}`, role:s.role, status:s.status, notes:s.notes || ""}};
  state.requests.push(r);
  saveState();
  notifyRole(["owner","manager"], "request", "Swap request", `${user.name} requested to take/swap a shift from ${userName(s.employeeId)}.`, {requestId:r.id, shiftId, targetView:"requests"});
  notifyUser(s.employeeId, "swap", "Swap requested", `${user.name} asked to take one of your shifts. Manager approval is required before anything changes.`, {requestId:r.id, shiftId, targetView:"myrequests"});
  closeModal();
  renderContent();
  toast("Swap request sent to manager.");
}

const __v66ApproveRequestBase = approveRequest;
function approveRequest(id){
  const r = state.requests.find(x => x.id === id);
  if(r && r.type === "cover"){
    if(r.status !== "pending") return toast("This request is already handled.");
    const s = state.shifts.find(x => x.id === r.shiftId);
    if(!s) return toast("Original shift was not found.");
    const availabilityBlock = availabilityConflict({...s, employeeId:r.employeeId});
    if(availabilityBlock) return toast(availabilityBlock);
    const previousEmployeeId = s.employeeId;
    s.employeeId = r.employeeId;
    s.status = "published";
    s.notes = cleanShiftNoteForStorage(s.notes);
    r.status = "approved";
    r.rosterAction = "reassigned_shift_from_team_schedule";
    r.rosterActionAt = now();
    saveState();
    notifyUser(r.employeeId, "approval", "Swap approved", "The requested shift has been assigned to you.", {requestId:r.id, shiftId:r.shiftId, targetView:"myshifts"});
    notifyUser(previousEmployeeId, "swap", "Shift reassigned", `Your shift was reassigned to ${userName(r.employeeId)} after manager approval.`, {requestId:r.id, shiftId:r.shiftId, targetView:"myshifts"});
    renderContent();
    toast("Swap approved. Shift reassigned.");
    return;
  }
  return __v66ApproveRequestBase(id);
}

function requestTypeLabel(r){
  if(!r) return "Request";
  if(r.type === "availability") return "Availability";
  if(r.type === "swap") return "Shift Swap";
  if(r.type === "cover") return "Swap / Cover Shift";
  if(r.type === "change") return "Shift Change";
  return String(r.type || "Request");
}

function requestShortMessage(r){
  if(r.type === "availability"){
    const a = state.availability.find(x => x.id === r.availabilityId);
    if(a) return `${userName(r.employeeId)} is unavailable on ${a.date ? friendlyDate(a.date) : a.day}, ${a.start}-${a.end}${a.reason ? " • " + a.reason : ""}.`;
  }
  if(r.type === "cover") return `${userName(r.employeeId)} requested to take/swap a shift from ${userName(r.originalEmployeeId)}.`;
  if(r.type === "swap") return `${userName(r.employeeId)} requested a shift swap.`;
  if(r.type === "change") return `${userName(r.employeeId)} requested a shift change.`;
  return r.message || "Request received.";
}

function shellView(user){
  const nav = isManagerial(user) ? `
    <button data-view="dashboard" onclick="go('dashboard')">Dashboard</button>
    <button data-view="roster" onclick="go('roster')">Roster Builder</button>
    <button data-view="employees" onclick="go('employees')">Employees</button>
    <button data-view="credentials" onclick="go('credentials')">Team Access</button>
    <button data-view="requests" onclick="go('requests')">Requests</button>
    <button data-view="timesheets" onclick="go('timesheets')">Timesheets</button>
    <button data-view="reports" onclick="go('reports')">Reports</button>
    ${user.role === "owner" ? `<button data-view="settings" onclick="go('settings')">Business Settings</button>` : ""}
  ` : `
    <button data-view="myshifts" onclick="go('myshifts')">My Shifts</button>
    <button data-view="teamschedule" onclick="go('teamschedule')">Team Schedule</button>
    <button data-view="availability" onclick="go('availability')">My Availability</button>
    <button data-view="myrequests" onclick="go('myrequests')">My Requests</button>
    <button data-view="clock" onclick="go('clock')">Clock In/Out</button>
  `;
  return `<section class="layout mobile-ready-shell role-${user.role}"><aside class="sidebar" aria-label="Workspace navigation"><nav class="nav">${nav}</nav></aside><section class="content"><div id="view"></div></section></section>`;
}

function renderContent(){
  document.querySelectorAll(".nav button").forEach(btn => btn.classList.toggle("active", btn.dataset.view === currentView));
  const view = el("view");
  if(!view) return;
  const user = currentUser();
  if(!user){ render(); return; }
  if(currentView === "profile"){ view.innerHTML = profileView(); return; }
  if(isManagerial(user)){
    if(currentView === "dashboard") view.innerHTML = managerDashboard();
    else if(currentView === "roster") view.innerHTML = rosterView();
    else if(currentView === "employees") view.innerHTML = employeesView();
    else if(currentView === "credentials") view.innerHTML = credentialsView();
    else if(currentView === "requests") view.innerHTML = requestsView(true);
    else if(currentView === "timesheets") view.innerHTML = timesheetsView();
    else if(currentView === "reports") view.innerHTML = reportsView();
    else if(currentView === "notifications") view.innerHTML = notificationsView();
    else if(currentView === "settings") view.innerHTML = settingsView();
    else view.innerHTML = managerDashboard();
  }else{
    if(currentView === "myshifts" || currentView === "mywork" || currentView === "myhours") view.innerHTML = employeeWorkView();
    else if(currentView === "teamschedule") view.innerHTML = employeeTeamScheduleView();
    else if(currentView === "availability") view.innerHTML = availabilityView();
    else if(currentView === "myrequests") view.innerHTML = requestsView(false);
    else if(currentView === "clock") view.innerHTML = clockView();
    else if(currentView === "notifications") view.innerHTML = notificationsView();
    else if(currentView === "notices") view.innerHTML = employeeWorkView();
    else view.innerHTML = employeeWorkView();
  }
}

window.__myscheduleV66EmployeeAccessQA = function(){
  const user = currentUser();
  return {
    user: user ? {id:user.id, email:user.email, businessId:user.businessId} : null,
    identityIds: employeeIdentityIds(user),
    myShiftIds: employeeVisibleShifts(user).map(s => ({id:s.id, employeeId:s.employeeId, date:s.date, start:s.start, end:s.end})),
    teamShiftIdsThisWeek: employeeTeamScheduleShifts(user).map(s => ({id:s.id, employeeId:s.employeeId, employee:userName(s.employeeId), mine:shiftBelongsToUser(s,user), date:s.date, start:s.start, end:s.end}))
  };
};


/* v67 QA: true two-way shift swaps
   - Request Swap exchanges two shifts: requester gives their shift and receives another employee's shift.
   - Team Schedule swap also requires the employee to offer one of their own active shifts.
   - Manager approval swaps both employee assignments; it does not just transfer one shift.
*/
function activePublishedShiftForSwap(s, user=currentUser()){
  if(!s) return false;
  if(!validEmployeeShift(s) || !isPublishedStatus(s) || isShiftGone(s)) return false;
  if(user && user.businessId && s.businessId && s.businessId !== user.businessId) return false;
  return true;
}
function swapOptionLabel(s){
  return `${userName(s.employeeId)} • ${friendlyDate(s.date)} • ${s.start}-${s.end} • ${shiftHours(s).toFixed(1)} hrs`;
}
function openSwapModal(shiftId){
  const check = canEmployeeActOnShift(shiftId);
  if(!check.ok) return toast(check.message);
  const user = currentUser();
  const receiveOptions = state.shifts
    .filter(s => activePublishedShiftForSwap(s, user))
    .filter(s => !shiftBelongsToUser(s, user))
    .sort(sortShift);
  if(!receiveOptions.length){
    return modal(`<h3>Request Swap</h3>
      ${shiftDetailsCard(shiftId)}
      <div class="notice">No eligible coworker shifts are available to swap with right now.</div>
      <div class="actions" style="margin-top:14px"><button onclick="closeModal()">Close</button></div>`);
  }
  modal(`<h3>Request Swap</h3>
    <p class="muted">Choose the coworker shift you want. If a manager approves, your shift and the selected shift will be exchanged.</p>
    <div class="form-grid">
      <div>${shiftDetailsCard(shiftId)}</div>
      <div><label>Shift you want to receive</label><select id="s-target-shift">${receiveOptions.map(s => `<option value="${s.id}">${esc(swapOptionLabel(s))}</option>`).join("")}</select></div>
    </div>
    <label>Message</label><textarea id="s-msg" placeholder="Example: I can work their shift if they take mine."></textarea>
    <div class="actions" style="margin-top:14px"><button class="primary" onclick="submitSwap('${shiftId}')">Submit swap request</button><button onclick="closeModal()">Cancel</button></div>`);
}
function submitSwap(shiftId){
  const check = canEmployeeActOnShift(shiftId);
  if(!check.ok) return toast(check.message);
  const user = currentUser();
  const offeredShift = check.shift;
  const targetShiftId = val("s-target-shift");
  const targetShift = state.shifts.find(s => s.id === targetShiftId);
  if(!targetShift || !activePublishedShiftForSwap(targetShift, user) || shiftBelongsToUser(targetShift, user)) return toast("Choose a valid coworker shift to swap with.");
  const message = val("s-msg");
  if(!message) return toast("Enter a short reason for the swap request.");
  const duplicate = state.requests.find(r => r.type === "swap" && r.shiftId === shiftId && r.targetShiftId === targetShiftId && r.status === "pending");
  if(duplicate) return toast("This swap request is already pending.");
  const r = {
    id:uuid(), businessId:business().id, employeeId:user.id, shiftId,
    type:"swap", targetEmployeeId:targetShift.employeeId, targetShiftId,
    message, status:"pending", createdAt:now(), seenBy:[],
    shiftSnapshot: offeredShift ? {date:offeredShift.date, day:fullDayName(dateObj(offeredShift.date)), time:`${offeredShift.start}-${offeredShift.end}`, role:offeredShift.role, status:offeredShift.status, notes:offeredShift.notes || ""} : null,
    targetShiftSnapshot: targetShift ? {date:targetShift.date, day:fullDayName(dateObj(targetShift.date)), time:`${targetShift.start}-${targetShift.end}`, role:targetShift.role, status:targetShift.status, notes:targetShift.notes || "", employeeName:userName(targetShift.employeeId)} : null
  };
  state.requests.push(r);
  saveState();
  notifyRole(["owner","manager"], "request", "Shift swap request", `${user.name} requested a two-way swap with ${userName(targetShift.employeeId)}.`, {requestId:r.id, shiftId, targetView:"requests"});
  notifyUser(targetShift.employeeId, "swap", "Swap requested", `${user.name} asked to swap shifts with you. Manager approval is required before the roster changes.`, {requestId:r.id, shiftId:targetShiftId, targetView:"myrequests"});
  closeModal();
  renderContent();
  toast("Swap request submitted.");
}
function openCoverShiftModal(shiftId){
  const user = currentUser();
  const targetShift = state.shifts.find(x => x.id === shiftId);
  if(!user || !targetShift) return toast("Shift not found.");
  if(shiftBelongsToUser(targetShift, user)) return toast("This is already your shift. Use My Shifts to manage it.");
  if(!activePublishedShiftForSwap(targetShift, user)) return toast("Completed or draft shifts cannot be requested.");
  const myOffers = employeeVisibleShifts(user).filter(s => activePublishedShiftForSwap(s, user) && s.id !== shiftId);
  if(!myOffers.length){
    return modal(`<h3>Request Swap</h3>
      <p class="muted">This is a two-way swap. You need one of your own active shifts to offer in exchange.</p>
      ${shiftDetailsCard(shiftId)}
      <div class="notice">No active shift is available in your roster to offer for this swap.</div>
      <div class="actions" style="margin-top:14px"><button onclick="closeModal()">Close</button></div>`);
  }
  modal(`<h3>Request Swap</h3>
    <p class="muted">Choose one of your own shifts to offer. If approved, both shifts will exchange employees.</p>
    <div class="form-grid">
      <div><label>Shift you want</label>${shiftDetailsCard(shiftId)}</div>
      <div><label>Your shift to offer</label><select id="cover-offer-shift">${myOffers.map(s => `<option value="${s.id}">${esc(swapOptionLabel(s))}</option>`).join("")}</select></div>
    </div>
    <label>Reason</label><textarea id="cover-msg" placeholder="Example: I can work this shift if they take mine."></textarea>
    <div class="actions" style="margin-top:14px"><button class="primary" onclick="submitCoverShiftRequest('${shiftId}')">Submit swap request</button><button onclick="closeModal()">Cancel</button></div>`);
}
function submitCoverShiftRequest(shiftId){
  const user = currentUser();
  const targetShift = state.shifts.find(x => x.id === shiftId);
  const offeredShiftId = val("cover-offer-shift");
  const offeredShift = state.shifts.find(x => x.id === offeredShiftId);
  if(!user || !targetShift || !offeredShift) return toast("Choose both shifts for the swap.");
  if(shiftBelongsToUser(targetShift, user)) return toast("This shift is already assigned to you.");
  if(!shiftBelongsToUser(offeredShift, user)) return toast("You can only offer your own shift.");
  if(!activePublishedShiftForSwap(targetShift, user) || !activePublishedShiftForSwap(offeredShift, user)) return toast("Only active published shifts can be swapped.");
  const message = val("cover-msg");
  if(!message) return toast("Enter a reason for this swap request.");
  const duplicate = state.requests.find(r => r.type === "swap" && r.shiftId === offeredShiftId && r.targetShiftId === shiftId && r.status === "pending");
  if(duplicate) return toast("This swap request is already pending.");
  const r = {
    id:uuid(), businessId:business().id, employeeId:user.id,
    shiftId:offeredShiftId, targetShiftId:shiftId, targetEmployeeId:targetShift.employeeId,
    type:"swap", message, status:"pending", createdAt:now(), seenBy:[],
    shiftSnapshot:{date:offeredShift.date, day:fullDayName(dateObj(offeredShift.date)), time:`${offeredShift.start}-${offeredShift.end}`, role:offeredShift.role, status:offeredShift.status, notes:offeredShift.notes || ""},
    targetShiftSnapshot:{date:targetShift.date, day:fullDayName(dateObj(targetShift.date)), time:`${targetShift.start}-${targetShift.end}`, role:targetShift.role, status:targetShift.status, notes:targetShift.notes || "", employeeName:userName(targetShift.employeeId)}
  };
  state.requests.push(r);
  saveState();
  notifyRole(["owner","manager"], "request", "Shift swap request", `${user.name} requested a two-way swap with ${userName(targetShift.employeeId)}.`, {requestId:r.id, shiftId:offeredShiftId, targetView:"requests"});
  notifyUser(targetShift.employeeId, "swap", "Swap requested", `${user.name} asked to swap shifts with you. Manager approval is required before the roster changes.`, {requestId:r.id, shiftId:shiftId, targetView:"myrequests"});
  closeModal();
  renderContent();
  toast("Two-way swap request sent to manager.");
}
function approveTwoWaySwapRequest(r){
  if(!r || r.status !== "pending") return toast("This request is already handled.");
  const offered = state.shifts.find(s => s.id === r.shiftId);
  const wanted = state.shifts.find(s => s.id === r.targetShiftId);
  if(!offered || !wanted) return toast("One of the swap shifts was not found.");
  if(!activePublishedShiftForSwap(offered, null) || !activePublishedShiftForSwap(wanted, null)) return toast("Only active published shifts can be swapped.");
  const requesterId = r.employeeId;
  const otherEmployeeId = wanted.employeeId;
  if(!shiftBelongsToUser(offered, state.users.find(u => u.id === requesterId) || {id:requesterId,businessId:r.businessId})) return toast("Requester no longer owns the offered shift.");
  if(String(offered.employeeId) === String(wanted.employeeId)) return toast("These shifts already belong to the same employee.");
  const conflictForRequester = availabilityConflict({...wanted, employeeId:requesterId});
  if(conflictForRequester) return toast(conflictForRequester);
  const conflictForOther = availabilityConflict({...offered, employeeId:otherEmployeeId});
  if(conflictForOther) return toast(conflictForOther);
  offered.employeeId = otherEmployeeId;
  wanted.employeeId = requesterId;
  offered.status = "published";
  wanted.status = "published";
  offered.notes = cleanShiftNoteForStorage(offered.notes);
  wanted.notes = cleanShiftNoteForStorage(wanted.notes);
  r.status = "approved";
  r.rosterAction = "two_way_shift_swap";
  r.rosterActionAt = now();
  saveState();
  notifyUser(requesterId, "approval", "Swap approved", `Your swap was approved. You now have ${friendlyDate(wanted.date)} ${wanted.start}-${wanted.end}.`, {requestId:r.id, shiftId:wanted.id, targetView:"myshifts"});
  notifyUser(otherEmployeeId, "swap", "Swap approved", `A swap was approved. You now have ${friendlyDate(offered.date)} ${offered.start}-${offered.end}.`, {requestId:r.id, shiftId:offered.id, targetView:"myshifts"});
  renderContent();
  toast("Two-way swap approved. Both shifts exchanged.");
}
const __v67ApproveRequestBase = approveRequest;
function approveRequest(id){
  const r = state.requests.find(x => x.id === id);
  if(r && r.type === "swap") return approveTwoWaySwapRequest(r);
  return __v67ApproveRequestBase(id);
}
function requestShortMessage(r){
  if(r.type === "availability"){
    const a = state.availability.find(x => x.id === r.availabilityId);
    if(a) return `${userName(r.employeeId)} is unavailable on ${a.date ? friendlyDate(a.date) : a.day}, ${a.start}-${a.end}${a.reason ? " • " + a.reason : ""}.`;
  }
  if(r.type === "swap"){
    const target = r.targetShiftSnapshot ? ` for ${r.targetShiftSnapshot.employeeName || userName(r.targetEmployeeId)}'s ${r.targetShiftSnapshot.day || ""} ${r.targetShiftSnapshot.time || "shift"}` : "";
    return `${userName(r.employeeId)} requested a two-way shift swap${target}.`;
  }
  if(r.type === "cover") return `${userName(r.employeeId)} requested to take/swap a shift from ${userName(r.originalEmployeeId)}.`;
  if(r.type === "change") return `${userName(r.employeeId)} requested a shift change.`;
  return r.message || "Request received.";
}
function requestTypeLabel(r){
  if(!r) return "Request";
  if(r.type === "availability") return "Availability";
  if(r.type === "swap") return "Two-way Shift Swap";
  if(r.type === "cover") return "Swap / Cover Shift";
  if(r.type === "change") return "Shift Change";
  return String(r.type || "Request");
}

/* v72 QA cleanup: remove employee shift acknowledgement UI, fix duplicate day label, and hide time records by default. */
function employeeShiftCard(s, compact, past=false){
  ensureOperationsData();
  if(!s) return "";
  const d = s.date ? dateObj(s.date) : new Date();
  const start = s.start || "--:--";
  const end = s.end || "--:--";
  const hrs = (s.start && s.end) ? shiftHours(s).toFixed(1) : "0.0";
  const gone = past || isShiftGone(s);
  const notes = cleanShiftNotes(s.notes || "");
  const canManage = !compact && !gone;
  return `<div class="employee-shift-row ${gone ? "is-past" : ""}">
    <div class="employee-date-badge"><strong>${shortWeekday(d)}</strong><span>${s.date ? shortMonthDay(s.date) : "Date"}</span></div>
    <div class="employee-shift-main">
      <strong>${esc(start)} - ${esc(end)}</strong>
      <span>${hrs} hrs${notes ? " · " + esc(notes) : ""}</span>
    </div>
    ${gone ? `<span class="status-pill muted-pill">Completed</span>` : compact ? `<span class="status-pill published">Published</span>` : `<details class="action-menu"><summary>Manage</summary><div class="action-menu-list"><button onclick="openChangeModal('${s.id}')">Request Change</button><button onclick="openSwapModal('${s.id}')">Request Swap</button></div></details>`}
  </div>`;
}
function employeeShiftCardList(rows){
  const safeRows = (rows || []).filter(validEmployeeShift).sort(sortShift);
  if(!safeRows.length) return `<div class="apple-empty-mini"><strong>No shifts to show</strong><span>New published shifts will appear here.</span></div>`;
  return `<div class="employee-shift-list">${safeRows.map(s => employeeShiftCard(s, false)).join("")}</div>`;
}
function upcomingShiftMiniList(rows){
  rows = (rows || []).filter(validEmployeeShift).sort(sortShift);
  if(!rows.length) return `<div class="apple-empty-mini"><strong>No upcoming shifts</strong><span>Your next published shifts will appear here.</span></div>`;
  return `<div class="employee-shift-list compact-list">${rows.map(s => employeeShiftCard(s, true)).join("")}</div>`;
}
function employeePastShiftHistory(rows){
  const safeRows = (rows || []).filter(validEmployeeShift).sort(sortShift).reverse();
  if(!safeRows.length) return "";
  const groups = {};
  safeRows.forEach(s => {
    const wk = getMonday(dateObj(s.date || now().slice(0,10))).toISOString().slice(0,10);
    if(!groups[wk]) groups[wk] = [];
    groups[wk].push(s);
  });
  const weekKeys = Object.keys(groups).sort().reverse();
  return `<details class="previous-shifts week-history"><summary>Previous shifts</summary><div class="week-history-list">${weekKeys.map(wk => {
    const start = dateObj(wk);
    const end = addDays(start, 6);
    const label = `${start.toLocaleDateString(undefined,{month:"short",day:"numeric"})} - ${end.toLocaleDateString(undefined,{month:"short",day:"numeric",year:"numeric"})}`;
    return `<details class="week-history-card"><summary>${esc(label)} <span>${groups[wk].length} shifts</span></summary><div class="employee-shift-list compact-list">${groups[wk].sort(sortShift).map(s => employeeShiftCard(s, true, true)).join("")}</div></details>`;
  }).join("")}</div></details>`;
}
function employeeWorkView(){
  ensureOperationsData();
  const user = currentUser();
  if(!user) return `<div class="panel"><h2>My Shifts</h2><p class="muted">Please sign in again to view your published shifts.</p></div>`;
  let publishedAll = [];
  try{ publishedAll = employeeVisibleShifts(user).sort(sortShift); }catch(e){ console.warn(e); publishedAll = []; }
  const nowTime = new Date();
  const activePublished = publishedAll.filter(s => !isShiftGone(s, nowTime)).sort(sortShift);
  const pastPublished = publishedAll.filter(s => isShiftGone(s, nowTime)).sort(sortShift).reverse();
  const weekEnd = addDays(rosterWeekStart,7);
  const weekShifts = activePublished.filter(s => inDateRange(s, rosterWeekStart, weekEnd));
  const week = totalHours(weekShifts);
  const upcomingShifts = activePublished.filter(s => safeShiftDateTime(s) >= nowTime).sort(sortShift);
  const nextShift = upcomingShifts[0];
  const employeeIds = employeeIdentityIds(user);
  const pendingMine = state.requests.filter(r => employeeIds.includes(r.employeeId) && r.status === "pending").length;
  const activeClock = currentOpenTimesheet(user.id);
  const unreadNotices = typeof unreadNoticesFor === "function" ? unreadNoticesFor(user.id).length : 0;
  const focusTitle = nextShift ? friendlyDate(nextShift.date) : "No upcoming published shift";
  const focusSub = nextShift ? `${esc(nextShift.start)} – ${esc(nextShift.end)} · ${shiftHours(nextShift).toFixed(1)} hrs` : "New shifts will appear here after your manager publishes the roster.";
  const diagnostic = (!activePublished.length && !pastPublished.length) ? employeePublishedShiftDebugSummary(user) : "";
  return `<section class="employee-apple-dashboard qa-employee-page">
    ${pageHero("My Shifts", "Your active roster, time clock, requests, and notices in one calm view.")}
    <button class="dashboard-focus-card ${nextShift ? "all-clear" : ""}" onclick="${nextShift ? "document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})" : "go('availability')"}">
      <span class="focus-icon">${nextShift ? "→" : "✓"}</span><div><strong>${esc(focusTitle)}</strong><span>${focusSub}</span></div>
    </button>
    <div class="qa-metric-strip compact emp-metrics">
      <button onclick="document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})"><strong>${week.toFixed(1)}</strong><span>This week</span></button>
      <button onclick="go('clock')"><strong>${activeClock ? "On" : "Clock"}</strong><span>${activeClock ? "Working" : "In/Out"}</span></button>
      <button class="${pendingMine ? "attention" : ""}" onclick="go('myrequests')"><strong>${pendingMine ? employeeMetricValue(pendingMine) : "0"}</strong><span>Requests</span></button>
      <button class="${unreadNotices ? "attention" : ""}" onclick="go('notices')"><strong>${unreadNotices ? employeeMetricValue(unreadNotices) : "0"}</strong><span>Notices</span></button>
    </div>
    <div class="dashboard-two-col qa-two-col employee-compact-row"><div class="apple-panel qa-panel"><div class="apple-panel-head"><div><h3>Quick actions</h3><p>Clock, availability and requests without repeating your schedule.</p></div></div><div class="action-list"><button class="action-item" onclick="go('clock')"><span class="dot"></span><div><strong>Clock in/out</strong><small>Track actual work and breaks.</small></div><em>Open</em></button><button class="action-item" onclick="go('availability')"><span class="dot"></span><div><strong>Request unavailable</strong><small>Submit date, day, time and reason.</small></div><em>Open</em></button><button class="action-item" onclick="go('myrequests')"><span class="dot"></span><div><strong>My requests</strong><small>Track current approvals.</small></div><em>View</em></button>${nextShift ? `<button class="action-item" onclick="openChangeModal('${nextShift.id}')"><span class="dot"></span><div><strong>Request change</strong><small>For your next shift only.</small></div><em>Ask</em></button>` : ``}</div></div></div>
    <div class="apple-panel employee-single-schedule" id="my-published-schedule"><div class="apple-panel-head"><div><h3>Published schedule</h3><p>Your active and upcoming published shifts in one place. Completed shifts stay in previous shifts history.</p></div><span class="status-pill">${upcomingShifts.length} upcoming</span></div>${activePublished.length ? employeeShiftCardList(activePublished) : `<div class="apple-empty-mini"><strong>No active published shifts</strong><span>Past shifts are moved to history. New shifts will appear after publishing.</span></div>`}${diagnostic}${employeePastShiftHistory(pastPublished)}</div>
  </section>`;
}
function clockView(){
  ensureOperationsData();
  const user = currentUser();
  const active = currentOpenTimesheet(user.id);
  const br = activeBreak(active);
  const info = clockWindowInfo(user);
  const todayShift = active && active.shiftId ? state.shifts.find(s=>s.id===active.shiftId) : info.shift;
  const rows = state.timesheets.filter(t => t.employeeId === user.id).sort((a,b)=>(b.clockIn||"").localeCompare(a.clockIn||"")).slice(0,12);
  const emergencyAllowed = !active && !info.canClock;
  const disabledClockLabel = info.shift && info.mode === "too_early" ? `Clock In opens at ${info.shift.start ? timeAddMinutes(info.shift.start, -10) : "shift window"}` : (info.shift && info.mode === "late" ? "Normal Clock In closed" : "Clock In unavailable");
  return `<section class="apple-clean-page timeclock-page">
    ${pageHero("Clock", "Track real worked time, breaks, and attendance clearly.")}
    <div class="timeclock-focus apple-panel">
      <div>
        <span class="eyebrow">Today</span>
        <h3>${active ? "You are clocked in" : info.title}</h3>
        <p class="muted">${todayShift ? `Scheduled ${esc(todayShift.start)} – ${esc(todayShift.end)} · ${shiftHours(todayShift).toFixed(1)} hrs` : "No active published shift found for today."}</p>
        <div class="clock-rule-card ${info.canClock ? "ok" : emergencyAllowed ? "warn" : "soft"}">${esc(active ? "Complete your shift by ending breaks and clocking out when finished." : info.message)}</div>
        ${active ? `<p class="small muted">Clocked in ${dateTime(active.clockIn)} · Break ${breakMinutesFor(active)} mins · Worked ${workedHoursFor(active).toFixed(2)} hrs${active.isException ? ` · Emergency: ${esc(active.exceptionReason || "Manager review")}` : ""}</p>` : ""}
      </div>
      <div class="clock-actions">
        ${active ? `${br ? `<button class="secondary" onclick="endBreak()">End Break</button>` : `<button class="secondary" onclick="startBreak()">Start Break</button>`}<button class="danger" onclick="clockOut()">Clock Out</button>` : `${info.canClock ? `<button class="primary" onclick="clockIn()">Clock In</button>` : `<button class="disabled-action" disabled aria-disabled="true" title="${esc(info.message)}">${esc(disabledClockLabel)}</button>`}${emergencyAllowed ? `<button class="warning" onclick="openEmergencyClockIn()">Emergency Clock In</button>` : ""}`}
      </div>
    </div>
    <details class="apple-panel collapsible-records">
      <summary><span>My time records</span><small>Recent clock activity and manager approval status.</small></summary>
      <div class="collapsible-records-body">${employeeTimesheetCards(rows)}</div>
    </details>
  </section>`;
}

/* v73 compact manager dashboard override: smaller square metrics and cleaner publish suggestion card */
function managerDashboard(){
  const b = business();
  const user = currentUser();
  const employees = state.users.filter(u => u.businessId === b.id && u.role === "employee" && u.status === "active");
  const weekShifts = visibleWeekShifts();
  const pending = state.requests.filter(r => r.businessId === b.id && r.status === "pending");
  const alerts = buildAlerts();
  const publishCheck = buildPublishCheck();
  const notes = state.notifications.filter(n => n.businessId === b.id && n.userId === user.id).slice(-5).reverse();
  const issueCount = publishCheck.blockers.length || alerts.length;
  const title = pending.length
    ? `${pending.length} request${pending.length === 1 ? "" : "s"} need review`
    : publishCheck.blockers.length
      ? `${publishCheck.blockers.length} publishing issue${publishCheck.blockers.length === 1 ? "" : "s"}`
      : alerts.length
        ? `${alerts.length} schedule alert${alerts.length === 1 ? "" : "s"}`
        : "Ready to publish";
  const subtitle = pending.length
    ? "Handle staff requests before publishing roster changes."
    : publishCheck.blockers.length
      ? "Fix blocked items before sending the roster to staff."
      : alerts.length
        ? "Review suggestions before publishing."
        : "No urgent action. Review or publish the roster when ready.";
  return `<section class="qa-dashboard v73-dashboard">
    <div class="v73-manager-hero">
      <div class="v73-hero-copy">
        <span class="eyebrow">MySchedule</span>
        <h2>${esc(b?.name || "Manager Dashboard")}</h2>
        <p>${esc(subtitle)}</p>
      </div>
      <button class="primary v73-hero-action" onclick="go('${pending.length ? "requests" : "roster"}')">${pending.length ? "Review requests" : "Open roster"}</button>
    </div>

    <button class="v73-publish-card ${pending.length || publishCheck.blockers.length ? "needs-action" : "all-clear"}" onclick="${pending.length ? "go('requests')" : "openPublishReview()"}">
      <span class="v73-publish-icon">${pending.length || publishCheck.blockers.length ? "!" : "✓"}</span>
      <span class="v73-publish-text"><strong>${esc(title)}</strong><small>${esc(subtitle)}</small></span>
      <em>${pending.length ? "Review" : "Open roster"}</em>
    </button>

    <div class="qa-metric-strip v73-square-metrics" aria-label="Dashboard summary">
      <button onclick="go('employees')" title="Open employees"><strong>${employees.length}</strong><span>Team</span></button>
      <button onclick="go('roster')" title="Open roster"><strong>${totalHours(weekShifts).toFixed(1)}</strong><span>Week hrs</span></button>
      <button class="${pending.length ? "attention" : ""}" data-open-requests="true" onclick="openWorkspaceSection('requests',event)" title="Open requests"><strong>${pending.length || "Clear"}</strong><span>Requests</span></button>
      <button class="${publishCheck.blockers.length ? "attention" : ""}" onclick="openPublishReview()" title="Open publish check"><strong>${publishCheck.blockers.length || "Ready"}</strong><span>Publish check</span></button>
    </div>

    <div class="dashboard-two-col qa-two-col v73-dashboard-panels">
      <div class="apple-panel qa-panel">
        <div class="apple-panel-head"><div><h3>Next best actions</h3><p>Only items that help you decide what to do now.</p></div></div>
        ${qaActionList(pending, publishCheck, alerts)}
      </div>
      <div class="apple-panel qa-panel">
        <div class="apple-panel-head"><div><h3>Inbox</h3><p>Important schedule and request messages.</p></div><button class="tiny" onclick="go('notifications')">Open</button></div>
        ${dashboardNotificationList(notes)}
      </div>
    </div>
  </section>`;
}

/* v74 combined dashboard insights + Apple-style visualisations */
function qaMoney(n){ return "$" + (Number(n)||0).toFixed(0); }
function qaDefaultRate(){ return 20; }
function qaSafeMonthRange(baseDate){
  const d = baseDate ? new Date(baseDate) : new Date();
  if(isNaN(d)) return {start:new Date(), end:new Date()};
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth()+1, 1);
  return {start, end};
}
function qaBusinessShiftsInRange(start, end, publishedOnly=true){
  const b = business();
  return (state.shifts || []).filter(s => {
    if(!b || s.businessId !== b.id) return false;
    if(publishedOnly && !["published","confirmed"].includes(s.status)) return false;
    const d = safeShiftDateTime(s);
    return d >= start && d < end;
  }).sort(sortShift);
}
function qaEmployeeLimitWaste(weekShifts){
  const b = business();
  const byEmp = {};
  (weekShifts || []).forEach(s => {
    const id = s.employeeId || s.userId;
    if(!id) return;
    byEmp[id] = (byEmp[id] || 0) + shiftHours(s);
  });
  let extra = 0;
  Object.keys(byEmp).forEach(id => {
    const emp = (state.employees || []).find(e => e.userId === id || e.id === id);
    const limit = Number(emp?.weeklyLimit) || 0;
    if(limit && byEmp[id] > limit) extra += byEmp[id] - limit;
  });
  return extra;
}
function qaPriorityClass(count, warn=false){
  if(count > 0 || warn) return "priority-warn";
  return "priority-ok";
}
function qaMiniMetric(value,label,kind="neutral",onclick=""){
  const action = onclick ? ` onclick="${onclick}"` : "";
  const tag = onclick ? "button" : "div";
  return `<${tag} class="qa-mini-metric ${kind}"${action}><strong>${esc(value)}</strong><span>${esc(label)}</span></${tag}>`;
}
function qaBar(value, max, label, sub=""){
  const pct = Math.max(0, Math.min(100, max ? (value/max)*100 : 0));
  return `<div class="qa-viz-row"><div class="qa-viz-label"><strong>${esc(label)}</strong><span>${esc(sub)}</span></div><div class="qa-viz-track"><i style="width:${pct.toFixed(0)}%"></i></div><em>${Number(value).toFixed(1)}</em></div>`;
}
function qaWeeklyBars(shifts){
  const days = Array.from({length:7},(_,i)=>addDays(rosterWeekStart,i));
  const maxDay = Math.max(8, ...days.map(d => totalHours(shifts.filter(s => s.date === isoDate(d)))));
  return days.map(d => qaBar(totalHours(shifts.filter(s => s.date === isoDate(d))), maxDay, d.toLocaleDateString(undefined,{weekday:"short"}), d.toLocaleDateString(undefined,{month:"short",day:"numeric"}))).join("");
}
function qaMonthWeekBars(monthShifts){
  const month = qaSafeMonthRange(rosterWeekStart);
  const weeks = [];
  let cursor = getMonday(month.start);
  while(cursor < month.end){
    const wkStart = new Date(cursor); const wkEnd = addDays(wkStart,7);
    const hrs = totalHours(monthShifts.filter(s => safeShiftDateTime(s) >= wkStart && safeShiftDateTime(s) < wkEnd));
    weeks.push({label:`Week ${weeks.length+1}`, sub:`${wkStart.toLocaleDateString(undefined,{month:"short",day:"numeric"})}`, hrs});
    cursor = wkEnd;
    if(weeks.length > 6) break;
  }
  const max = Math.max(8, ...weeks.map(w => w.hrs));
  return weeks.map(w => qaBar(w.hrs, max, w.label, w.sub)).join("");
}
function qaInsightSummary(weekShifts, monthShifts){
  const days = Array.from({length:7},(_,i)=>addDays(rosterWeekStart,i));
  const dayStats = days.map(d => ({date:d, label:d.toLocaleDateString(undefined,{weekday:"short"}), sub:d.toLocaleDateString(undefined,{month:"short",day:"numeric"}), hrs:totalHours(weekShifts.filter(s => s.date === isoDate(d)))}));
  const busiestDay = dayStats.slice().sort((a,b)=>b.hrs-a.hrs)[0] || {label:"—",hrs:0};
  const month = qaSafeMonthRange(rosterWeekStart);
  const weeks = [];
  let cursor = getMonday(month.start);
  while(cursor < month.end){
    const wkStart = new Date(cursor); const wkEnd = addDays(wkStart,7);
    const hrs = totalHours(monthShifts.filter(s => safeShiftDateTime(s) >= wkStart && safeShiftDateTime(s) < wkEnd));
    weeks.push({label:`Week ${weeks.length+1}`, sub:wkStart.toLocaleDateString(undefined,{month:"short",day:"numeric"}), hrs});
    cursor = wkEnd;
    if(weeks.length > 6) break;
  }
  const busiestWeek = weeks.slice().sort((a,b)=>b.hrs-a.hrs)[0] || {label:"—",hrs:0};
  return {dayStats,weeks,busiestDay,busiestWeek,weekHours:totalHours(weekShifts),monthHours:totalHours(monthShifts)};
}
var qaInsightPrefs = window.qaInsightPrefs || {};
function qaWeekRangeLabel(start=rosterWeekStart){ return `${shortDate(start)} – ${shortDate(addDays(start,6))}`; }
function qaMonthRangeLabel(start=rosterWeekStart){ return start.toLocaleDateString(undefined,{month:"long", year:"numeric"}); }
function qaCompactBars(items, viewType="week"){
  const max = Math.max(1, ...items.map(x => Number(x.hrs)||0));
  return `<div class="qa-compact-bars">${items.map((x, index) => {
    const hrs = Number(x.hrs)||0;
    const pct = Math.max(3, Math.min(100, max ? hrs/max*100 : 0));
    const insight = hrs === 0 ? "Quiet" : hrs >= 8 ? "High" : "Normal";
    return `<div class="qa-compact-bar" data-chron="${index}" data-hours="${hrs}" data-filter="${hrs > 0 ? 'with-hours' : 'empty'} ${hrs >= 8 ? 'high-hours' : ''}"><div class="qa-compact-name"><strong>${esc(x.label)}</strong><span>${esc(x.sub||"")}</span></div><div class="qa-compact-track"><i style="width:${pct.toFixed(0)}%"></i></div><em>${hrs.toFixed(1)}<small>${insight}</small></em></div>`;
  }).join("")}</div>`;
}
function qaApplyInsightControls(panelId){
  const panel = document.querySelector(`[data-insight-panel="${panelId}"]`);
  if(!panel) return;
  const prefs = qaInsightPrefs[panelId] || {};
  const activeTab = prefs.tab || panel.querySelector('.qa-insight-tab.active')?.dataset.tab || 'week';
  const sort = prefs.sort || panel.querySelector('.qa-insight-sort')?.value || 'chron';
  const filter = prefs.filter || panel.querySelector('.qa-insight-filter')?.value || 'all';
  panel.querySelectorAll('.qa-insight-view').forEach(view => {
    const isActive = view.dataset.view === activeTab;
    view.classList.toggle('hidden', !isActive);
    if(!isActive) return;
    const host = view.querySelector('.qa-compact-bars');
    if(!host) return;
    const rows = [...host.querySelectorAll('.qa-compact-bar')];
    rows.sort((a,b) => {
      if(sort === 'high') return Number(b.dataset.hours||0) - Number(a.dataset.hours||0);
      if(sort === 'low') return Number(a.dataset.hours||0) - Number(b.dataset.hours||0);
      return Number(a.dataset.chron||0) - Number(b.dataset.chron||0);
    }).forEach(row => host.appendChild(row));
    rows.forEach(row => {
      const hrs = Number(row.dataset.hours||0);
      const show = filter === 'all' || (filter === 'with-hours' && hrs > 0) || (filter === 'high-hours' && hrs >= 8);
      row.classList.toggle('hidden', !show);
    });
    const anyVisible = rows.some(row => !row.classList.contains('hidden'));
    let empty = view.querySelector('.qa-insight-empty');
    if(!anyVisible){
      if(!empty){ empty = document.createElement('div'); empty.className = 'qa-insight-empty'; empty.textContent = 'No hours match this filter.'; view.appendChild(empty); }
    }else if(empty){ empty.remove(); }
  });
  panel.querySelectorAll('.qa-insight-tab').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === activeTab));
  const label = panel.querySelector('.qa-insight-period-label');
  if(label) label.textContent = activeTab === 'month' ? `Month: ${qaMonthRangeLabel()}` : `Week: ${qaWeekRangeLabel()}`;
}
function qaToggleInsightPanel(panelId, tab){
  qaInsightPrefs[panelId] = {...(qaInsightPrefs[panelId] || {}), tab};
  qaApplyInsightControls(panelId);
}
function qaInsightSetSort(panelId, value){
  qaInsightPrefs[panelId] = {...(qaInsightPrefs[panelId] || {}), sort:value};
  qaApplyInsightControls(panelId);
}
function qaInsightSetFilter(panelId, value){
  qaInsightPrefs[panelId] = {...(qaInsightPrefs[panelId] || {}), filter:value};
  qaApplyInsightControls(panelId);
}
function qaMoveInsightPeriod(panelId, direction){
  const activeTab = (qaInsightPrefs[panelId] && qaInsightPrefs[panelId].tab) || document.querySelector(`[data-insight-panel="${panelId}"] .qa-insight-tab.active`)?.dataset.tab || 'week';
  if(activeTab === 'month'){
    rosterWeekStart = getMonday(new Date(rosterWeekStart.getFullYear(), rosterWeekStart.getMonth()+direction, 1));
  }else{
    rosterWeekStart = addDays(rosterWeekStart, direction * 7);
  }
  qaInsightPrefs[panelId] = {...(qaInsightPrefs[panelId] || {}), tab:activeTab};
  renderContent();
}
function qaSmartHoursPanel(panelId, weekShifts, monthShifts, mode="manager"){
  const info = qaInsightSummary(weekShifts, monthShifts);
  const over = mode === "manager" ? qaEmployeeLimitWaste(weekShifts) : 0;
  const prefs = qaInsightPrefs[panelId] || {};
  const active = prefs.tab || "week";
  const sort = prefs.sort || "chron";
  const filter = prefs.filter || "all";
  const title = mode === "employee" ? "My hours insight" : "Roster insight";
  const note = over > 0 ? `${over.toFixed(1)} hrs above selected weekly limits` : (info.weekHours ? `Busiest day ${info.busiestDay.label}, busiest week ${info.busiestWeek.label}` : "No hours in selected view");
  return `<div class="apple-panel qa-panel qa-smart-insight qa-smart-dynamic" data-insight-panel="${esc(panelId)}">
    <div class="qa-smart-head">
      <div><h3>${esc(title)}</h3><p class="qa-insight-period-label">${active === "month" ? `Month: ${qaMonthRangeLabel()}` : `Week: ${qaWeekRangeLabel()}`}</p></div>
      <div class="qa-smart-tabs" role="tablist">
        <button class="qa-insight-tab ${active === "week" ? "active" : ""}" data-tab="week" onclick="qaToggleInsightPanel('${esc(panelId)}','week')">Week</button>
        <button class="qa-insight-tab ${active === "month" ? "active" : ""}" data-tab="month" onclick="qaToggleInsightPanel('${esc(panelId)}','month')">Month</button>
      </div>
    </div>
    <div class="qa-insight-controls">
      <button class="tiny" title="Previous period" onclick="qaMoveInsightPeriod('${esc(panelId)}',-1)">‹</button>
      <button class="tiny" title="Next period" onclick="qaMoveInsightPeriod('${esc(panelId)}',1)">›</button>
      <select class="qa-insight-sort" onchange="qaInsightSetSort('${esc(panelId)}', this.value)">
        <option value="chron" ${sort === "chron" ? "selected" : ""}>Sort by date</option>
        <option value="high" ${sort === "high" ? "selected" : ""}>High hours first</option>
        <option value="low" ${sort === "low" ? "selected" : ""}>Low hours first</option>
      </select>
      <select class="qa-insight-filter" onchange="qaInsightSetFilter('${esc(panelId)}', this.value)">
        <option value="all" ${filter === "all" ? "selected" : ""}>All</option>
        <option value="with-hours" ${filter === "with-hours" ? "selected" : ""}>With hours</option>
        <option value="high-hours" ${filter === "high-hours" ? "selected" : ""}>8+ hrs</option>
      </select>
    </div>
    <div class="qa-smart-summary compact-summary">
      <div><strong>${info.weekHours.toFixed(1)}</strong><span>selected week</span></div>
      <div><strong>${info.monthHours.toFixed(1)}</strong><span>${qaMonthRangeLabel()}</span></div>
      <div class="${over > 0 ? "priority-warn" : "priority-ok"}"><strong>${over > 0 ? "Review" : "OK"}</strong><span>${esc(note)}</span></div>
    </div>
    <div class="qa-insight-view ${active === "week" ? "" : "hidden"}" data-view="week">${qaCompactBars(info.dayStats,"week")}</div>
    <div class="qa-insight-view ${active === "month" ? "" : "hidden"}" data-view="month">${qaCompactBars(info.weeks,"month")}</div>
  </div>`;
}
function qaManagerInsightPanels(weekShifts, monthShifts){
  return qaSmartHoursPanel("manager-hours", weekShifts, monthShifts, "manager");
}
function managerDashboard(){
  const b = business();
  const user = currentUser();
  const employees = state.users.filter(u => u.businessId === b.id && u.role === "employee" && u.status === "active");
  const weekShifts = visibleWeekShifts();
  const monthRange = qaSafeMonthRange(rosterWeekStart);
  const monthShifts = qaBusinessShiftsInRange(monthRange.start, monthRange.end, true);
  const pending = state.requests.filter(r => r.businessId === b.id && r.status === "pending");
  const alerts = buildAlerts();
  const publishCheck = buildPublishCheck();
  const notes = state.notifications.filter(n => n.businessId === b.id && n.userId === user.id).slice(-5).reverse();
  const blockers = publishCheck.blockers.length;
  const statusText = pending.length ? `${pending.length} request${pending.length===1?"":"s"}` : blockers ? `${blockers} publish issue${blockers===1?"":"s"}` : alerts.length ? `${alerts.length} schedule alert${alerts.length===1?"":"s"}` : "Ready";
  const subtitle = pending.length ? "Review requests before publishing." : blockers ? "Fix required items before publishing." : alerts.length ? "Review suggestions before publishing." : "Roster is ready when you are.";
  const weekHours = totalHours(weekShifts).toFixed(1);
  return `<section class="qa-dashboard v74-dashboard">
    <div class="v74-executive-card">
      <div class="v74-exec-left">
        <span class="eyebrow">MySchedule</span>
        <h2>${esc(b?.name || "Manager Dashboard")}</h2>
        <p>${esc(subtitle)}</p>
        <div class="v74-hero-actions"><button class="primary" onclick="go('roster')">Open roster</button>${pending.length ? `<button class="ghost" onclick="go('requests')">Review requests</button>` : `<button class="ghost" onclick="openPublishReview()">Publish check</button>`}</div>
      </div>
      <div class="v74-combined-square ${pending.length || blockers || alerts.length ? "needs-action" : "all-clear"}" aria-label="Dashboard summary">
        <div class="v74-square-status"><span>${pending.length || blockers ? "!" : "✓"}</span><strong>${esc(statusText)}</strong></div>
        <div class="v74-square-grid">
          ${qaMiniMetric(employees.length,"Team","blue","go('employees')")}
          ${qaMiniMetric(weekHours,"Week hrs", Number(weekHours)>0?"blue":"neutral","go('roster')")}
          ${qaMiniMetric(pending.length || "0","Requests", pending.length?"orange":"green","openWorkspaceSection('requests',event)")}
          ${qaMiniMetric(blockers || "Ready","Publish", blockers?"red":"green","openPublishReview()")}
        </div>
      </div>
    </div>
    ${qaManagerInsightPanels(weekShifts, monthShifts)}
    <div class="dashboard-two-col qa-two-col v73-dashboard-panels">
      <div class="apple-panel qa-panel"><div class="apple-panel-head"><div><h3>Next best actions</h3><p>Only items that help you decide what to do now.</p></div></div>${qaActionList(pending, publishCheck, alerts)}</div>
      <div class="apple-panel qa-panel"><div class="apple-panel-head"><div><h3>Inbox</h3><p>Important schedule and request messages.</p></div><button class="tiny" onclick="go('notifications')">Open</button></div>${dashboardNotificationList(notes)}</div>
    </div>
  </section>`;
}
function qaEmployeeInsightPanels(activePublished, weekShifts){
  const monthRange = qaSafeMonthRange(rosterWeekStart);
  const monthShifts = activePublished.filter(s => safeShiftDateTime(s) >= monthRange.start && safeShiftDateTime(s) < monthRange.end);
  return qaSmartHoursPanel("employee-hours", weekShifts, monthShifts, "employee");
}
function employeeWorkView(){
  ensureOperationsData();
  const user = currentUser();
  if(!user) return `<div class="panel"><h2>My Shifts</h2><p class="muted">Please sign in again to view your published shifts.</p></div>`;
  let publishedAll = [];
  try{ publishedAll = employeeVisibleShifts(user).sort(sortShift); }catch(e){ console.warn(e); publishedAll = []; }
  const nowTime = new Date();
  const activePublished = publishedAll.filter(s => !isShiftGone(s, nowTime)).sort(sortShift);
  const pastPublished = publishedAll.filter(s => isShiftGone(s, nowTime)).sort(sortShift).reverse();
  const weekEnd = addDays(rosterWeekStart,7);
  const weekShifts = activePublished.filter(s => inDateRange(s, rosterWeekStart, weekEnd)).sort(sortShift);
  const week = totalHours(weekShifts);
  const upcomingShifts = activePublished.filter(s => safeShiftDateTime(s) >= nowTime).sort(sortShift);
  const nextShift = upcomingShifts[0];
  const employeeIds = employeeIdentityIds(user);
  const pendingMine = state.requests.filter(r => employeeIds.includes(r.employeeId) && r.status === "pending").length;
  const activeClock = currentOpenTimesheet(user.id);
  const unreadNotices = typeof unreadNoticesFor === "function" ? unreadNoticesFor(user.id).length : 0;
  const focusTitle = nextShift ? friendlyDate(nextShift.date) : "No upcoming published shift";
  const focusSub = nextShift ? `${esc(nextShift.start)} – ${esc(nextShift.end)} · ${shiftHours(nextShift).toFixed(1)} hrs` : "New shifts will appear here after your manager publishes the roster.";
  const diagnostic = (!activePublished.length && !pastPublished.length) ? employeePublishedShiftDebugSummary(user) : "";
  return `<section class="employee-apple-dashboard qa-employee-page v74-employee-dashboard">
    <div class="v74-executive-card employee">
      <div class="v74-exec-left"><span class="eyebrow">MySchedule</span><h2>My Shifts</h2><p>Your active roster, clock, requests, and notices in one calm view.</p><div class="v74-hero-actions"><button class="primary" onclick="${nextShift ? "document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})" : "go('availability')"}">${nextShift ? "View schedule" : "Set availability"}</button><button class="ghost" onclick="go('clock')">Clock</button></div></div>
      <div class="v74-combined-square all-clear">
        <div class="v74-square-status"><span>→</span><strong>${esc(focusTitle)}</strong></div>
        <small class="v74-square-sub">${focusSub}</small>
        <div class="v74-square-grid">
          ${qaMiniMetric(week.toFixed(1),"This week","blue","document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})")}
          ${qaMiniMetric(upcomingShifts.length,"Upcoming",upcomingShifts.length?"blue":"neutral","document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})")}
          ${qaMiniMetric(pendingMine || "0","Requests",pendingMine?"orange":"green","go('myrequests')")}
          ${qaMiniMetric(activeClock ? "On" : "Clock","Clock",activeClock?"orange":"green","go('clock')")}
        </div>
      </div>
    </div>
    ${qaEmployeeInsightPanels(activePublished, weekShifts)}
    <div class="dashboard-two-col qa-two-col employee-compact-row"><div class="apple-panel qa-panel"><div class="apple-panel-head"><div><h3>Quick actions</h3><p>Clock, availability and requests without repeating your schedule.</p></div></div><div class="action-list"><button class="action-item" onclick="go('clock')"><span class="dot"></span><div><strong>Clock in/out</strong><small>Track actual work and breaks.</small></div><em>Open</em></button><button class="action-item" onclick="go('availability')"><span class="dot"></span><div><strong>Request unavailable</strong><small>Submit date, day, time and reason.</small></div><em>Open</em></button><button class="action-item" onclick="go('myrequests')"><span class="dot"></span><div><strong>My requests</strong><small>Track current approvals.</small></div><em>View</em></button>${nextShift ? `<button class="action-item" onclick="openChangeModal('${nextShift.id}')"><span class="dot"></span><div><strong>Request change</strong><small>For your next shift only.</small></div><em>Ask</em></button>` : ``}</div></div></div>
    <div class="apple-panel employee-single-schedule" id="my-published-schedule"><div class="apple-panel-head"><div><h3>Published schedule</h3><p>Your active and upcoming published shifts in one place. Completed shifts stay in previous shifts history.</p></div><span class="status-pill">${upcomingShifts.length} upcoming</span></div>${activePublished.length ? employeeShiftCardList(activePublished) : `<div class="apple-empty-mini"><strong>No active published shifts</strong><span>Past shifts are moved to history. New shifts will appear after publishing.</span></div>`}${diagnostic}${employeePastShiftHistory(pastPublished)}</div>
  </section>`;
}

/* v78 compact manager squares + fixed independent insight period controls + employee simplification */
const qaV78InsightState = window.qaV78InsightState || { mode: "week", base: null, sort: "date", filter: "with-hours" };
window.qaV78InsightState = qaV78InsightState;
function qaV78BaseDate(){
  const d = qaV78InsightState.base ? new Date(qaV78InsightState.base + "T00:00:00") : new Date(rosterWeekStart || new Date());
  return isNaN(d) ? getMonday(new Date()) : getMonday(d);
}
function qaV78SetMode(mode){ qaV78InsightState.mode = mode === "month" ? "month" : "week"; renderContent(); }
function qaV78SetSort(value){ qaV78InsightState.sort = value || "date"; renderContent(); }
function qaV78SetFilter(value){ qaV78InsightState.filter = value || "with-hours"; renderContent(); }
function qaV78Move(delta){
  const base = qaV78BaseDate();
  let next;
  if(qaV78InsightState.mode === "month") next = getMonday(new Date(base.getFullYear(), base.getMonth() + delta, 1));
  else next = addDays(base, delta * 7);
  qaV78InsightState.base = isoDate(next);
  renderContent();
}
function qaV78Period(){
  const base = qaV78BaseDate();
  if(qaV78InsightState.mode === "month"){
    const start = new Date(base.getFullYear(), base.getMonth(), 1);
    const end = new Date(base.getFullYear(), base.getMonth()+1, 1);
    return {base,start,end,label:start.toLocaleDateString(undefined,{month:"long",year:"numeric"})};
  }
  return {base,start:base,end:addDays(base,7),label:`${shortDate(base)} – ${shortDate(addDays(base,6))}`};
}
function qaV78Rows(){
  const period = qaV78Period();
  const b = business();
  if(!b) return {period,rows:[],total:0,review:0};
  const all = (state.shifts || []).filter(s => s.businessId === b.id && ["published","confirmed"].includes(s.status));
  let rows = [];
  if(qaV78InsightState.mode === "month"){
    let cursor = getMonday(period.start);
    let i = 1;
    while(cursor < period.end && i <= 6){
      const wkStart = new Date(cursor), wkEnd = addDays(wkStart,7);
      const hrs = totalHours(all.filter(s => safeShiftDateTime(s) >= wkStart && safeShiftDateTime(s) < wkEnd));
      rows.push({label:`Week ${i}`, sub:wkStart.toLocaleDateString(undefined,{month:"short",day:"numeric"}), hrs, order:i});
      cursor = wkEnd; i++;
    }
  }else{
    for(let i=0;i<7;i++){
      const d = addDays(period.start,i);
      const hrs = totalHours(all.filter(s => s.date === isoDate(d)));
      rows.push({label:d.toLocaleDateString(undefined,{weekday:"short"}), sub:d.toLocaleDateString(undefined,{month:"short",day:"numeric"}), hrs, order:i});
    }
  }
  const total = rows.reduce((sum,r)=>sum+r.hrs,0);
  const weekShifts = qaBusinessShiftsInRange(period.start, period.end, true);
  const review = qaEmployeeLimitWaste(weekShifts);
  if(qaV78InsightState.filter === "with-hours") rows = rows.filter(r => r.hrs > 0);
  if(qaV78InsightState.filter === "high") rows = rows.filter(r => r.hrs >= 8);
  if(qaV78InsightState.sort === "high") rows.sort((a,b)=>b.hrs-a.hrs);
  else if(qaV78InsightState.sort === "low") rows.sort((a,b)=>a.hrs-b.hrs);
  else rows.sort((a,b)=>a.order-b.order);
  return {period,rows,total,review};
}
function qaV78MiniBars(rows){
  const max = Math.max(1, ...rows.map(r => r.hrs));
  if(!rows.length) return `<div class="v78-empty">No roster hours in this view</div>`;
  return `<div class="v78-bars">${rows.slice(0,7).map(r => {
    const pct = Math.max(4, Math.min(100, r.hrs/max*100));
    return `<div class="v78-bar"><div><strong>${esc(r.label)}</strong><span>${esc(r.sub)}</span></div><i><b style="width:${pct.toFixed(0)}%"></b></i><em>${r.hrs.toFixed(1)}</em></div>`;
  }).join("")}</div>`;
}
function qaV78InsightSquare(){
  const data = qaV78Rows();
  const reviewText = data.review > 0 ? `${data.review.toFixed(1)} hrs review` : "OK";
  return `<section class="v78-square v78-insight-square">
    <div class="v78-square-head"><div><span>Roster insight</span><strong>${esc(data.period.label)}</strong></div><em>${data.total.toFixed(1)} hrs</em></div>
    <div class="v78-control-row">
      <button class="${qaV78InsightState.mode === "week" ? "active" : ""}" onclick="qaV78SetMode('week')">Week</button>
      <button class="${qaV78InsightState.mode === "month" ? "active" : ""}" onclick="qaV78SetMode('month')">Month</button>
      <button onclick="qaV78Move(-1)" title="Previous period">‹</button>
      <button onclick="qaV78Move(1)" title="Next period">›</button>
    </div>
    <div class="v78-select-row">
      <select onchange="qaV78SetSort(this.value)"><option value="date" ${qaV78InsightState.sort === "date" ? "selected" : ""}>Date order</option><option value="high" ${qaV78InsightState.sort === "high" ? "selected" : ""}>High first</option><option value="low" ${qaV78InsightState.sort === "low" ? "selected" : ""}>Low first</option></select>
      <select onchange="qaV78SetFilter(this.value)"><option value="all" ${qaV78InsightState.filter === "all" ? "selected" : ""}>All</option><option value="with-hours" ${qaV78InsightState.filter === "with-hours" ? "selected" : ""}>With hours</option><option value="high" ${qaV78InsightState.filter === "high" ? "selected" : ""}>8+ hrs</option></select>
    </div>
    ${qaV78MiniBars(data.rows)}
    <button class="v78-link-action ${data.review > 0 ? "warn" : "ok"}" onclick="openPublishReview()">${esc(reviewText)}</button>
  </section>`;
}
function qaV78ActionSquare(employees, weekHours, pending, blockers, alerts){
  return `<section class="v78-square v78-action-square">
    <div class="v78-square-head"><div><span>Today</span><strong>${pending ? "Action needed" : blockers ? "Publish issue" : alerts ? "Review alerts" : "Ready"}</strong></div><em>${alerts || blockers || pending ? "Review" : "OK"}</em></div>
    <div class="v78-action-grid">
      <button class="blue" onclick="go('employees')"><strong>${employees}</strong><span>Team</span></button>
      <button class="blue" onclick="go('roster')"><strong>${Number(weekHours).toFixed(1)}</strong><span>Week hrs</span></button>
      <button class="${pending ? "orange" : "green"}" data-open-requests="true" onclick="openWorkspaceSection('requests',event)"><strong>${pending}</strong><span>Requests</span></button>
      <button class="${blockers ? "red" : "green"}" onclick="openPublishReview()"><strong>${blockers || "Ready"}</strong><span>Publish</span></button>
    </div>
  </section>`;
}
function managerDashboard(){
  const b = business();
  const user = currentUser();
  const employees = state.users.filter(u => u.businessId === b.id && u.role === "employee" && u.status === "active");
  const weekShifts = visibleWeekShifts();
  const pending = state.requests.filter(r => r.businessId === b.id && r.status === "pending");
  const alerts = buildAlerts();
  const publishCheck = buildPublishCheck();
  const notes = state.notifications.filter(n => n.businessId === b.id && n.userId === user.id).slice(-5).reverse();
  const blockers = publishCheck.blockers.length;
  const subtitle = pending.length ? "Review requests before publishing." : blockers ? "Fix required items before publishing." : alerts.length ? "Review suggestions before publishing." : "Roster is ready when you are.";
  return `<section class="qa-dashboard v78-dashboard">
    <div class="v78-top-grid">
      <section class="v78-business-card">
        <span class="eyebrow">MySchedule</span>
        <h2>${esc(b?.name || "Manager Dashboard")}</h2>
        <p>${esc(subtitle)}</p>
        <div class="v78-business-actions"><button class="primary" onclick="go('roster')">Open roster</button><button class="ghost" onclick="${pending.length ? "go('requests')" : "openPublishReview()"}">${pending.length ? "Review requests" : "Publish check"}</button></div>
      </section>
      ${qaV78ActionSquare(employees.length, totalHours(weekShifts), pending.length, blockers, alerts.length)}
      ${qaV78InsightSquare()}
    </div>
    <div class="dashboard-two-col qa-two-col v78-lower-panels">
      <div class="apple-panel qa-panel"><div class="apple-panel-head"><div><h3>Next best actions</h3><p>Only items that help you decide what to do now.</p></div></div>${qaActionList(pending, publishCheck, alerts)}</div>
      <div class="apple-panel qa-panel"><div class="apple-panel-head"><div><h3>Inbox</h3><p>Important schedule and request messages.</p></div><button class="tiny" onclick="go('notifications')">Open</button></div>${dashboardNotificationList(notes)}</div>
    </div>
  </section>`;
}
function employeeWorkView(){
  ensureOperationsData();
  const user = currentUser();
  if(!user) return `<div class="panel"><h2>My Shifts</h2><p class="muted">Please sign in again to view your published shifts.</p></div>`;
  let publishedAll = [];
  try{ publishedAll = employeeVisibleShifts(user).sort(sortShift); }catch(e){ console.warn(e); publishedAll = []; }
  const nowTime = new Date();
  const activePublished = publishedAll.filter(s => !isShiftGone(s, nowTime)).sort(sortShift);
  const pastPublished = publishedAll.filter(s => isShiftGone(s, nowTime)).sort(sortShift).reverse();
  const weekEnd = addDays(rosterWeekStart,7);
  const weekShifts = activePublished.filter(s => inDateRange(s, rosterWeekStart, weekEnd)).sort(sortShift);
  const week = totalHours(weekShifts);
  const upcomingShifts = activePublished.filter(s => safeShiftDateTime(s) >= nowTime).sort(sortShift);
  const nextShift = upcomingShifts[0];
  const employeeIds = employeeIdentityIds(user);
  const pendingMine = state.requests.filter(r => employeeIds.includes(r.employeeId) && r.status === "pending").length;
  const activeClock = currentOpenTimesheet(user.id);
  const focusTitle = nextShift ? friendlyDate(nextShift.date) : "No upcoming published shift";
  const focusSub = nextShift ? `${esc(nextShift.start)} – ${esc(nextShift.end)} · ${shiftHours(nextShift).toFixed(1)} hrs` : "New shifts will appear after your manager publishes the roster.";
  const diagnostic = (!activePublished.length && !pastPublished.length) ? employeePublishedShiftDebugSummary(user) : "";
  return `<section class="employee-apple-dashboard qa-employee-page v74-employee-dashboard">
    <div class="v74-executive-card employee">
      <div class="v74-exec-left"><span class="eyebrow">MySchedule</span><h2>My Shifts</h2><p>Your active roster, clock, requests, and notices in one calm view.</p><div class="v74-hero-actions"><button class="primary" onclick="${nextShift ? "document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})" : "go('availability')"}">${nextShift ? "View schedule" : "Set availability"}</button><button class="ghost" onclick="go('clock')">Clock</button></div></div>
      <div class="v74-combined-square all-clear">
        <div class="v74-square-status"><span>→</span><strong>${esc(focusTitle)}</strong></div>
        <small class="v74-square-sub">${focusSub}</small>
        <div class="v74-square-grid">
          ${qaMiniMetric(week.toFixed(1),"This week","blue","document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})")}
          ${qaMiniMetric(upcomingShifts.length,"Upcoming",upcomingShifts.length?"blue":"neutral","document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})")}
          ${qaMiniMetric(pendingMine || "0","Requests",pendingMine?"orange":"green","go('myrequests')")}
          ${qaMiniMetric(activeClock ? "On" : "Clock","Clock",activeClock?"orange":"green","go('clock')")}
        </div>
      </div>
    </div>
    <div class="dashboard-two-col qa-two-col employee-compact-row"><div class="apple-panel qa-panel"><div class="apple-panel-head"><div><h3>Quick actions</h3><p>Clock, availability and requests without repeating your schedule.</p></div></div><div class="action-list"><button class="action-item" onclick="go('clock')"><span class="dot"></span><div><strong>Clock in/out</strong><small>Track actual work and breaks.</small></div><em>Open</em></button><button class="action-item" onclick="go('availability')"><span class="dot"></span><div><strong>Request unavailable</strong><small>Submit date, day, time and reason.</small></div><em>Open</em></button><button class="action-item" onclick="go('myrequests')"><span class="dot"></span><div><strong>My requests</strong><small>Track current approvals.</small></div><em>View</em></button>${nextShift ? `<button class="action-item" onclick="openChangeModal('${nextShift.id}')"><span class="dot"></span><div><strong>Request change</strong><small>For your next shift only.</small></div><em>Ask</em></button>` : ``}</div></div></div>
    <div class="apple-panel employee-single-schedule" id="my-published-schedule"><div class="apple-panel-head"><div><h3>Published schedule</h3><p>Your active and upcoming published shifts in one place. Completed shifts stay in previous shifts history.</p></div><span class="status-pill">${upcomingShifts.length} upcoming</span></div>${activePublished.length ? employeeShiftCardList(activePublished) : `<div class="apple-empty-mini"><strong>No active published shifts</strong><span>Past shifts are moved to history. New shifts will appear after publishing.</span></div>`}${diagnostic}${employeePastShiftHistory(pastPublished)}</div>
  </section>`;
}

/* v79: wider manager insight panels + weekly scheduled/worked comparison */
function v79BusinessShiftsInRange(start, end, publishedOnly=true){
  const b = business();
  if(!b) return [];
  return (state.shifts || []).filter(s => {
    if(s.businessId !== b.id) return false;
    if(publishedOnly && !["published","confirmed"].includes(s.status)) return false;
    const d = safeShiftDateTime(s);
    return d >= start && d < end;
  }).sort(sortShift);
}
function v79WorkedHoursInRange(start, end){
  const b = business();
  if(!b) return 0;
  return (state.timesheets || []).filter(t => {
    if(t.businessId !== b.id) return false;
    const d = t.clockIn ? new Date(t.clockIn) : null;
    return d && !isNaN(d) && d >= start && d < end;
  }).reduce((sum,t)=>sum + Number(t.workedHours || workedHoursFor(t) || 0),0);
}
function v79RangeLabel(start, endExclusive){
  return `${shortDate(start)} – ${shortDate(addDays(endExclusive,-1))}`;
}
function v79PriorityClass(value, limit){
  if(value <= 0) return "quiet";
  if(limit && value > limit) return "warn";
  return "ok";
}
function v79Bar(label, sub, value, max, type="blue"){
  const hrs = Number(value || 0);
  const pct = Math.max(hrs > 0 ? 6 : 0, Math.min(100, (hrs / Math.max(1,max)) * 100));
  return `<div class="v79-bar ${type}">
    <div class="v79-bar-label"><strong>${esc(label)}</strong><span>${esc(sub||"")}</span></div>
    <div class="v79-track"><i style="width:${pct.toFixed(0)}%"></i></div>
    <em>${hrs.toFixed(1)}</em>
  </div>`;
}
function v79RosterInsightPanel(){
  const data = qaV78Rows();
  const max = Math.max(1, ...data.rows.map(r => r.hrs));
  const reviewText = data.review > 0 ? `${data.review.toFixed(1)} hrs review` : "OK";
  return `<section class="v79-panel v79-roster-panel">
    <div class="v79-panel-head">
      <div><span class="eyebrow">Roster insight</span><h3>${esc(data.period.label)}</h3><p>View roster hours by week or month without taking the whole dashboard.</p></div>
      <strong class="v79-total ${data.total > 0 ? "blue" : "quiet"}">${data.total.toFixed(1)} hrs</strong>
    </div>
    <div class="v79-toolbar">
      <div class="v79-segment"><button class="${qaV78InsightState.mode === "week" ? "active" : ""}" onclick="qaV78SetMode('week')">Week</button><button class="${qaV78InsightState.mode === "month" ? "active" : ""}" onclick="qaV78SetMode('month')">Month</button></div>
      <div class="v79-arrows"><button onclick="qaV78Move(-1)" title="Previous period">‹</button><button onclick="qaV78Move(1)" title="Next period">›</button></div>
      <select onchange="qaV78SetSort(this.value)"><option value="date" ${qaV78InsightState.sort === "date" ? "selected" : ""}>Date order</option><option value="high" ${qaV78InsightState.sort === "high" ? "selected" : ""}>High first</option><option value="low" ${qaV78InsightState.sort === "low" ? "selected" : ""}>Low first</option></select>
      <select onchange="qaV78SetFilter(this.value)"><option value="all" ${qaV78InsightState.filter === "all" ? "selected" : ""}>All</option><option value="with-hours" ${qaV78InsightState.filter === "with-hours" ? "selected" : ""}>With hours</option><option value="high" ${qaV78InsightState.filter === "high" ? "selected" : ""}>8+ hrs</option></select>
    </div>
    <div class="v79-bars">${data.rows.length ? data.rows.slice(0,8).map((r,idx)=>v79Bar(r.label, r.sub, r.hrs, max, idx % 3 === 0 ? "blue" : idx % 3 === 1 ? "green" : "orange")).join("") : `<div class="v79-empty">No roster hours in this selected view.</div>`}</div>
    <button class="v79-review ${data.review > 0 ? "warn" : "ok"}" onclick="openPublishReview()">${esc(reviewText)}</button>
  </section>`;
}
function v79WeekComparisonPanel(){
  const currentStart = getMonday(rosterWeekStart || new Date());
  const currentEnd = addDays(currentStart,7);
  const previousStart = addDays(currentStart,-7);
  const previousEnd = currentStart;
  const currentShifts = v79BusinessShiftsInRange(currentStart,currentEnd,true);
  const previousShifts = v79BusinessShiftsInRange(previousStart,previousEnd,true);
  const currentScheduled = totalHours(currentShifts);
  const previousScheduled = totalHours(previousShifts);
  const currentWorked = v79WorkedHoursInRange(currentStart,currentEnd);
  const previousWorked = v79WorkedHoursInRange(previousStart,previousEnd);
  const currentPublished = currentShifts.length > 0;
  const max = Math.max(1,currentScheduled,previousScheduled,currentWorked,previousWorked);
  const gap = currentScheduled - currentWorked;
  return `<section class="v79-panel v79-compare-panel">
    <div class="v79-panel-head">
      <div><span class="eyebrow">Week comparison</span><h3>${currentPublished ? "Current week published" : "Not published yet"}</h3><p>${v79RangeLabel(currentStart,currentEnd)}</p></div>
      <strong class="v79-total ${currentPublished ? "green" : "orange"}">${currentPublished ? "Published" : "Draft"}</strong>
    </div>
    <div class="v79-compare-grid">
      <div class="v79-mini-stat blue"><span>Previous scheduled</span><strong>${previousScheduled.toFixed(1)}</strong><small>${v79RangeLabel(previousStart,previousEnd)}</small></div>
      <div class="v79-mini-stat green"><span>Previous worked</span><strong>${previousWorked.toFixed(1)}</strong><small>Clocked hours</small></div>
      <div class="v79-mini-stat blue"><span>Current scheduled</span><strong>${currentScheduled.toFixed(1)}</strong><small>${currentPublished ? "Published shifts" : "Not published"}</small></div>
      <div class="v79-mini-stat ${gap > 0 ? "orange" : "green"}"><span>Schedule vs worked</span><strong>${Math.abs(gap).toFixed(1)}</strong><small>${gap > 0 ? "hrs still scheduled" : "hrs balanced"}</small></div>
    </div>
    <div class="v79-bars compare">
      ${v79Bar("Prev sched", "Last week", previousScheduled, max, "blue")}
      ${v79Bar("Prev worked", "Clock records", previousWorked, max, "green")}
      ${v79Bar("Curr sched", currentPublished ? "Published" : "Not published", currentScheduled, max, currentPublished ? "blue" : "orange")}
      ${v79Bar("Curr worked", "Clock records", currentWorked, max, "green")}
    </div>
  </section>`;
}
function managerDashboard(){
  const b = business();
  const user = currentUser();
  const employees = state.users.filter(u => u.businessId === b.id && u.role === "employee" && u.status === "active");
  const weekShifts = visibleWeekShifts();
  const pending = state.requests.filter(r => r.businessId === b.id && r.status === "pending");
  const alerts = buildAlerts();
  const publishCheck = buildPublishCheck();
  const notes = state.notifications.filter(n => n.businessId === b.id && n.userId === user.id).slice(-5).reverse();
  const blockers = publishCheck.blockers.length;
  const subtitle = pending.length ? "Review requests before publishing." : blockers ? "Fix required items before publishing." : alerts.length ? "Review suggestions before publishing." : "Roster is ready when you are.";
  return `<section class="qa-dashboard v79-dashboard">
    <div class="v79-top-grid">
      <section class="v79-business-card">
        <div><span class="eyebrow">MySchedule</span><h2>${esc(b?.name || "Manager Dashboard")}</h2><p>${esc(subtitle)}</p></div>
        <div class="v79-business-actions"><button class="primary" onclick="go('roster')">Open roster</button><button class="ghost" onclick="${pending.length ? "go('requests')" : "openPublishReview()"}">${pending.length ? "Review requests" : "Publish check"}</button></div>
      </section>
      ${qaV78ActionSquare(employees.length, totalHours(weekShifts), pending.length, blockers, alerts.length)}
    </div>
    <div class="v79-insight-row">
      ${v79RosterInsightPanel()}
      ${v79WeekComparisonPanel()}
    </div>
    <div class="dashboard-two-col qa-two-col v78-lower-panels">
      <div class="apple-panel qa-panel"><div class="apple-panel-head"><div><h3>Next best actions</h3><p>Only items that help you decide what to do now.</p></div></div>${qaActionList(pending, publishCheck, alerts)}</div>
      <div class="apple-panel qa-panel"><div class="apple-panel-head"><div><h3>Inbox</h3><p>Important schedule and request messages.</p></div><button class="tiny" onclick="go('notifications')">Open</button></div>${dashboardNotificationList(notes)}</div>
    </div>
  </section>`;
}

/* v80 QA: fixed month navigation, weekly-limit review math, cleaner insight cards + break compliance */
function qaV78BaseDate(){
  const raw = qaV78InsightState && qaV78InsightState.base ? new Date(qaV78InsightState.base + "T00:00:00") : new Date(rosterWeekStart || new Date());
  return isNaN(raw) ? new Date() : raw;
}
function qaV78Period(){
  const baseRaw = qaV78BaseDate();
  if(qaV78InsightState.mode === "month"){
    const start = new Date(baseRaw.getFullYear(), baseRaw.getMonth(), 1);
    const end = new Date(start.getFullYear(), start.getMonth()+1, 1);
    return {base:start, start, end, label:start.toLocaleDateString(undefined,{month:"long", year:"numeric"})};
  }
  const base = getMonday(baseRaw);
  return {base, start:base, end:addDays(base,7), label:`${shortDate(base)} – ${shortDate(addDays(base,6))}`};
}
function qaV78Move(delta){
  const period = qaV78Period();
  let next;
  if(qaV78InsightState.mode === "month") next = new Date(period.start.getFullYear(), period.start.getMonth() + delta, 1);
  else next = addDays(period.start, delta * 7);
  qaV78InsightState.base = isoDate(next);
  renderContent();
}
function v80ReviewHoursForPeriod(start,end){
  const b = business();
  if(!b) return 0;
  let review = 0;
  let cursor = getMonday(start);
  while(cursor < end){
    const wkStart = new Date(cursor);
    const wkEnd = addDays(wkStart,7);
    const rangeStart = wkStart < start ? start : wkStart;
    const rangeEnd = wkEnd > end ? end : wkEnd;
    const weekShifts = qaBusinessShiftsInRange(rangeStart, rangeEnd, true);
    review += qaEmployeeLimitWaste(weekShifts);
    cursor = wkEnd;
    if(review > 100000) break;
  }
  return review;
}
function qaV78Rows(){
  const period = qaV78Period();
  const b = business();
  if(!b) return {period,rows:[],total:0,review:0};
  const all = (state.shifts || []).filter(s => s.businessId === b.id && ["published","confirmed"].includes(s.status));
  let rows = [];
  if(qaV78InsightState.mode === "month"){
    let cursor = new Date(period.start);
    let i = 1;
    while(cursor < period.end && i <= 6){
      const wkStart = new Date(cursor);
      const wkEnd = addDays(wkStart,7) > period.end ? period.end : addDays(wkStart,7);
      const hrs = totalHours(all.filter(s => safeShiftDateTime(s) >= wkStart && safeShiftDateTime(s) < wkEnd));
      rows.push({label:`Week ${i}`, sub:v79RangeLabel(wkStart,wkEnd), hrs, order:i});
      cursor = wkEnd; i++;
    }
  }else{
    for(let i=0;i<7;i++){
      const d = addDays(period.start,i);
      const hrs = totalHours(all.filter(s => s.date === isoDate(d)));
      rows.push({label:d.toLocaleDateString(undefined,{weekday:"short"}), sub:d.toLocaleDateString(undefined,{month:"short",day:"numeric"}), hrs, order:i});
    }
  }
  const total = rows.reduce((sum,r)=>sum+r.hrs,0);
  const review = v80ReviewHoursForPeriod(period.start, period.end);
  if(qaV78InsightState.filter === "with-hours") rows = rows.filter(r => r.hrs > 0);
  if(qaV78InsightState.filter === "high") rows = rows.filter(r => r.hrs >= 8);
  if(qaV78InsightState.sort === "high") rows.sort((a,b)=>b.hrs-a.hrs);
  else if(qaV78InsightState.sort === "low") rows.sort((a,b)=>a.hrs-b.hrs);
  else rows.sort((a,b)=>a.order-b.order);
  return {period,rows,total,review};
}
function v80BreakStatsForRange(start,end){
  const b = business();
  const records = (state.timesheets || []).filter(t => {
    if(!b || t.businessId !== b.id || !t.clockIn) return false;
    const d = new Date(t.clockIn);
    return !isNaN(d) && d >= start && d < end;
  });
  let breakMins = 0, missingBreaks = 0, openBreaks = 0, longBreaks = 0;
  records.forEach(t => {
    const mins = breakMinutesFor(t);
    breakMins += mins;
    const worked = Number(t.workedHours || workedHoursFor(t) || 0);
    if(worked >= 5 && mins <= 0) missingBreaks++;
    if(activeBreak(t)) openBreaks++;
    if(Array.isArray(t.breaks) && t.breaks.some(b => {
      if(!b.start) return false;
      const endTime = b.end ? new Date(b.end) : new Date();
      return Math.round((endTime - new Date(b.start))/60000) > 45;
    })) longBreaks++;
  });
  return {records:records.length, breakMins, missingBreaks, openBreaks, longBreaks, issues:missingBreaks+openBreaks+longBreaks};
}
function v80StatusPill(label, kind="blue"){
  return `<strong class="v79-total ${esc(kind)}">${esc(label)}</strong>`;
}
function v79RosterInsightPanel(){
  const data = qaV78Rows();
  const max = Math.max(1, ...data.rows.map(r => r.hrs));
  const reviewLabel = data.review > 0 ? `${data.review.toFixed(1)} hrs over limit` : "Within limits";
  return `<section class="v79-panel v79-roster-panel v80-clean-panel">
    <div class="v79-panel-head">
      <div><span class="eyebrow">Roster insight</span><h3>${esc(data.period.label)}</h3><p>Hours by selected period. Use filters only when needed.</p></div>
      ${v80StatusPill(data.total.toFixed(1)+" hrs", data.total > 0 ? "blue" : "quiet")}
    </div>
    <div class="v79-toolbar v80-toolbar">
      <div class="v79-segment"><button class="${qaV78InsightState.mode === "week" ? "active" : ""}" onclick="qaV78SetMode('week')">Week</button><button class="${qaV78InsightState.mode === "month" ? "active" : ""}" onclick="qaV78SetMode('month')">Month</button></div>
      <div class="v79-arrows"><button onclick="qaV78Move(-1)" title="Previous period">‹</button><button onclick="qaV78Move(1)" title="Next period">›</button></div>
      <select onchange="qaV78SetSort(this.value)"><option value="date" ${qaV78InsightState.sort === "date" ? "selected" : ""}>Date order</option><option value="high" ${qaV78InsightState.sort === "high" ? "selected" : ""}>High first</option><option value="low" ${qaV78InsightState.sort === "low" ? "selected" : ""}>Low first</option></select>
      <select onchange="qaV78SetFilter(this.value)"><option value="all" ${qaV78InsightState.filter === "all" ? "selected" : ""}>All</option><option value="with-hours" ${qaV78InsightState.filter === "with-hours" ? "selected" : ""}>With hours</option><option value="high" ${qaV78InsightState.filter === "high" ? "selected" : ""}>8+ hrs</option></select>
    </div>
    <div class="v79-bars">${data.rows.length ? data.rows.slice(0,8).map((r,idx)=>v79Bar(r.label, r.sub, r.hrs, max, idx % 3 === 0 ? "blue" : idx % 3 === 1 ? "green" : "orange")).join("") : `<div class="v79-empty">No roster hours in this selected view.</div>`}</div>
    <div class="v80-footline ${data.review > 0 ? "warn" : "ok"}" onclick="openPublishReview()"><span>${esc(reviewLabel)}</span><em>${data.review > 0 ? "Review" : "OK"}</em></div>
  </section>`;
}
function v79WeekComparisonPanel(){
  const currentStart = getMonday(rosterWeekStart || new Date());
  const currentEnd = addDays(currentStart,7);
  const previousStart = addDays(currentStart,-7);
  const previousEnd = currentStart;
  const currentShifts = v79BusinessShiftsInRange(currentStart,currentEnd,true);
  const previousShifts = v79BusinessShiftsInRange(previousStart,previousEnd,true);
  const currentScheduled = totalHours(currentShifts);
  const previousScheduled = totalHours(previousShifts);
  const currentWorked = v79WorkedHoursInRange(currentStart,currentEnd);
  const previousWorked = v79WorkedHoursInRange(previousStart,previousEnd);
  const currentPublished = currentShifts.length > 0;
  const breaks = v80BreakStatsForRange(currentStart,currentEnd);
  const max = Math.max(1,currentScheduled,previousScheduled,currentWorked,previousWorked,breaks.breakMins/60);
  return `<section class="v79-panel v79-compare-panel v80-clean-panel">
    <div class="v79-panel-head">
      <div><span class="eyebrow">Week health</span><h3>${currentPublished ? "Current week published" : "Not published yet"}</h3><p>${v79RangeLabel(currentStart,currentEnd)}</p></div>
      ${v80StatusPill(currentPublished ? "Published" : "Draft", currentPublished ? "green" : "orange")}
    </div>
    <div class="v80-keyline">
      <div><span>Previous</span><strong>${previousScheduled.toFixed(1)} sched / ${previousWorked.toFixed(1)} worked</strong></div>
      <div class="${breaks.issues ? "warn" : "ok"}"><span>Breaks</span><strong>${breaks.issues ? `${breaks.issues} issue${breaks.issues===1?"":"s"}` : `${breaks.breakMins} mins`}</strong></div>
    </div>
    <div class="v79-bars compare">
      ${v79Bar("Prev scheduled", v79RangeLabel(previousStart,previousEnd), previousScheduled, max, "blue")}
      ${v79Bar("Prev worked", "Clock records", previousWorked, max, "green")}
      ${v79Bar("Current scheduled", currentPublished ? "Published" : "Not published", currentScheduled, max, currentPublished ? "blue" : "orange")}
      ${v79Bar("Current worked", "Clock records", currentWorked, max, "green")}
      ${v79Bar("Break time", `${breaks.missingBreaks} missing · ${breaks.longBreaks} long`, breaks.breakMins/60, max, breaks.issues ? "orange" : "green")}
    </div>
  </section>`;
}

/* v82: employee dashboard split layout - quick actions left, published schedule right */
function employeeWorkView(){
  ensureOperationsData();
  const user = currentUser();
  if(!user) return `<div class="panel"><h2>My Shifts</h2><p class="muted">Please sign in again to view your published shifts.</p></div>`;
  let publishedAll = [];
  try{ publishedAll = employeeVisibleShifts(user).sort(sortShift); }catch(e){ console.warn(e); publishedAll = []; }
  const nowTime = new Date();
  const activePublished = publishedAll.filter(s => !isShiftGone(s, nowTime)).sort(sortShift);
  const pastPublished = publishedAll.filter(s => isShiftGone(s, nowTime)).sort(sortShift).reverse();
  const weekEnd = addDays(rosterWeekStart,7);
  const weekShifts = activePublished.filter(s => inDateRange(s, rosterWeekStart, weekEnd)).sort(sortShift);
  const week = totalHours(weekShifts);
  const upcomingShifts = activePublished.filter(s => safeShiftDateTime(s) >= nowTime).sort(sortShift);
  const nextShift = upcomingShifts[0];
  const employeeIds = employeeIdentityIds(user);
  const pendingMine = state.requests.filter(r => employeeIds.includes(r.employeeId) && r.status === "pending").length;
  const activeClock = currentOpenTimesheet(user.id);
  const focusTitle = nextShift ? friendlyDate(nextShift.date) : "No upcoming published shift";
  const focusSub = nextShift ? `${esc(nextShift.start)} – ${esc(nextShift.end)} · ${shiftHours(nextShift).toFixed(1)} hrs` : "New shifts will appear after your manager publishes the roster.";
  const diagnostic = (!activePublished.length && !pastPublished.length) ? employeePublishedShiftDebugSummary(user) : "";
  return `<section class="employee-apple-dashboard qa-employee-page v74-employee-dashboard v82-employee-page">
    <div class="v74-executive-card employee v82-employee-hero">
      <div class="v74-exec-left"><span class="eyebrow">MySchedule</span><h2>My Shifts</h2><p>Your active roster, clock, requests, and notices in one calm view.</p><div class="v74-hero-actions"><button class="primary" onclick="${nextShift ? "document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})" : "go('availability')"}">${nextShift ? "View schedule" : "Set availability"}</button><button class="ghost" onclick="go('clock')">Clock</button></div></div>
      <div class="v74-combined-square all-clear">
        <div class="v74-square-status"><span>→</span><strong>${esc(focusTitle)}</strong></div>
        <small class="v74-square-sub">${focusSub}</small>
        <div class="v74-square-grid">
          ${qaMiniMetric(week.toFixed(1),"This week","blue","document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})")}
          ${qaMiniMetric(upcomingShifts.length,"Upcoming",upcomingShifts.length?"blue":"neutral","document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})")}
          ${qaMiniMetric(pendingMine || "0","Requests",pendingMine?"orange":"green","go('myrequests')")}
          ${qaMiniMetric(activeClock ? "On" : "Clock","Clock",activeClock?"orange":"green","go('clock')")}
        </div>
      </div>
    </div>

    <div class="v82-employee-main-grid">
      <div class="apple-panel qa-panel v82-quick-panel">
        <div class="apple-panel-head"><div><h3>Quick actions</h3><p>Clock, availability and requests without repeating your schedule.</p></div></div>
        <div class="action-list">
          <button class="action-item" onclick="go('clock')"><span class="dot"></span><div><strong>Clock in/out</strong><small>Track actual work and breaks.</small></div><em>Open</em></button>
          <button class="action-item" onclick="go('availability')"><span class="dot"></span><div><strong>Request unavailable</strong><small>Submit date, day, time and reason.</small></div><em>Open</em></button>
          <button class="action-item" onclick="go('myrequests')"><span class="dot"></span><div><strong>My requests</strong><small>Track current approvals.</small></div><em>View</em></button>
          ${nextShift ? `<button class="action-item" onclick="openChangeModal('${nextShift.id}')"><span class="dot"></span><div><strong>Request change</strong><small>For your next shift only.</small></div><em>Ask</em></button>` : ``}
        </div>
      </div>

      <div class="apple-panel employee-single-schedule v82-schedule-panel" id="my-published-schedule">
        <div class="apple-panel-head"><div><h3>Published schedule</h3><p>Your active and upcoming published shifts in one place. Completed shifts stay in previous shifts history.</p></div><span class="status-pill">${upcomingShifts.length} upcoming</span></div>
        ${activePublished.length ? employeeShiftCardList(activePublished) : `<div class="apple-empty-mini"><strong>No active published shifts</strong><span>Past shifts are moved to history. New shifts will appear after publishing.</span></div>`}
        ${diagnostic}
        ${employeePastShiftHistory(pastPublished)}
      </div>
    </div>
  </section>`;
}

/* v87: actionable roster/break insights, safer month navigation, compact review status */
function v87LocalIso(d){
  const x = new Date(d);
  if(isNaN(x)) return "";
  const y = x.getFullYear();
  const m = String(x.getMonth()+1).padStart(2,"0");
  const day = String(x.getDate()).padStart(2,"0");
  return `${y}-${m}-${day}`;
}
function qaV78Move(delta){
  const period = qaV78Period();
  let next;
  if(qaV78InsightState.mode === "month") next = new Date(period.start.getFullYear(), period.start.getMonth() + Number(delta||0), 1, 12, 0, 0);
  else next = addDays(period.start, Number(delta||0) * 7);
  qaV78InsightState.base = v87LocalIso(next);
  renderContent();
}
function v87PeriodShifts(start,end){
  const b = business();
  const rows = (state.shifts || []).filter(s => {
    if(!b || s.businessId !== b.id) return false;
    const d = safeShiftDateTime(s);
    return !isNaN(d) && d >= start && d < end;
  });
  const published = rows.filter(s => ["published","confirmed"].includes(s.status));
  const draft = rows.filter(s => !["published","confirmed"].includes(s.status));
  return {all:rows, published, draft, draftHours:totalHours(draft), publishedHours:totalHours(published)};
}
function v87RosterReviewState(data){
  const flags = v87PeriodShifts(data.period.start, data.period.end);
  if(flags.draft.length && !flags.published.length){
    return {label:`${flags.draftHours.toFixed(1)} draft hrs`, tone:"draft", action:"Publish/check roster", detail:"Draft roster is not a final within-limit result yet."};
  }
  if(flags.draft.length && flags.published.length){
    return {label:`${flags.draftHours.toFixed(1)} draft hrs`, tone:"draft", action:"Drafts pending", detail:"Some shifts in this period are not published yet."};
  }
  if(data.review > 0){
    return {label:`${data.review.toFixed(1)} hrs over limit`, tone:"warn", action:"Review", detail:"Published/confirmed shifts are above selected employee weekly limits."};
  }
  if(flags.published.length){
    return {label:"OK", tone:"ok", action:"Within limits", detail:"Published/confirmed shifts are within selected employee weekly limits."};
  }
  return {label:"No published hours", tone:"quiet", action:"No roster", detail:"There are no published shifts in this selected period."};
}
function v87BreakStatsDetailed(start,end){
  const b = business();
  const records = (state.timesheets || []).filter(t => {
    if(!b || t.businessId !== b.id || !t.clockIn) return false;
    const d = new Date(t.clockIn);
    return !isNaN(d) && d >= start && d < end;
  });
  const issues = [];
  let breakMins = 0, missingBreaks = 0, openBreaks = 0, longBreaks = 0, missingClockIns = 0;
  records.forEach(t => {
    const mins = breakMinutesFor(t);
    breakMins += mins;
    const worked = Number(t.workedHours || workedHoursFor(t) || 0);
    const emp = userName(t.employeeId);
    const date = t.clockIn ? shortDate(new Date(t.clockIn)) : "";
    if(worked >= 5 && mins <= 0){
      missingBreaks++;
      issues.push({type:"Missing break", employee:emp, date, detail:`Worked ${worked.toFixed(1)} hrs with no break recorded.`, action:"Check with employee or edit timesheet before approval."});
    }
    if(activeBreak(t)){
      openBreaks++;
      issues.push({type:"Open break", employee:emp, date, detail:"Employee is still marked as being on break.", action:"Ask employee to end break or correct the record."});
    }
    if(Array.isArray(t.breaks)){
      t.breaks.forEach(br => {
        if(!br.start) return;
        const endTime = br.end ? new Date(br.end) : new Date();
        const len = Math.max(0, Math.round((endTime - new Date(br.start))/60000));
        if(len > 45){
          longBreaks++;
          issues.push({type:"Long break", employee:emp, date, detail:`Break recorded for ${len} mins.`, action:"Review whether the break time is correct."});
        }
      });
    }
  });
  const nowTime = new Date();
  const recorded = new Set(records.map(t => `${t.employeeId}|${String(t.clockIn||"").slice(0,10)}`));
  const scheduled = v79BusinessShiftsInRange(start,end,true).filter(s => safeShiftDateTime(s) < nowTime);
  scheduled.forEach(s => {
    const key = `${s.employeeId}|${s.date}`;
    if(!recorded.has(key)){
      missingClockIns++;
      issues.push({type:"Missing punch-in", employee:userName(s.employeeId), date:shortDate(dateObj(s.date)), detail:`Scheduled ${s.start} – ${s.end}, but no clock record was found.`, action:"Confirm attendance or update the timesheet."});
    }
  });
  return {records:records.length, breakMins, missingBreaks, openBreaks, longBreaks, missingClockIns, issuesCount:issues.length, issues};
}
function openBreakIssuesModal(){
  const currentStart = getMonday(rosterWeekStart || new Date());
  const currentEnd = addDays(currentStart,7);
  const data = v87BreakStatsDetailed(currentStart,currentEnd);
  const rows = data.issues.length ? data.issues.map(item => `<div class="v87-issue-row">
    <div><strong>${esc(item.type)}</strong><span>${esc(item.employee)} · ${esc(item.date)}</span></div>
    <p>${esc(item.detail)}</p>
    <em>${esc(item.action)}</em>
  </div>`).join("") : `<div class="apple-empty-mini"><strong>No break or punch-in issues</strong><span>This week has no missing breaks, long breaks, open breaks, or missing punch-ins.</span></div>`;
  modal(`<h2>Break & punch-in issues</h2><p class="muted">${esc(v79RangeLabel(currentStart,currentEnd))}</p>
    <div class="v87-issue-summary"><span>${data.breakMins} mins break</span><span>${data.missingBreaks} missing breaks</span><span>${data.longBreaks} long</span><span>${data.openBreaks} open</span><span>${data.missingClockIns} punch-in</span></div>
    <div class="v87-issue-list">${rows}</div>
    <div class="actions" style="margin-top:14px"><button class="primary" onclick="closeModal(); go('timesheets')">Open timesheets</button><button onclick="closeModal()">Close</button></div>`);
}
function v87ReviewFootline(state){
  const clickable = state.tone === "warn" || state.tone === "draft";
  return `<button class="v87-review-chip ${esc(state.tone)}" ${clickable ? `onclick="openPublishReview()"` : ""} title="${esc(state.detail)}"><strong>${esc(state.label)}</strong><span>${esc(state.action)}</span></button>`;
}
function v79RosterInsightPanel(){
  const data = qaV78Rows();
  const max = Math.max(1, ...data.rows.map(r => r.hrs));
  const stateMsg = v87RosterReviewState(data);
  return `<section class="v79-panel v79-roster-panel v80-clean-panel v87-roster-panel">
    <div class="v79-panel-head v87-panel-head">
      <div><span class="eyebrow">Roster insight</span><h3>${esc(data.period.label)}</h3></div>
      <div class="v87-head-actions">${v80StatusPill(data.total.toFixed(1)+" hrs", data.total > 0 ? "blue" : "quiet")}${v87ReviewFootline(stateMsg)}</div>
    </div>
    <div class="v79-toolbar v80-toolbar v87-toolbar">
      <div class="v79-segment"><button class="${qaV78InsightState.mode === "week" ? "active" : ""}" onclick="qaV78SetMode('week')">Week</button><button class="${qaV78InsightState.mode === "month" ? "active" : ""}" onclick="qaV78SetMode('month')">Month</button></div>
      <div class="v79-arrows"><button onclick="qaV78Move(-1)" title="Previous period">‹</button><button onclick="qaV78Move(1)" title="Next period">›</button></div>
      <select onchange="qaV78SetSort(this.value)"><option value="date" ${qaV78InsightState.sort === "date" ? "selected" : ""}>Date order</option><option value="high" ${qaV78InsightState.sort === "high" ? "selected" : ""}>High first</option><option value="low" ${qaV78InsightState.sort === "low" ? "selected" : ""}>Low first</option></select>
      <select onchange="qaV78SetFilter(this.value)"><option value="all" ${qaV78InsightState.filter === "all" ? "selected" : ""}>All</option><option value="with-hours" ${qaV78InsightState.filter === "with-hours" ? "selected" : ""}>With hours</option><option value="high" ${qaV78InsightState.filter === "high" ? "selected" : ""}>8+ hrs</option></select>
    </div>
    <div class="v79-bars v87-bars">${data.rows.length ? data.rows.slice(0,8).map((r,idx)=>v79Bar(r.label, r.sub, r.hrs, max, idx % 3 === 0 ? "blue" : idx % 3 === 1 ? "green" : "orange")).join("") : `<div class="v79-empty">No roster hours in this selected view.</div>`}</div>
  </section>`;
}
function v79WeekComparisonPanel(){
  const currentStart = getMonday(rosterWeekStart || new Date());
  const currentEnd = addDays(currentStart,7);
  const previousStart = addDays(currentStart,-7);
  const previousEnd = currentStart;
  const currentShifts = v79BusinessShiftsInRange(currentStart,currentEnd,true);
  const previousShifts = v79BusinessShiftsInRange(previousStart,previousEnd,true);
  const currentScheduled = totalHours(currentShifts);
  const previousScheduled = totalHours(previousShifts);
  const currentWorked = v79WorkedHoursInRange(currentStart,currentEnd);
  const previousWorked = v79WorkedHoursInRange(previousStart,previousEnd);
  const currentPublished = currentShifts.length > 0;
  const breaks = v87BreakStatsDetailed(currentStart,currentEnd);
  const max = Math.max(1,currentScheduled,previousScheduled,currentWorked,previousWorked,breaks.breakMins/60, breaks.missingBreaks, breaks.longBreaks, breaks.openBreaks, breaks.missingClockIns);
  const issueLabel = breaks.issuesCount ? `${breaks.issuesCount} issue${breaks.issuesCount===1?"":"s"}` : `${breaks.breakMins} mins break`;
  return `<section class="v79-panel v79-compare-panel v80-clean-panel v87-health-panel">
    <div class="v79-panel-head v87-panel-head">
      <div><span class="eyebrow">Week health</span><h3>${currentPublished ? "Current week published" : "Not published yet"}</h3><p>${v79RangeLabel(currentStart,currentEnd)}</p></div>
      ${v80StatusPill(currentPublished ? "Published" : "Draft", currentPublished ? "green" : "orange")}
    </div>
    <div class="v87-health-summary">
      <button onclick="go('roster')"><span>Previous week</span><strong>${previousScheduled.toFixed(1)} sched / ${previousWorked.toFixed(1)} worked</strong></button>
      <button onclick="go('roster')"><span>Current week</span><strong>${currentScheduled.toFixed(1)} sched / ${currentWorked.toFixed(1)} worked</strong></button>
      <button class="${breaks.issuesCount ? "warn" : "ok"}" onclick="openBreakIssuesModal()"><span>Break & punch-in</span><strong>${esc(issueLabel)}</strong></button>
    </div>
    <div class="v79-bars compare v87-bars">
      ${v79Bar("Prev scheduled", v79RangeLabel(previousStart,previousEnd), previousScheduled, max, "blue")}
      ${v79Bar("Prev worked", "Clock records", previousWorked, max, "green")}
      ${v79Bar("Current scheduled", currentPublished ? "Published" : "Not published", currentScheduled, max, currentPublished ? "blue" : "orange")}
      ${v79Bar("Current worked", "Clock records", currentWorked, max, "green")}
      ${v79Bar("Break mins", breaks.issuesCount ? "Click summary above for details" : "Recorded break time", breaks.breakMins/60, max, breaks.issuesCount ? "orange" : "green")}
      ${breaks.issuesCount ? v79Bar("Break issues", `${breaks.missingBreaks} missing · ${breaks.longBreaks} long · ${breaks.missingClockIns} punch-in`, breaks.issuesCount, max, "orange") : ""}
    </div>
  </section>`;
}

/* v88: break filters, approved-record cleanup, employee header refinement */
function v88TimesheetNeedsBreakReview(t){
  const status = String(t?.status || (t?.clockOut ? "pending" : "open")).toLowerCase();
  return status !== "approved";
}
function v87BreakStatsDetailed(start,end){
  const b = business();
  const allRecords = (state.timesheets || []).filter(t => {
    if(!b || t.businessId !== b.id || !t.clockIn) return false;
    const d = new Date(t.clockIn);
    return !isNaN(d) && d >= start && d < end;
  });
  const reviewRecords = allRecords.filter(v88TimesheetNeedsBreakReview);
  const issues = [];
  const breakRows = [];
  let breakMins = 0, missingBreaks = 0, openBreaks = 0, longBreaks = 0, missingClockIns = 0;
  reviewRecords.forEach(t => {
    const mins = breakMinutesFor(t);
    breakMins += mins;
    const worked = Number(t.workedHours || workedHoursFor(t) || 0);
    const emp = userName(t.employeeId);
    const date = t.clockIn ? shortDate(new Date(t.clockIn)) : "";
    if(mins > 0){
      breakRows.push({category:"break", type:"Break recorded", employee:emp, date, detail:`${mins} mins break recorded during ${worked.toFixed(1)} worked hrs.`, action:"Open timesheets if the break duration needs adjustment."});
    }
    if(worked >= 5 && mins <= 0){
      missingBreaks++;
      issues.push({category:"missing", type:"Missing break", employee:emp, date, detail:`Worked ${worked.toFixed(1)} hrs with no break recorded.`, action:"Check with employee or edit the timesheet before approval."});
    }
    if(activeBreak(t)){
      openBreaks++;
      issues.push({category:"open", type:"Open break", employee:emp, date, detail:"Employee is still marked as being on break.", action:"Ask employee to end the break or correct the record."});
    }
    if(Array.isArray(t.breaks)){
      t.breaks.forEach(br => {
        if(!br.start) return;
        const endTime = br.end ? new Date(br.end) : new Date();
        const len = Math.max(0, Math.round((endTime - new Date(br.start))/60000));
        if(len > 45){
          longBreaks++;
          issues.push({category:"long", type:"Long break", employee:emp, date, detail:`Break recorded for ${len} mins.`, action:"Review whether the break time is correct before approval."});
        }
      });
    }
  });
  const nowTime = new Date();
  const recorded = new Set(allRecords.map(t => `${t.employeeId}|${String(t.clockIn||"").slice(0,10)}`));
  const scheduled = v79BusinessShiftsInRange(start,end,true).filter(s => safeShiftDateTime(s) < nowTime);
  scheduled.forEach(s => {
    const key = `${s.employeeId}|${s.date}`;
    if(!recorded.has(key)){
      missingClockIns++;
      issues.push({category:"punch", type:"Missing punch-in", employee:userName(s.employeeId), date:shortDate(dateObj(s.date)), detail:`Scheduled ${s.start} – ${s.end}, but no clock record was found.`, action:"Confirm attendance or update the timesheet."});
    }
  });
  return {records:reviewRecords.length, breakMins, missingBreaks, openBreaks, longBreaks, missingClockIns, issuesCount:issues.length, issues, breakRows, approvedHidden:allRecords.length-reviewRecords.length};
}
function v88BreakFilterLabel(filter){
  return ({all:"All issues", break:"Break time", missing:"Missing breaks", long:"Long breaks", open:"Open breaks", punch:"Punch-in"})[filter] || "All issues";
}
function v88IssueFilterButton(filter,label,count,active,tone="neutral"){
  return `<button type="button" class="v88-filter-chip ${active===filter?"active":""} ${tone}" onclick="openBreakIssuesModal('${escAttr(filter)}')"><strong>${esc(label)}</strong><span>${esc(count)}</span></button>`;
}
function openBreakIssuesModal(filter="all"){
  const currentStart = getMonday(rosterWeekStart || new Date());
  const currentEnd = addDays(currentStart,7);
  const data = v87BreakStatsDetailed(currentStart,currentEnd);
  const pool = filter === "break" ? data.breakRows : data.issues.filter(item => filter === "all" || item.category === filter);
  const rows = pool.length ? pool.map(item => `<div class="v87-issue-row v88-issue-row ${esc(item.category || "")}">
    <div><strong>${esc(item.type)}</strong><span>${esc(item.employee)} · ${esc(item.date)}</span></div>
    <p>${esc(item.detail)}</p>
    <em>${esc(item.action)}</em>
  </div>`).join("") : `<div class="apple-empty-mini"><strong>No ${esc(v88BreakFilterLabel(filter).toLowerCase())}</strong><span>Approved records are hidden from this review panel. Only open, pending, or missing items appear here.</span></div>`;
  modal(`<h2>Break & punch-in issues</h2><p class="muted">${esc(v79RangeLabel(currentStart,currentEnd))}</p>
    <div class="v88-filter-row">
      ${v88IssueFilterButton("break", "Break time", `${data.breakMins} mins`, filter, "blue")}
      ${v88IssueFilterButton("missing", "Missing", `${data.missingBreaks}`, filter, data.missingBreaks ? "orange" : "green")}
      ${v88IssueFilterButton("long", "Long", `${data.longBreaks}`, filter, data.longBreaks ? "orange" : "green")}
      ${v88IssueFilterButton("open", "Open", `${data.openBreaks}`, filter, data.openBreaks ? "orange" : "green")}
      ${v88IssueFilterButton("punch", "Punch-in", `${data.missingClockIns}`, filter, data.missingClockIns ? "orange" : "green")}
    </div>
    <div class="v88-filter-context"><strong>${esc(v88BreakFilterLabel(filter))}</strong><span>${data.approvedHidden ? `${data.approvedHidden} approved record${data.approvedHidden===1?"":"s"} hidden from issue counts.` : "Only unresolved items are included."}</span></div>
    <div class="v87-issue-list">${rows}</div>
    <div class="actions" style="margin-top:14px"><button class="primary" onclick="closeModal(); go('timesheets')">Open timesheets</button><button onclick="closeModal()">Close</button></div>`);
}
function v88BreakIssueButtons(data){
  return `<div class="v88-break-buttons" aria-label="Break and punch-in issue filters">
    <button class="blue" onclick="openBreakIssuesModal('break')"><strong>${data.breakMins}</strong><span>mins break</span></button>
    <button class="${data.missingBreaks?"orange":"green"}" onclick="openBreakIssuesModal('missing')"><strong>${data.missingBreaks}</strong><span>missing</span></button>
    <button class="${data.longBreaks?"orange":"green"}" onclick="openBreakIssuesModal('long')"><strong>${data.longBreaks}</strong><span>long</span></button>
    <button class="${data.openBreaks?"orange":"green"}" onclick="openBreakIssuesModal('open')"><strong>${data.openBreaks}</strong><span>open</span></button>
    <button class="${data.missingClockIns?"orange":"green"}" onclick="openBreakIssuesModal('punch')"><strong>${data.missingClockIns}</strong><span>punch-in</span></button>
  </div>`;
}
function v79WeekComparisonPanel(){
  const currentStart = getMonday(rosterWeekStart || new Date());
  const currentEnd = addDays(currentStart,7);
  const previousStart = addDays(currentStart,-7);
  const previousEnd = currentStart;
  const currentShifts = v79BusinessShiftsInRange(currentStart,currentEnd,true);
  const previousShifts = v79BusinessShiftsInRange(previousStart,previousEnd,true);
  const currentScheduled = totalHours(currentShifts);
  const previousScheduled = totalHours(previousShifts);
  const currentWorked = v79WorkedHoursInRange(currentStart,currentEnd);
  const previousWorked = v79WorkedHoursInRange(previousStart,previousEnd);
  const currentPublished = currentShifts.length > 0;
  const breaks = v87BreakStatsDetailed(currentStart,currentEnd);
  const max = Math.max(1,currentScheduled,previousScheduled,currentWorked,previousWorked,breaks.breakMins/60, breaks.missingBreaks, breaks.longBreaks, breaks.openBreaks, breaks.missingClockIns);
  return `<section class="v79-panel v79-compare-panel v80-clean-panel v87-health-panel v88-health-panel">
    <div class="v79-panel-head v87-panel-head">
      <div><span class="eyebrow">Week health</span><h3>${currentPublished ? "Current week published" : "Not published yet"}</h3><p>${v79RangeLabel(currentStart,currentEnd)}</p></div>
      ${v80StatusPill(currentPublished ? "Published" : "Draft", currentPublished ? "green" : "orange")}
    </div>
    <div class="v87-health-summary v88-health-summary">
      <button onclick="go('roster')"><span>Previous week</span><strong>${previousScheduled.toFixed(1)} sched / ${previousWorked.toFixed(1)} worked</strong></button>
      <button onclick="go('roster')"><span>Current week</span><strong>${currentScheduled.toFixed(1)} sched / ${currentWorked.toFixed(1)} worked</strong></button>
    </div>
    ${v88BreakIssueButtons(breaks)}
    <div class="v79-bars compare v87-bars v88-bars">
      ${v79Bar("Prev scheduled", v79RangeLabel(previousStart,previousEnd), previousScheduled, max, "blue")}
      ${v79Bar("Prev worked", "Clock records", previousWorked, max, "green")}
      ${v79Bar("Current scheduled", currentPublished ? "Published" : "Not published", currentScheduled, max, currentPublished ? "blue" : "orange")}
      ${v79Bar("Current worked", "Clock records", currentWorked, max, "green")}
      ${breaks.issuesCount ? v79Bar("Open issues", `${breaks.missingBreaks} missing · ${breaks.openBreaks} open · ${breaks.missingClockIns} punch-in`, breaks.issuesCount, max, "orange") : v79Bar("Break time", `${breaks.breakMins} mins recorded`, breaks.breakMins/60, max, "green")}
    </div>
  </section>`;
}
function employeeWorkView(){
  ensureOperationsData();
  const user = currentUser();
  if(!user) return `<div class="panel"><h2>My Shifts</h2><p class="muted">Please sign in again to view your published shifts.</p></div>`;
  let publishedAll = [];
  try{ publishedAll = employeeVisibleShifts(user).sort(sortShift); }catch(e){ console.warn(e); publishedAll = []; }
  const nowTime = new Date();
  const activePublished = publishedAll.filter(s => !isShiftGone(s, nowTime)).sort(sortShift);
  const pastPublished = publishedAll.filter(s => isShiftGone(s, nowTime)).sort(sortShift).reverse();
  const weekEnd = addDays(rosterWeekStart,7);
  const weekShifts = activePublished.filter(s => inDateRange(s, rosterWeekStart, weekEnd)).sort(sortShift);
  const week = totalHours(weekShifts);
  const upcomingShifts = activePublished.filter(s => safeShiftDateTime(s) >= nowTime).sort(sortShift);
  const nextShift = upcomingShifts[0];
  const employeeIds = employeeIdentityIds(user);
  const pendingMine = state.requests.filter(r => employeeIds.includes(r.employeeId) && r.status === "pending").length;
  const activeClock = currentOpenTimesheet(user.id);
  const focusTitle = nextShift ? friendlyDate(nextShift.date) : "No upcoming published shift";
  const focusSub = nextShift ? `${esc(nextShift.start)} – ${esc(nextShift.end)} · ${shiftHours(nextShift).toFixed(1)} hrs` : "New shifts will appear after your manager publishes the roster.";
  const diagnostic = (!activePublished.length && !pastPublished.length) ? employeePublishedShiftDebugSummary(user) : "";
  const b = business() || {};
  return `<section class="employee-apple-dashboard qa-employee-page v74-employee-dashboard v82-employee-page v88-employee-page">
    <div class="v74-executive-card employee v82-employee-hero v88-employee-hero">
      <div class="v74-exec-left">
        <span class="eyebrow">MySchedule</span>
        <h2>My Shifts</h2>
        <div class="v88-employee-business"><strong>${esc(b.name || "Workplace")}</strong><span>${esc(user.role || "Employee")}</span></div>
        <div class="v74-hero-actions"><button class="primary" onclick="${nextShift ? "document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})" : "go('availability')"}">${nextShift ? "View schedule" : "Set availability"}</button><button class="ghost" onclick="go('clock')">Clock</button></div>
      </div>
      <div class="v74-combined-square all-clear">
        <div class="v74-square-status"><span>→</span><strong>${esc(focusTitle)}</strong></div>
        <small class="v74-square-sub">${focusSub}</small>
        <div class="v74-square-grid">
          ${qaMiniMetric(week.toFixed(1),"This week","blue","document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})")}
          ${qaMiniMetric(upcomingShifts.length,"Upcoming",upcomingShifts.length?"blue":"neutral","document.getElementById('my-published-schedule')?.scrollIntoView({behavior:'smooth'})")}
          ${qaMiniMetric(pendingMine || "0","Requests",pendingMine?"orange":"green","go('myrequests')")}
          ${qaMiniMetric(activeClock ? "On" : "Clock","Clock",activeClock?"orange":"green","go('clock')")}
        </div>
      </div>
    </div>
    <div class="v82-employee-main-grid v88-employee-main-grid">
      <div class="apple-panel employee-single-schedule v82-schedule-panel" id="my-published-schedule">
        <div class="apple-panel-head"><div><h3>Published schedule</h3><p>Your active and upcoming published shifts in one place. Completed shifts stay in previous shifts history.</p></div><span class="status-pill">${upcomingShifts.length} upcoming</span></div>
        ${activePublished.length ? employeeShiftCardList(activePublished) : `<div class="apple-empty-mini"><strong>No active published shifts</strong><span>Past shifts are moved to history. New shifts will appear after publishing.</span></div>`}
        ${diagnostic}
        ${employeePastShiftHistory(pastPublished)}
      </div>
      <div class="apple-panel qa-panel v82-quick-panel">
        <div class="apple-panel-head"><div><h3>Quick actions</h3><p>Clock, availability and requests.</p></div></div>
        <div class="action-list">
          <button class="action-item" onclick="go('clock')"><span class="dot"></span><div><strong>Clock in/out</strong><small>Track actual work and breaks.</small></div><em>Open</em></button>
          <button class="action-item" onclick="go('availability')"><span class="dot"></span><div><strong>Request unavailable</strong><small>Submit date, day, time and reason.</small></div><em>Open</em></button>
          <button class="action-item" onclick="go('myrequests')"><span class="dot"></span><div><strong>My requests</strong><small>Track current approvals.</small></div><em>View</em></button>
          ${nextShift ? `<button class="action-item" onclick="openChangeModal('${nextShift.id}')"><span class="dot"></span><div><strong>Request change</strong><small>For your next shift only.</small></div><em>Ask</em></button>` : ``}
        </div>
      </div>
    </div>
  </section>`;
}

/* v89: separate break punches and clock in/out punch insights */
function v89ShiftWindowForRecord(t){
  if(!t || !t.clockIn) return null;
  const clockDate = String(t.clockIn).slice(0,10);
  const emp = t.employeeId;
  const shifts = v79BusinessShiftsInRange(new Date(clockDate + 'T00:00:00'), addDays(new Date(clockDate + 'T00:00:00'),1), true)
    .filter(s => String(s.employeeId) === String(emp) && String(s.date) === clockDate)
    .sort(sortShift);
  if(!shifts.length) return null;
  const cin = new Date(t.clockIn).getTime();
  let best = shifts[0];
  let bestDiff = Infinity;
  shifts.forEach(s => {
    const start = safeShiftDateTime(s).getTime();
    const diff = Math.abs(cin - start);
    if(diff < bestDiff){ best = s; bestDiff = diff; }
  });
  return best;
}
function v89MinutesDiff(a,b){
  const da = new Date(a), db = new Date(b);
  if(isNaN(da) || isNaN(db)) return 0;
  return Math.round((da - db) / 60000);
}
function v89ClockOutDateTimeForShift(s){
  const start = safeShiftDateTime(s);
  const end = new Date(`${s.date}T${s.end || '00:00'}`);
  if(!isNaN(end) && end < start) end.setDate(end.getDate()+1);
  return end;
}
function v89TimeStatsDetailed(start,end){
  const b = business();
  const allRecords = (state.timesheets || []).filter(t => {
    if(!b || t.businessId !== b.id || !t.clockIn) return false;
    const d = new Date(t.clockIn);
    return !isNaN(d) && d >= start && d < end;
  });
  const reviewRecords = allRecords.filter(v88TimesheetNeedsBreakReview);
  const breakIssues = [], clockIssues = [], breakRows = [];
  let breakMins = 0, missingBreaks = 0, openBreaks = 0, longBreaks = 0;
  let missingPunchIns = 0, earlyPunches = 0, extendedPunches = 0, noSchedulePunches = 0;
  reviewRecords.forEach(t => {
    const mins = breakMinutesFor(t);
    breakMins += mins;
    const worked = Number(t.workedHours || workedHoursFor(t) || 0);
    const emp = userName(t.employeeId);
    const date = t.clockIn ? shortDate(new Date(t.clockIn)) : '';
    if(mins > 0){
      breakRows.push({category:'break', type:'Break recorded', employee:emp, date, detail:`${mins} mins break recorded during ${worked.toFixed(1)} worked hrs.`, action:'Open timesheets if the break duration needs adjustment.'});
    }
    if(worked >= 5 && mins <= 0){
      missingBreaks++;
      breakIssues.push({category:'missing', type:'Missing break', employee:emp, date, detail:`Worked ${worked.toFixed(1)} hrs with no break recorded.`, action:'Check with employee or edit the timesheet before approval.'});
    }
    if(activeBreak(t)){
      openBreaks++;
      breakIssues.push({category:'open', type:'Open break', employee:emp, date, detail:'Employee is still marked as being on break.', action:'Ask employee to end the break or correct the record.'});
    }
    if(Array.isArray(t.breaks)){
      t.breaks.forEach(br => {
        if(!br.start) return;
        const endTime = br.end ? new Date(br.end) : new Date();
        const len = Math.max(0, Math.round((endTime - new Date(br.start))/60000));
        if(len > 45){
          longBreaks++;
          breakIssues.push({category:'long', type:'Long break', employee:emp, date, detail:`Break recorded for ${len} mins.`, action:'Review whether the break time is correct before approval.'});
        }
      });
    }
    const matchedShift = v89ShiftWindowForRecord(t);
    if(!matchedShift){
      noSchedulePunches++;
      clockIssues.push({category:'noschedule', type:'Clocked without scheduled shift', employee:emp, date, detail:'A clock record exists but no published shift was found for this employee on that date.', action:'Confirm if this was authorised extra work or add the shift to the roster.'});
    } else {
      const shiftStart = safeShiftDateTime(matchedShift);
      const earlyBy = -v89MinutesDiff(t.clockIn, shiftStart);
      if(earlyBy > 10){
        earlyPunches++;
        clockIssues.push({category:'early', type:'Early clock-in', employee:emp, date, detail:`Clocked in ${earlyBy} mins before scheduled start (${matchedShift.start}).`, action:'Check if early start was approved or adjust timesheet.'});
      }
      if(t.clockOut){
        const shiftEnd = v89ClockOutDateTimeForShift(matchedShift);
        const overBy = v89MinutesDiff(t.clockOut, shiftEnd);
        if(overBy > 15){
          extendedPunches++;
          clockIssues.push({category:'extended', type:'Extended clock-out', employee:emp, date, detail:`Clocked out ${overBy} mins after scheduled end (${matchedShift.end}).`, action:'Review whether the extra time should be approved.'});
        }
      }
    }
  });
  const nowTime = new Date();
  const recorded = new Set(allRecords.map(t => `${t.employeeId}|${String(t.clockIn||'').slice(0,10)}`));
  v79BusinessShiftsInRange(start,end,true).filter(s => safeShiftDateTime(s) < nowTime).forEach(s => {
    const key = `${s.employeeId}|${s.date}`;
    if(!recorded.has(key)){
      missingPunchIns++;
      clockIssues.push({category:'missingpunch', type:'Missing punch-in', employee:userName(s.employeeId), date:shortDate(dateObj(s.date)), detail:`Scheduled ${s.start} – ${s.end}, but no clock record was found.`, action:'Confirm attendance or update the timesheet.'});
    }
  });
  const breakIssuesCount = missingBreaks + openBreaks + longBreaks;
  const clockIssuesCount = missingPunchIns + earlyPunches + extendedPunches + noSchedulePunches;
  return {records:reviewRecords.length, breakMins, missingBreaks, openBreaks, longBreaks, breakIssuesCount, breakIssues, breakRows,
    missingPunchIns, earlyPunches, extendedPunches, noSchedulePunches, clockIssuesCount, clockIssues,
    issuesCount: breakIssuesCount + clockIssuesCount, issues: breakIssues.concat(clockIssues), approvedHidden:allRecords.length-reviewRecords.length};
}
function v87BreakStatsDetailed(start,end){
  const data = v89TimeStatsDetailed(start,end);
  return {records:data.records, breakMins:data.breakMins, missingBreaks:data.missingBreaks, openBreaks:data.openBreaks, longBreaks:data.longBreaks, missingClockIns:data.missingPunchIns, issuesCount:data.issuesCount, issues:data.issues, breakRows:data.breakRows, approvedHidden:data.approvedHidden,
    earlyPunches:data.earlyPunches, extendedPunches:data.extendedPunches, noSchedulePunches:data.noSchedulePunches, breakIssuesCount:data.breakIssuesCount, clockIssuesCount:data.clockIssuesCount, breakIssues:data.breakIssues, clockIssues:data.clockIssues};
}
function v89GroupLabel(group){ return group === 'clock' ? 'Clock in/out punches' : 'Break punches'; }
function v89IssueLabel(filter){
  return ({break:'Break time', missing:'Missing breaks', long:'Long breaks', open:'Open breaks', missingpunch:'Missing punch-in', early:'Early clock-in', extended:'Extended clock-out', noschedule:'Without scheduled shift', allbreak:'Break punches', allclock:'Clock in/out punches'})[filter] || 'Issues';
}
function openBreakIssuesModal(filter='allbreak'){
  const currentStart = getMonday(rosterWeekStart || new Date());
  const currentEnd = addDays(currentStart,7);
  const data = v89TimeStatsDetailed(currentStart,currentEnd);
  const isClock = ['allclock','missingpunch','early','extended','noschedule'].includes(filter);
  const group = isClock ? 'clock' : 'break';
  let pool;
  if(filter === 'break') pool = data.breakRows;
  else if(filter === 'allbreak') pool = data.breakIssues;
  else if(filter === 'allclock') pool = data.clockIssues;
  else pool = (isClock ? data.clockIssues : data.breakIssues).filter(item => item.category === filter);
  const rows = pool.length ? pool.map(item => `<div class="v87-issue-row v89-issue-row ${esc(item.category || '')}">
    <div><strong>${esc(item.type)}</strong><span>${esc(item.employee)} · ${esc(item.date)}</span></div>
    <p>${esc(item.detail)}</p>
    <em>${esc(item.action)}</em>
  </div>`).join('') : `<div class="apple-empty-mini"><strong>No ${esc(v89IssueLabel(filter).toLowerCase())}</strong><span>Approved records are hidden. Only unresolved records and missing punches appear here.</span></div>`;
  const filterRow = group === 'clock' ? `<div class="v88-filter-row v89-filter-row">
      ${v88IssueFilterButton('missingpunch','Missing',data.missingPunchIns,filter,data.missingPunchIns?'orange':'green')}
      ${v88IssueFilterButton('early','Early',data.earlyPunches,filter,data.earlyPunches?'orange':'green')}
      ${v88IssueFilterButton('extended','Extended',data.extendedPunches,filter,data.extendedPunches?'orange':'green')}
      ${v88IssueFilterButton('noschedule','No schedule',data.noSchedulePunches,filter,data.noSchedulePunches?'orange':'green')}
    </div>` : `<div class="v88-filter-row v89-filter-row">
      ${v88IssueFilterButton('break','Break time',`${data.breakMins} mins`,filter,'blue')}
      ${v88IssueFilterButton('missing','Missing',data.missingBreaks,filter,data.missingBreaks?'orange':'green')}
      ${v88IssueFilterButton('long','Long',data.longBreaks,filter,data.longBreaks?'orange':'green')}
      ${v88IssueFilterButton('open','Open',data.openBreaks,filter,data.openBreaks?'orange':'green')}
    </div>`;
  modal(`<h2>${esc(v89GroupLabel(group))}</h2><p class="muted">${esc(v79RangeLabel(currentStart,currentEnd))}</p>
    ${filterRow}
    <div class="v88-filter-context"><strong>${esc(v89IssueLabel(filter))}</strong><span>${data.approvedHidden ? `${data.approvedHidden} approved record${data.approvedHidden===1?'':'s'} hidden from issue counts.` : 'Only unresolved items are included.'}</span></div>
    <div class="v87-issue-list">${rows}</div>
    <div class="actions" style="margin-top:14px"><button class="primary" onclick="closeModal(); go('timesheets')">Open timesheets</button><button onclick="closeModal()">Close</button></div>`);
}
function v89PunchCard(title, subtitle, tone, onclick, items){
  return `<button type="button" class="v89-punch-card ${esc(tone)}" onclick="${onclick}">
    <div class="v89-punch-head"><strong>${esc(title)}</strong><span>${esc(subtitle)}</span></div>
    <div class="v89-punch-grid">${items.map(it => `<div><b>${esc(it.value)}</b><small>${esc(it.label)}</small></div>`).join('')}</div>
  </button>`;
}
function v89PunchSummaryCards(data){
  const breakTone = data.breakIssuesCount ? 'orange' : 'green';
  const clockTone = data.clockIssuesCount ? 'orange' : 'green';
  return `<div class="v89-punch-cards">
    ${v89PunchCard('Break punches', data.breakIssuesCount ? `${data.breakIssuesCount} to review` : 'All clear', breakTone, "openBreakIssuesModal('allbreak')", [
      {value:`${data.breakMins}`, label:'mins'}, {value:data.missingBreaks, label:'missing'}, {value:data.longBreaks, label:'long'}, {value:data.openBreaks, label:'open'}
    ])}
    ${v89PunchCard('Clock in/out punches', data.clockIssuesCount ? `${data.clockIssuesCount} to review` : 'All clear', clockTone, "openBreakIssuesModal('allclock')", [
      {value:data.missingPunchIns, label:'missing'}, {value:data.earlyPunches, label:'early'}, {value:data.extendedPunches, label:'extended'}, {value:data.noSchedulePunches, label:'no schedule'}
    ])}
  </div>`;
}
function v79WeekComparisonPanel(){
  const currentStart = getMonday(rosterWeekStart || new Date());
  const currentEnd = addDays(currentStart,7);
  const previousStart = addDays(currentStart,-7);
  const previousEnd = currentStart;
  const currentShifts = v79BusinessShiftsInRange(currentStart,currentEnd,true);
  const previousShifts = v79BusinessShiftsInRange(previousStart,previousEnd,true);
  const currentScheduled = totalHours(currentShifts);
  const previousScheduled = totalHours(previousShifts);
  const currentWorked = v79WorkedHoursInRange(currentStart,currentEnd);
  const previousWorked = v79WorkedHoursInRange(previousStart,previousEnd);
  const currentPublished = currentShifts.length > 0;
  const data = v89TimeStatsDetailed(currentStart,currentEnd);
  const max = Math.max(1,currentScheduled,previousScheduled,currentWorked,previousWorked,data.issuesCount);
  return `<section class="v79-panel v79-compare-panel v80-clean-panel v87-health-panel v88-health-panel v89-health-panel">
    <div class="v79-panel-head v87-panel-head">
      <div><span class="eyebrow">Week health</span><h3>${currentPublished ? 'Current week published' : 'Not published yet'}</h3><p>${v79RangeLabel(currentStart,currentEnd)}</p></div>
      ${v80StatusPill(currentPublished ? 'Published' : 'Draft', currentPublished ? 'green' : 'orange')}
    </div>
    <div class="v87-health-summary v88-health-summary v89-health-summary">
      <button onclick="go('roster')"><span>Previous week</span><strong>${previousScheduled.toFixed(1)} sched / ${previousWorked.toFixed(1)} worked</strong></button>
      <button onclick="go('roster')"><span>Current week</span><strong>${currentScheduled.toFixed(1)} sched / ${currentWorked.toFixed(1)} worked</strong></button>
    </div>
    ${v89PunchSummaryCards(data)}
    <div class="v79-bars compare v87-bars v88-bars v89-bars">
      ${v79Bar('Prev scheduled', v79RangeLabel(previousStart,previousEnd), previousScheduled, max, 'blue')}
      ${v79Bar('Prev worked', 'Clock records', previousWorked, max, 'green')}
      ${v79Bar('Current scheduled', currentPublished ? 'Published' : 'Not published', currentScheduled, max, currentPublished ? 'blue' : 'orange')}
      ${v79Bar('Current worked', 'Clock records', currentWorked, max, 'green')}
      ${data.issuesCount ? v79Bar('Punch reviews', `${data.breakIssuesCount} break · ${data.clockIssuesCount} clock`, data.issuesCount, max, 'orange') : ''}
    </div>
  </section>`;
}

/* v91: robust swipe/drag support for logged-in top navigation on mobile */
(function installV91LoggedInNavSwipe(){
  if(window.__v91LoggedInNavSwipe) return;
  window.__v91LoggedInNavSwipe = true;
  let target = null, startX = 0, startScroll = 0, moved = false;
  document.addEventListener("pointerdown", function(e){
    const nav = e.target && e.target.closest ? e.target.closest("body.logged-in .sidebar") : null;
    if(!nav || window.innerWidth > 1000) return;
    target = nav;
    startX = e.clientX;
    startScroll = nav.scrollLeft;
    moved = false;
  }, {passive:true});
  document.addEventListener("pointermove", function(e){
    if(!target) return;
    const dx = e.clientX - startX;
    if(Math.abs(dx) > 5) moved = true;
    if(moved){
      target.scrollLeft = startScroll - dx;
      e.preventDefault();
    }
  }, {passive:false});
  document.addEventListener("pointerup", function(){
    target = null;
  }, {passive:true});
  document.addEventListener("pointercancel", function(){
    target = null;
  }, {passive:true});
})();

/* v93: targeted QA fixes for punch modals, mobile navigation, reports, and clean issue actions */
function closeModal(){
  document.querySelectorAll('.modal-backdrop').forEach(m => m.remove());
}
function go(view){
  closeModal();
  currentView = view;
  renderContent();
}
function v93IssueActionButtons(item){
  const cat = String(item?.category || '');
  const timesheetLabel = cat === 'missingpunch' ? 'Open timesheets' : 'Review timesheet';
  const rosterNeeded = ['missingpunch','noschedule','early','extended'].includes(cat);
  return `<div class="v93-issue-actions">
    <button type="button" class="primary" onclick="closeModal(); go('timesheets')">${esc(timesheetLabel)}</button>
    ${rosterNeeded ? `<button type="button" onclick="closeModal(); go('roster')">Open roster</button>` : ``}
  </div>`;
}
function openBreakIssuesModal(filter='allbreak'){
  closeModal();
  const currentStart = getMonday(rosterWeekStart || new Date());
  const currentEnd = addDays(currentStart,7);
  const data = v89TimeStatsDetailed(currentStart,currentEnd);
  const isClock = ['allclock','missingpunch','early','extended','noschedule'].includes(filter);
  const group = isClock ? 'clock' : 'break';
  let pool;
  if(filter === 'break') pool = data.breakRows;
  else if(filter === 'allbreak') pool = data.breakIssues;
  else if(filter === 'allclock') pool = data.clockIssues;
  else pool = (isClock ? data.clockIssues : data.breakIssues).filter(item => item.category === filter);
  const rows = pool.length ? pool.map(item => `<div class="v87-issue-row v89-issue-row v93-issue-row ${esc(item.category || '')}">
    <div class="v93-issue-top"><strong>${esc(item.type)}</strong><span>${esc(item.employee)} · ${esc(item.date)}</span></div>
    <p>${esc(item.detail)}</p>
    <em>${esc(item.action)}</em>
    ${v93IssueActionButtons(item)}
  </div>`).join('') : `<div class="apple-empty-mini"><strong>No ${esc(v89IssueLabel(filter).toLowerCase())}</strong><span>Only unresolved items appear here.</span></div>`;
  const filterRow = group === 'clock' ? `<div class="v88-filter-row v89-filter-row v93-filter-row">
      ${v88IssueFilterButton('missingpunch','Missing',data.missingPunchIns,filter,data.missingPunchIns?'orange':'green')}
      ${v88IssueFilterButton('early','Early',data.earlyPunches,filter,data.earlyPunches?'orange':'green')}
      ${v88IssueFilterButton('extended','Extended',data.extendedPunches,filter,data.extendedPunches?'orange':'green')}
      ${v88IssueFilterButton('noschedule','No schedule',data.noSchedulePunches,filter,data.noSchedulePunches?'orange':'green')}
    </div>` : `<div class="v88-filter-row v89-filter-row v93-filter-row">
      ${v88IssueFilterButton('break','Break time',`${data.breakMins} mins`,filter,'blue')}
      ${v88IssueFilterButton('missing','Missing',data.missingBreaks,filter,data.missingBreaks?'orange':'green')}
      ${v88IssueFilterButton('long','Long',data.longBreaks,filter,data.longBreaks?'orange':'green')}
      ${v88IssueFilterButton('open','Open',data.openBreaks,filter,data.openBreaks?'orange':'green')}
    </div>`;
  modal(`<h2>${esc(v89GroupLabel(group))}</h2><p class="muted">${esc(v79RangeLabel(currentStart,currentEnd))}</p>
    ${filterRow}
    <div class="v88-filter-context v93-filter-context"><strong>${esc(v89IssueLabel(filter))}</strong></div>
    <div class="v87-issue-list v93-issue-list">${rows}</div>
    <div class="actions" style="margin-top:14px"><button class="primary" onclick="closeModal(); go('timesheets')">Open timesheets</button><button onclick="closeModal()">Close</button></div>`);
}

/* v94: manager timesheet administration, red flags, and missed clock-out reconciliation */
function v94IsOnCallShift(shift){
  if(!shift) return false;
  const text = `${shift.role||''} ${shift.notes||''} ${shift.type||''}`.toLowerCase();
  return !!shift.onCall || text.includes('on call') || text.includes('on-call');
}
function v94LocalDateKey(value=new Date()){
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
function v94DateTimeLocal(iso){
  if(!iso) return '';
  const d = new Date(iso);
  if(Number.isNaN(d.getTime())) return '';
  const p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
function v94IsoFromLocal(value){
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}
function v94ShiftForEmployeeDate(employeeId,date){
  return (state.shifts||[]).find(s => s.employeeId===employeeId && s.date===date && (!s.businessId || s.businessId===business().id));
}
function v94ScheduledEndIso(t){
  if(!t || !t.scheduledEnd) return '';
  const date = (t.clockIn||'').slice(0,10) || t.date;
  if(!date) return '';
  const start = t.scheduledStart || '00:00';
  const endDate = new Date(`${date}T${t.scheduledEnd}:00`);
  if(t.scheduledEnd < start) endDate.setDate(endDate.getDate()+1);
  return Number.isNaN(endDate.getTime()) ? '' : endDate.toISOString();
}
function reconcileMissedClockOuts(){
  ensureOperationsData();
  const nowDate = new Date();
  const today = v94LocalDateKey(nowDate);
  let changed = 0;
  (state.timesheets||[]).forEach(t => {
    if(t.clockOut || t.status==='approved') return;
    const date = (t.clockIn||'').slice(0,10);
    if(!date) return;
    const pastDay = date < today;
    const nightlyCutoff = date===today && nowDate.getHours()===23 && nowDate.getMinutes()>=59;
    if(!pastDay && !nightlyCutoff) return;
    const scheduledEnd = v94ScheduledEndIso(t);
    if(!scheduledEnd){
      t.redFlag = t.redFlag || 'Missing clock-out — no scheduled end';
      t.needsManagerReview = true;
      return;
    }
    if(Array.isArray(t.breaks)) t.breaks.forEach(br=>{ if(br && br.start && !br.end) br.end=scheduledEnd; });
    t.clockOut = scheduledEnd;
    t.breakMinutes = breakMinutesFor(t);
    t.workedHours = Number(workedHoursFor(t).toFixed(2));
    t.status = 'pending';
    t.autoClockOut = true;
    t.autoClockOutAt = now();
    t.redFlag = 'Auto clock-out applied at scheduled end';
    t.needsManagerReview = true;
    changed++;
    const employee = state.users.find(u=>u.id===t.employeeId) || state.employees.find(e=>e.id===t.employeeId) || {};
    notifyRole(['owner','manager'],'timesheet','Automatic clock-out needs review',`${employee.name||'Employee'} missed clock-out. MySchedule closed the record at the assigned end time ${t.scheduledEnd}. Please review before approval.`);
  });
  if(changed){ saveState(); }
  return changed;
}
(function installV94NightlyReconciliation(){
  if(window.__v94NightlyReconciliation) return;
  window.__v94NightlyReconciliation=true;
  try{ reconcileMissedClockOuts(); }catch(e){ console.warn('Timesheet reconciliation skipped',e); }
  setInterval(()=>{ try{ reconcileMissedClockOuts(); if(currentView==='timesheets') renderContent(); }catch(e){} },60000);
})();
function v94TimesheetFlags(t){
  const flags=[];
  if(t.autoClockOut) flags.push('Automatic clock-out');
  if(t.redFlag) flags.push(t.redFlag);
  if(t.isException) flags.push('Emergency punch');
  if(!t.clockOut) flags.push('Still clocked in');
  if(t.clockOut && workedHoursFor(t)>12) flags.push('Extended shift');
  if(t.clockIn && t.scheduledStart){
    const variance=attendanceVarianceText(t);
    if(variance && variance!=='On time') flags.push(variance);
  }
  return [...new Set(flags)];
}
function v94TimesheetForm(id=''){
  ensureOperationsData();
  const t=id ? state.timesheets.find(x=>x.id===id) : null;
  const employees=(state.users||[]).filter(u=>u.businessId===business().id && !isManagerial(u));
  const defaultEmployee=t?.employeeId || employees[0]?.id || '';
  const date=(t?.clockIn||'').slice(0,10) || v94LocalDateKey();
  const shift=v94ShiftForEmployeeDate(defaultEmployee,date);
  const clockIn=v94DateTimeLocal(t?.clockIn || (shift ? `${shift.date}T${shift.start}:00` : `${date}T09:00:00`));
  const clockOut=v94DateTimeLocal(t?.clockOut || (shift ? `${shift.date}T${shift.end}:00` : `${date}T17:00:00`));
  const breakMins=t ? breakMinutesFor(t) : 0;
  modal(`<h2>${t?'Edit':'Add'} time record</h2>
    <div class="v94-rule-note"><strong>Manager control</strong><span>Create or correct punches on the shift day or afterwards. Future records are allowed only for an on-call shift.</span></div>
    <label>Employee</label><select id="v94-ts-employee" onchange="v94SyncShiftDefaults()">${employees.map(u=>`<option value="${esc(u.id)}" ${u.id===defaultEmployee?'selected':''}>${esc(u.name)}</option>`).join('')}</select>
    <label>Shift date</label><input id="v94-ts-date" type="date" value="${esc(date)}" onchange="v94SyncShiftDefaults()">
    <div id="v94-ts-shift-context" class="v94-shift-context"></div>
    <div class="v94-form-grid"><label>Clock in<input id="v94-ts-in" type="datetime-local" value="${esc(clockIn)}"></label><label>Clock out<input id="v94-ts-out" type="datetime-local" value="${esc(clockOut)}"></label></div>
    <label>Break minutes</label><input id="v94-ts-break" type="number" min="0" max="480" step="1" value="${breakMins}">
    <label>Manager note</label><textarea id="v94-ts-note" placeholder="Reason for correction or manual entry">${esc(t?.managerNote||'')}</textarea>
    <div class="actions"><button class="primary" onclick="v94SaveTimesheet('${esc(id)}')">${t?'Save changes':'Create record'}</button><button onclick="closeModal()">Cancel</button></div>`);
  setTimeout(v94SyncShiftDefaults,0);
}
function v94SyncShiftDefaults(){
  const employeeId=val('v94-ts-employee');
  const date=val('v94-ts-date');
  const shift=v94ShiftForEmployeeDate(employeeId,date);
  const box=document.getElementById('v94-ts-shift-context');
  if(box) box.innerHTML=shift ? `<strong>${v94IsOnCallShift(shift)?'On-call shift':'Scheduled shift'}</strong><span>${esc(shift.start)} – ${esc(shift.end)} · ${shiftHours(shift).toFixed(1)} hrs</span>` : `<strong>No scheduled shift</strong><span>This entry will be red-flagged for manager review.</span>`;
}
function v94SaveTimesheet(id=''){
  if(!isManagerial(currentUser())) return toast('Manager access required.');
  const employeeId=val('v94-ts-employee'), date=val('v94-ts-date');
  const inValue=val('v94-ts-in'), outValue=val('v94-ts-out');
  const breakMins=Math.max(0,Number(val('v94-ts-break')||0));
  const note=val('v94-ts-note').trim();
  if(!employeeId||!date||!inValue) return toast('Employee, date and clock-in are required.');
  const shift=v94ShiftForEmployeeDate(employeeId,date);
  const today=v94LocalDateKey();
  if(date>today && !v94IsOnCallShift(shift)) return toast('Future punches are allowed only for an on-call shift.');
  const clockIn=v94IsoFromLocal(inValue), clockOut=outValue?v94IsoFromLocal(outValue):null;
  if(clockOut && new Date(clockOut)<=new Date(clockIn)) return toast('Clock-out must be after clock-in.');
  let t=id ? state.timesheets.find(x=>x.id===id) : null;
  if(!t){
    t={id:uuid(),businessId:business().id,employeeId,breaks:[],status:clockOut?'pending':'open',createdByManager:true,createdAt:now()};
    state.timesheets.push(t);
  }
  t.employeeId=employeeId; t.shiftId=shift?.id||''; t.clockIn=clockIn; t.clockOut=clockOut;
  t.scheduledStart=shift?.start||''; t.scheduledEnd=shift?.end||''; t.role=shift?.role||'';
  t.managerNote=note; t.managerEditedAt=now(); t.managerEditedBy=currentUser().id;
  t.breaks=[];
  if(breakMins>0){
    const start=new Date(clockIn); start.setHours(start.getHours()+Math.min(4,Math.max(1,(clockOut?workedHoursFor({...t,breaks:[]}):4)/2)));
    const end=new Date(start.getTime()+breakMins*60000);
    t.breaks=[{start:start.toISOString(),end:end.toISOString(),managerEntered:true}];
  }
  t.breakMinutes=breakMins; t.workedHours=clockOut?Number(workedHoursFor(t).toFixed(2)):0;
  t.status=clockOut?'pending':'open';
  t.redFlag=!shift?'Clock record without scheduled shift':(date>today?'Future on-call record':'');
  t.needsManagerReview=true;
  saveState(); closeModal();
  notifyUser(employeeId,'timesheet',id?'Time record corrected':'Time record added',`A manager ${id?'updated':'created'} your time record for ${date}.`);
  toast(id?'Time record updated.':'Time record created.'); renderContent();
}
function v94DeleteTimesheet(id){
  if(!isManagerial(currentUser())) return toast('Manager access required.');
  const t=state.timesheets.find(x=>x.id===id); if(!t) return toast('Time record not found.');
  modal(`<h2>Delete time record?</h2><p>This permanently removes the clock and break record. Use only for a duplicate or invalid entry.</p><div class="actions"><button class="danger" onclick="v94ConfirmDeleteTimesheet('${esc(id)}')">Delete record</button><button onclick="closeModal()">Cancel</button></div>`);
}
function v94ConfirmDeleteTimesheet(id){
  const idx=state.timesheets.findIndex(x=>x.id===id); if(idx<0) return;
  const [t]=state.timesheets.splice(idx,1); saveState(); closeModal();
  notifyUser(t.employeeId,'timesheet','Time record removed','A manager removed an invalid or duplicate time record.');
  toast('Time record deleted.'); renderContent();
}
function managerTimesheetCards(rows){
  if(!rows.length) return `<div class="apple-empty-mini"><strong>No time records yet</strong><span>Employee clock activity will appear here.</span></div>`;
  return `<div class="ts-card-list manager v94-manager-ts-list">${rows.map(t=>{
    const u=state.users.find(x=>x.id===t.employeeId)||state.employees.find(x=>x.id===t.employeeId)||{};
    const status=t.status||(t.clockOut?'pending':'open'); const flags=v94TimesheetFlags(t);
    return `<article class="ts-card v94-ts-card ${flags.length?'has-flag':''}" data-timesheet-id="${esc(t.id)}">
      <div class="v94-ts-person"><strong>${esc(u.name||'Employee')}</strong><span>${dateTime(t.clockIn)} → ${t.clockOut?dateTime(t.clockOut):'Still clocked in'}</span>${t.managerNote?`<small>${esc(t.managerNote)}</small>`:''}</div>
      <div class="v94-ts-hours"><strong>${workedHoursFor(t).toFixed(2)} hrs</strong><span>Break ${breakMinutesFor(t)} mins</span></div>
      ${timesheetStatusPill(t)}
      ${flags.length?`<div class="v94-flag-list">${flags.map(f=>`<span>${esc(f)}</span>`).join('')}</div>`:''}
      <div class="ts-actions v94-ts-actions"><button class="tiny" onclick="v94TimesheetForm('${esc(t.id)}')">Edit</button>${t.clockOut&&status!=='approved'?`<button class="tiny primary" onclick="approveTimesheet('${esc(t.id)}')">Approve</button>`:''}${status==='approved'?`<button class="tiny" onclick="reopenTimesheet('${esc(t.id)}')">Reopen</button>`:''}<button class="tiny danger-text" onclick="v94DeleteTimesheet('${esc(t.id)}')">Delete</button></div>
    </article>`;
  }).join('')}</div>`;
}
function timesheetsView(){
  ensureOperationsData(); reconcileMissedClockOuts();
  const rows=state.timesheets.filter(t=>t.businessId===business().id).sort((a,b)=>(b.clockIn||'').localeCompare(a.clockIn||''));
  const pending=rows.filter(t=>(t.status||(t.clockOut?'pending':'open'))==='pending');
  const open=rows.filter(t=>!t.clockOut); const flagged=rows.filter(t=>v94TimesheetFlags(t).length);
  return `<section class="apple-clean-page manager-timesheets v94-timesheets">
    ${pageHero('Timesheets','Review, correct and approve clock, break and attendance records.',`<button class="primary" onclick="v94TimesheetForm()">Add time record</button>`)}
    <div class="qa-metric-strip compact v94-ts-metrics"><button><strong>${open.length}</strong><span>Clocked in</span></button><button><strong>${pending.length}</strong><span>Needs review</span></button><button class="${flagged.length?'attention':''}"><strong>${flagged.length}</strong><span>Red flags</span></button><button><strong>${rows.filter(t=>t.status==='approved').length}</strong><span>Approved</span></button></div>
    <div class="apple-panel"><div class="apple-panel-head"><div><h3>Time records</h3><p>Managers can add, edit, approve, reopen or delete punches and breaks.</p></div><button onclick="v94TimesheetForm()">Add record</button></div>${managerTimesheetCards(rows)}</div>
  </section>`;
}
window.v94TimesheetForm=v94TimesheetForm; window.v94SyncShiftDefaults=v94SyncShiftDefaults; window.v94SaveTimesheet=v94SaveTimesheet; window.v94DeleteTimesheet=v94DeleteTimesheet; window.v94ConfirmDeleteTimesheet=v94ConfirmDeleteTimesheet;

/* v95: team schedule navigation, business-time clock, weekly records, request filters, deduped change requests */
let requestHistoryFilter = 'all';
function moveWeek(days){
  rosterWeekStart = addDays(rosterWeekStart || getMonday(new Date()), Number(days)||0);
  renderContent();
}
function detectedDeviceTimezone(){
  try{
    const tz=Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz && tz.includes('/') ? tz : 'UTC';
  }catch(e){ return 'UTC'; }
}
function businessTimezone(){
  const b=business();
  const deviceTz=detectedDeviceTimezone();
  let tz=(b?.timezone||'').trim();
  const legacyDefault=!tz || tz==='Australia/Perth';
  const deviceLooksCanadian=/^America\/(Toronto|Montreal|Ottawa|Thunder_Bay|Iqaluit|Nipigon|Rainy_River)$/i.test(deviceTz);
  const businessLooksCanadian=/canada|ontario/i.test(`${b?.country||''} ${b?.name||''}`);
  if(legacyDefault && (deviceLooksCanadian || businessLooksCanadian)){
    tz=deviceLooksCanadian ? deviceTz : 'America/Toronto';
    if(b && b.timezone!==tz){ b.timezone=tz; try{ saveState(); }catch(e){} }
  }
  if(!tz) tz=deviceTz;
  try{ new Intl.DateTimeFormat('en-CA',{timeZone:tz}).format(new Date()); }
  catch(e){ tz=deviceTz; }
  return tz;
}
function friendlyTimezoneLabel(tz){
  if(tz==='America/Toronto') return 'Ontario time · America/Toronto';
  return tz.replace(/_/g,' ');
}
function businessClockMarkup(){
  const tz=businessTimezone();
  return `<div class="v95-digital-clock" data-business-clock data-timezone="${esc(tz)}"><strong>--:--:--</strong><span>${esc(friendlyTimezoneLabel(tz))}</span></div>`;
}
function updateBusinessClocks(){
  document.querySelectorAll('[data-business-clock]').forEach(el=>{
    const tz=el.dataset.timezone||businessTimezone();
    try{
      const nowDate=new Date();
      const text=new Intl.DateTimeFormat('en-CA',{timeZone:tz,hour:'numeric',minute:'2-digit',second:'2-digit',hour12:true}).format(nowDate);
      const label=new Intl.DateTimeFormat('en-CA',{timeZone:tz,weekday:'short',month:'short',day:'numeric',year:'numeric'}).format(nowDate);
      el.querySelector('strong').textContent=text;
      el.querySelector('span').textContent=`${label} · ${friendlyTimezoneLabel(tz)}`;
    }catch(e){
      el.querySelector('strong').textContent=new Date().toLocaleTimeString('en-CA',{hour:'numeric',minute:'2-digit',second:'2-digit',hour12:true});
      el.querySelector('span').textContent=friendlyTimezoneLabel(detectedDeviceTimezone());
    }
  });
}
if(!window.__v95ClockTimer){ window.__v95ClockTimer=setInterval(updateBusinessClocks,1000); }
function employeeTeamScheduleView(){
  const user=currentUser(); const days=Array.from({length:7},(_,i)=>addDays(rosterWeekStart,i)); const shifts=employeeTeamScheduleShifts(user);
  setTimeout(updateBusinessClocks,0);
  return `<section class="employee-apple-dashboard qa-employee-page">
    ${pageHero('Team Schedule','')}
    <div class="qa-week-toolbar compact-toolbar v95-team-toolbar"><div class="week-switcher"><button onclick="moveWeek(-7)">‹</button><span class="week-pill">${shortDate(rosterWeekStart)} – ${shortDate(addDays(rosterWeekStart,6))}</span><button onclick="moveWeek(7)">›</button></div><button class="ghost" onclick="go('myshifts')">Back to My Shifts</button></div>
    <div class="schedule-scroll-shell"><div class="team-week-board">${days.map(day=>{const date=isoDate(day);const rows=shifts.filter(s=>s.date===date).sort(sortShift);return `<div class="team-day-column"><div class="team-day-head"><strong>${dayName(day)}</strong><span>${shortDate(day)}</span></div>${rows.length?rows.map(teamScheduleEmployeeCard).join(''):`<div class="empty-shift">No published shifts</div>`}</div>`}).join('')}</div></div>
  </section>`;
}
function weeklyTimesheetGroups(rows){
  const groups={};
  rows.forEach(t=>{const d=new Date(t.clockIn||Date.now());const start=getMonday(d);const key=isoDate(start);(groups[key]||(groups[key]={start,rows:[]})).rows.push(t);});
  return Object.values(groups).sort((a,b)=>b.start-a.start);
}
function employeeWeeklyTimeRecords(rows){
  const groups=weeklyTimesheetGroups(rows);
  if(!groups.length) return `<div class="apple-empty-mini"><strong>No time records</strong><span>Your completed clock activity will appear here.</span></div>`;
  return groups.map((g,i)=>`<details class="apple-history v95-week-record" ${i===0?'open':''}><summary><span>${shortDate(g.start)} – ${shortDate(addDays(g.start,6))}</span><small>${g.rows.length} record${g.rows.length===1?'':'s'}</small></summary>${employeeTimesheetCards(g.rows)}</details>`).join('');
}
function clockView(){
  ensureOperationsData(); const user=currentUser(); const active=currentOpenTimesheet(user.id); const br=activeBreak(active); const info=clockWindowInfo(user); const todayShift=active&&active.shiftId?state.shifts.find(s=>s.id===active.shiftId):info.shift;
  const rows=state.timesheets.filter(t=>t.employeeId===user.id).sort((a,b)=>(b.clockIn||'').localeCompare(a.clockIn||'')); const emergencyAllowed=!active&&!info.canClock;
  const disabledClockLabel=info.shift&&info.mode==='too_early'?`Clock In opens at ${timeAddMinutes(info.shift.start,-10)}`:(info.shift&&info.mode==='late'?'Normal Clock In closed':'Clock In unavailable');
  setTimeout(updateBusinessClocks,0);
  return `<section class="apple-clean-page timeclock-page">${pageHero('Clock','',businessClockMarkup())}<div class="timeclock-focus apple-panel"><div><span class="eyebrow">Today</span><h3>${active?'You are clocked in':info.title}</h3><p class="muted">${todayShift?`Scheduled ${esc(todayShift.start)} – ${esc(todayShift.end)} · ${shiftHours(todayShift).toFixed(1)} hrs`:'No active published shift found for today.'}</p><div class="clock-rule-card ${info.canClock?'ok':emergencyAllowed?'warn':'soft'}">${esc(active?'Complete your shift by ending breaks and clocking out when finished.':info.message)}</div>${active?`<p class="small muted">Clocked in ${dateTime(active.clockIn)} · Break ${breakMinutesFor(active)} mins · Worked ${workedHoursFor(active).toFixed(2)} hrs</p>`:''}</div><div class="clock-actions">${active?`${br?`<button class="secondary" onclick="endBreak()">End Break</button>`:`<button class="secondary" onclick="startBreak()">Start Break</button>`}<button class="danger" onclick="clockOut()">Clock Out</button>`:`${info.canClock?`<button class="primary" onclick="clockIn()">Clock In</button>`:`<button class="disabled-action" disabled title="${esc(info.message)}">${esc(disabledClockLabel)}</button>`}${emergencyAllowed?`<button class="warning" onclick="openEmergencyClockIn()">Emergency Clock In</button>`:''}`}</div></div><details class="apple-panel collapsible-records"><summary><span>My time records</span><small>Organized by week.</small></summary><div class="collapsible-records-body">${employeeWeeklyTimeRecords(rows)}</div></details></section>`;
}
function filteredHistoryRows(rows){
  if(requestHistoryFilter==='approved') return rows.filter(r=>r.status==='approved');
  if(requestHistoryFilter==='rejected') return rows.filter(r=>r.status==='rejected');
  return rows;
}
function setRequestHistoryFilter(filter){ requestHistoryFilter=filter; renderContent(); }
function requestsView(managerMode){
  const allRows=(managerMode?state.requests.filter(r=>r.businessId===business().id):state.requests.filter(r=>r.employeeId===currentUser().id)).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
  const currentRows=allRows.filter(r=>r.status==='pending'); const history=allRows.filter(r=>r.status!=='pending'); const approved=history.filter(r=>r.status==='approved').length; const rejected=history.filter(r=>r.status==='rejected').length; const filtered=filteredHistoryRows(history);
  return `<section class="apple-requests-page qa-requests-page">${pageHero(managerMode?'Requests':'My Requests','Current requests appear first. Completed requests stay in filtered history.',currentRows.length?`<span class="apple-count-bubble">${currentRows.length}</span>`:`<span class="apple-clear-bubble">0</span>`)}${currentRows.length?requestsCards(currentRows,managerMode):`<div class="apple-empty-state qa-empty"><div class="apple-empty-icon">✓</div><h3>No current requests</h3></div>`}${history.length?`<details class="apple-history" open><summary>Request history (${history.length})</summary><div class="v95-request-filters"><button class="${requestHistoryFilter==='all'?'active':''}" onclick="setRequestHistoryFilter('all')">All <b>${history.length}</b></button><button class="${requestHistoryFilter==='approved'?'active':''}" onclick="setRequestHistoryFilter('approved')">Approved <b>${approved}</b></button><button class="${requestHistoryFilter==='rejected'?'active':''}" onclick="setRequestHistoryFilter('rejected')">Rejected <b>${rejected}</b></button></div>${filtered.length?requestsCards(filtered,managerMode,true):`<div class="apple-empty-mini"><strong>No ${requestHistoryFilter} requests</strong></div>`}</details>`:''}</section>`;
}
function submitChange(shiftId){
  const check=canEmployeeActOnShift(shiftId); if(!check.ok) return toast(check.message); if(!val('c-msg')) return toast('Enter message.');
  const existing=state.requests.find(r=>r.type==='change'&&r.shiftId===shiftId&&r.employeeId===currentUser().id&&r.status==='pending');
  const shift=check.shift; const message=`Reason: ${val('c-reason')}. ${val('c-msg')}`;
  if(existing){ existing.message=message; existing.updatedAt=now(); existing.shiftSnapshot=shift?{date:shift.date,day:fullDayName(dateObj(shift.date)),time:`${shift.start}-${shift.end}`,role:shift.role,status:shift.status,notes:shift.notes||''}:null; saveState(); closeModal(); renderContent(); return toast('Existing change request updated.'); }
  const r={id:uuid(),businessId:business().id,employeeId:currentUser().id,shiftId,type:'change',message,status:'pending',createdAt:now(),seenBy:[],shiftSnapshot:shift?{date:shift.date,day:fullDayName(dateObj(shift.date)),time:`${shift.start}-${shift.end}`,role:shift.role,status:shift.status,notes:shift.notes||''}:null}; state.requests.push(r); saveState(); notifyRole(['owner','manager'],'request','Shift change request',`${currentUser().name} requested a shift change.`,{requestId:r.id,shiftId,targetView:'requests'}); closeModal(); renderContent(); toast('Change request submitted.');
}
function managerTimesheetCards(rows){
  if(!rows.length) return `<div class="apple-empty-mini"><strong>No time records yet</strong></div>`;
  return `<div class="ts-card-list manager v94-manager-ts-list">${rows.map(t=>{const u=state.users.find(x=>x.id===t.employeeId)||state.employees.find(x=>x.id===t.employeeId)||{};const status=t.status||(t.clockOut?'pending':'open');const flags=v94TimesheetFlags(t);return `<details class="ts-card v94-ts-card v95-ts-collapsed ${flags.length?'has-flag':''}"><summary><div class="v94-ts-person"><strong>${esc(u.name||'Employee')}</strong><span>${dateTime(t.clockIn)} → ${t.clockOut?dateTime(t.clockOut):'Still clocked in'}</span></div><div class="v94-ts-hours"><strong>${workedHoursFor(t).toFixed(2)} hrs</strong><span>${timesheetStatusPill(t)}</span></div></summary><div class="v95-ts-details"><span>Break ${breakMinutesFor(t)} mins</span>${flags.length?`<div class="v94-flag-list">${flags.map(f=>`<span>${esc(f)}</span>`).join('')}</div>`:''}<div class="ts-actions v94-ts-actions"><button class="tiny" onclick="v94TimesheetForm('${esc(t.id)}')">Edit</button>${t.clockOut&&status!=='approved'?`<button class="tiny primary" onclick="approveTimesheet('${esc(t.id)}')">Approve</button>`:''}${status==='approved'?`<button class="tiny" onclick="reopenTimesheet('${esc(t.id)}')">Reopen</button>`:''}<button class="tiny danger-text" onclick="v94DeleteTimesheet('${esc(t.id)}')">Delete</button></div></div></details>`}).join('')}</div>`;
}
function timesheetsView(){
  ensureOperationsData(); reconcileMissedClockOuts(); const rows=state.timesheets.filter(t=>t.businessId===business().id).sort((a,b)=>(b.clockIn||'').localeCompare(a.clockIn||'')); const groups=weeklyTimesheetGroups(rows); const pending=rows.filter(t=>(t.status||(t.clockOut?'pending':'open'))==='pending'); const open=rows.filter(t=>!t.clockOut); const flagged=rows.filter(t=>v94TimesheetFlags(t).length);
  return `<section class="apple-clean-page manager-timesheets v94-timesheets">${pageHero('Timesheets','Review weekly clock, break and attendance records.',`<button class="primary" onclick="v94TimesheetForm()">Add time record</button>`)}<div class="qa-metric-strip compact v94-ts-metrics"><button><strong>${open.length}</strong><span>Clocked in</span></button><button><strong>${pending.length}</strong><span>Needs review</span></button><button class="${flagged.length?'attention':''}"><strong>${flagged.length}</strong><span>Red flags</span></button><button><strong>${rows.filter(t=>t.status==='approved').length}</strong><span>Approved</span></button></div>${groups.length?groups.map((g,i)=>`<details class="apple-panel v95-manager-week" ${i===0?'open':''}><summary><div><h3>${shortDate(g.start)} – ${shortDate(addDays(g.start,6))}</h3><p>${g.rows.length} time record${g.rows.length===1?'':'s'}</p></div><span>${g.rows.reduce((n,t)=>n+workedHoursFor(t),0).toFixed(1)} hrs</span></summary>${managerTimesheetCards(g.rows)}</details>`).join(''):`<div class="apple-panel"><div class="apple-empty-mini"><strong>No time records yet</strong></div></div>`}</section>`;
}
window.moveWeek=moveWeek; window.setRequestHistoryFilter=setRequestHistoryFilter;

/* v96: competitor-free landing, combined employee requests/availability, modern team schedule,
   linked business industry selection, and invited-user first-login password change. */
let requestHubMode = 'requests';
function v96GenerateTempPassword(){
  const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#';
  let out='';
  for(let i=0;i<10;i++) out+=alphabet[Math.floor(Math.random()*alphabet.length)];
  return out;
}
function v96RememberEmail(email){
  try{ localStorage.setItem('myscheduleRememberedEmail', normalizeEmail(email)); }catch(e){}
}
function v96PrefillRememberedEmail(){
  const input=el('login-email');
  if(!input || input.value) return;
  try{ input.value=localStorage.getItem('myscheduleRememberedEmail')||''; }catch(e){}
}
const __v96RenderBase = render;
render = function(){
  __v96RenderBase();
  setTimeout(v96PrefillRememberedEmail,0);
};
function selectBusinessSuggestion(name, industry){
  const nameInput=el('signup-business-name');
  const industryInput=el('signup-industry');
  if(nameInput) nameInput.value=name||'';
  const normal=INDUSTRY_OPTIONS.includes(industry)?industry:normaliseSuggestedIndustry(industry);
  if(industryInput){
    industryInput.value=normal||'Other';
    industryInput.dispatchEvent(new Event('change',{bubbles:true}));
  }
  businessIndustryManualOverride=false;
  updateIndustryOtherField();
  closeBusinessSuggestionList();
  setTimeout(()=>el('signup-name')?.focus(),40);
}
function businessNameInputChanged(){
  businessIndustryManualOverride=false;
  const raw=(el('signup-business-name')?.value||'').trim();
  if(raw.length>=2){
    const guessed=normaliseSuggestedIndustry(raw);
    const industryInput=el('signup-industry');
    if(industryInput && guessed && guessed!=='Other'){
      industryInput.value=guessed;
      industryInput.dispatchEvent(new Event('change',{bubbles:true}));
      updateIndustryOtherField();
    }
  }
  updateBusinessNameSuggestions();
}
function v96RequestHub(mode='requests'){
  requestHubMode=mode;
  currentView='requesthub';
  renderContent();
}
function employeeRequestsAvailabilityView(){
  const body=requestHubMode==='availability'?availabilityView():requestsView(false);
  return `<section class="v96-requesthub apple-clean-page">
    <div class="v96-requesthub-head">
      <div><span class="eyebrow">Employee workspace</span><h1>Requests & Availability</h1></div>
      <div class="v96-segmented" role="tablist" aria-label="Requests and availability">
        <button class="${requestHubMode==='requests'?'active':''}" onclick="v96RequestHub('requests')">My requests</button>
        <button class="${requestHubMode==='availability'?'active':''}" onclick="v96RequestHub('availability')">Availability</button>
      </div>
    </div>
    <div class="v96-requesthub-body ${requestHubMode}">${body}</div>
  </section>`;
}
function v96TeamScheduleView(){
  const user=currentUser();
  const start=rosterWeekStart||getMonday(new Date());
  const days=Array.from({length:7},(_,i)=>addDays(start,i));
  const shifts=employeeTeamScheduleShifts(user);
  const total=shifts.reduce((n,s)=>n+shiftHours(s),0);
  const mine=shifts.filter(s=>shiftBelongsToUser(s,user)).length;
  return `<section class="v96-team-page apple-clean-page">
    <div class="v96-team-hero">
      <div><span class="eyebrow">Published roster</span><h1>Team Schedule</h1><p>${shortDate(start)} – ${shortDate(addDays(start,6))}</p></div>
      <div class="v96-team-summary"><span><strong>${shifts.length}</strong> shifts</span><span><strong>${total.toFixed(1)}</strong> hrs</span><span><strong>${mine}</strong> yours</span></div>
    </div>
    <div class="v96-team-toolbar">
      <div class="v96-week-switch"><button onclick="moveWeek(-7)" aria-label="Previous week">‹</button><button class="today" onclick="rosterWeekStart=getMonday(new Date());renderContent()">This week</button><button onclick="moveWeek(7)" aria-label="Next week">›</button></div>
      <button class="ghost" onclick="go('myshifts')">My shifts</button>
    </div>
    <div class="v96-team-grid">
      ${days.map(day=>{const date=isoDate(day);const rows=shifts.filter(s=>s.date===date).sort(sortShift);return `<article class="v96-team-day ${date===isoDate(new Date())?'today':''}"><header><div><strong>${dayName(day)}</strong><span>${shortDate(day)}</span></div><b>${rows.length}</b></header><div class="v96-team-day-body">${rows.length?rows.map(teamScheduleEmployeeCard).join(''):`<div class="v96-empty-day">No published shifts</div>`}</div></article>`}).join('')}
    </div>
  </section>`;
}
function v96ShowPasswordChange(user){
  modal(`<h2>Create your private password</h2><p class="muted">Your temporary password worked. Set a new password before continuing.</p>
    <label>New password</label><input id="v96-new-password" type="password" autocomplete="new-password" minlength="6" placeholder="At least 6 characters">
    <label>Confirm password</label><input id="v96-confirm-password" type="password" autocomplete="new-password" minlength="6" placeholder="Repeat password">
    <div class="actions" style="margin-top:16px"><button class="primary" onclick="v96CompletePasswordChange('${esc(user.id)}')">Save password</button></div>`);
}
function v96CompletePasswordChange(userId){
  const user=state.users.find(u=>u.id===userId);
  const password=val('v96-new-password');
  const confirmPassword=val('v96-confirm-password');
  if(!user) return toast('User account not found.');
  if(password.length<6) return toast('Use at least 6 characters.');
  if(password!==confirmPassword) return toast('Passwords do not match.');
  user.localPassword=password;
  user.tempPassword='';
  user.forcePasswordChange=false;
  user.status='active';
  user.emailVerified=true;
  user.passwordChangedAt=now();
  saveState(); closeModal();
  currentView='myshifts'; render(); toast('Password updated. Welcome to MySchedule.');
}
async function login(){
  const email=normalizeEmail(readCredentialFromInput('login-email','email'));
  const password=cleanPassword(readCredentialFromInput('login-password','password'));
  if(!isValidEmail(email)||!password) return toast('Enter your email and password.');
  v96RememberEmail(email);
  const invited=state.users.find(u=>normalizeEmail(u.email)===email&&u.status!=='removed');
  if(invited && ((invited.tempPassword&&password===invited.tempPassword)||(invited.localPassword&&password===invited.localPassword))){
    invited.lastLoginAt=now();
    if(invited.status==='invited') invited.status='active';
    saveState(); setCurrentSession(invited.id);
    if(invited.forcePasswordChange || invited.tempPassword){ render(); setTimeout(()=>v96ShowPasswordChange(invited),40); return; }
    currentView=isManagerial(invited)?'dashboard':'myshifts'; render(); toast('Signed in successfully.'); return;
  }
  try{
    const auth=requireAuth();
    await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(()=>{});
    if(auth.currentUser&&normalizeEmail(auth.currentUser.email)!==email){await auth.signOut().catch(()=>{});clearCurrentSession();}
    const cred=await auth.signInWithEmailAndPassword(email,password);
    if(!cred.user.emailVerified){await cred.user.sendEmailVerification({url:token?v133SecureLink(token):window.location.href.split('#')[0]});await auth.signOut();clearCurrentSession();return toast('Please verify your email first. A new verification link was sent.');}
    await finishAuthLogin(cred.user);
  }catch(e){console.warn(e);toast(firebaseErrorMessage(e));}
}
function saveUser(){
  const b=business(); const name=val('u-name'); const inviteEmail=normalizeEmail(val('u-email')); const role=val('u-role');
  if(!name||!inviteEmail) return toast('Name and email required.');
  if(!isValidEmail(inviteEmail)) return toast('Enter a valid email address.');
  if(state.users.some(u=>normalizeEmail(u.email)===inviteEmail&&u.status!=='removed')) return toast('Email already exists.');
  const id=uuid(); const tempPassword=v96GenerateTempPassword();
  state.users.push({id,businessId:b.id,name,email:inviteEmail,role,status:'invited',notifyEmail:true,notifyInApp:true,emailVerified:true,tempPassword,forcePasswordChange:true,createdAt:now()});
  if(role==='employee') state.employees.push({id,businessId:b.id,userId:id,employmentType:val('u-type'),visaTracking:true,fortnightLimit:Number(val('u-fortnight'))||48,weeklyLimit:Number(val('u-weekly'))||30,preferredHours:20,roleLabel:val('u-duty'),status:'active'});
  saveState();
  const loginUrl=window.location.href.split('#')[0];
  notifyUser(id,'invite','Your MySchedule workplace access',`Hi ${name}, you have been invited to ${b.name}. Sign in at ${loginUrl} with ${inviteEmail} and temporary password ${tempPassword}. You will be asked to create a new password immediately.`,{forceToEmail:inviteEmail,recipientSource:'invite_box',templateType:'invite',loginUrl,tempPassword});
  notifyRole(['owner','manager'],'invite','New user added',`${name} was added as ${role}. Temporary access was sent to ${inviteEmail}.`);
  closeModal(); renderContent(); showCredentialModal({id,name,email:inviteEmail,role,businessName:b.name,tempPassword});
  toast('User added. Temporary sign-in details were created.');
}
function showCredentialModal(data){
  modal(`<h3>Temporary access created</h3><div class="credential-card"><div class="cred-logo">MS</div><div><p class="muted">Share these one-time sign-in details securely.</p><h2>${esc(data.name)}</h2></div><div class="cred-row"><span>Business</span><strong>${esc(data.businessName)}</strong></div><div class="cred-row"><span>Role</span><strong>${esc(data.role)}</strong></div><div class="cred-row"><span>Email</span><strong>${esc(data.email)}</strong></div><div class="cred-row"><span>Temporary password</span><strong>${esc(data.tempPassword||state.users.find(u=>u.id===data.id)?.tempPassword||'')}</strong></div><div class="cred-row"><span>Login URL</span><strong>${esc(window.location.href.split('#')[0])}</strong></div><p class="small muted">The temporary password expires after the user creates a private password on first sign-in.</p><div class="actions" style="margin-top:14px"><button class="primary" onclick="copyInviteInfo('${esc(data.id||'')}')">Copy access info</button><button onclick="closeModal()">Close</button></div></div>`);
}
function resendInvite(userId){
  const u=state.users.find(x=>x.id===userId); if(!u) return;
  if(!u.tempPassword){u.tempPassword=v96GenerateTempPassword();u.forcePasswordChange=true;}
  const loginUrl=window.location.href.split('#')[0];
  notifyUser(u.id,'invite','MySchedule temporary access',`Hi ${u.name}, sign in at ${loginUrl} with ${u.email} and temporary password ${u.tempPassword}. You will be asked to create a new password immediately.`,{forceToEmail:u.email,recipientSource:'resend_invite_user_profile',templateType:'invite',loginUrl,tempPassword:u.tempPassword});
  saveState(); renderContent(); toast('Temporary access resent.');
}
function copyInviteInfo(userId){
  const u=state.users.find(x=>x.id===userId); if(!u) return toast('User not found.');
  const text=`MySchedule access\nBusiness: ${business()?.name||''}\nEmail: ${u.email}\nTemporary password: ${u.tempPassword||''}\nLogin: ${window.location.href.split('#')[0]}\nChange your password after first sign-in.`;
  navigator.clipboard?.writeText(text).then(()=>toast('Access info copied.')).catch(()=>toast('Copy failed.'));
}
function shellView(user){
  const nav=isManagerial(user)?`
    <button data-view="dashboard" onclick="go('dashboard')">Dashboard</button><button data-view="roster" onclick="go('roster')">Roster Builder</button><button data-view="employees" onclick="go('employees')">Employees</button><button data-view="credentials" onclick="go('credentials')">Team Access</button><button data-view="requests" onclick="go('requests')">Requests</button><button data-view="timesheets" onclick="go('timesheets')">Timesheets</button><button data-view="reports" onclick="go('reports')">Reports</button>${user.role==='owner'?`<button data-view="settings" onclick="go('settings')">Business Settings</button>`:''}`:`
    <button data-view="myshifts" onclick="go('myshifts')">My Shifts</button><button data-view="teamschedule" onclick="go('teamschedule')">Team Schedule</button><button data-view="requesthub" onclick="go('requesthub')">Requests & Availability</button><button data-view="clock" onclick="go('clock')">Clock In/Out</button>`;
  return `<section class="layout mobile-ready-shell role-${user.role}"><aside class="sidebar" aria-label="Workspace navigation"><nav class="nav">${nav}</nav></aside><section class="content"><div id="view"></div></section></section>`;
}
function go(view){
  closeModal();
  if(view==='availability'){requestHubMode='availability';view='requesthub';}
  else if(view==='myrequests'){requestHubMode='requests';view='requesthub';}
  currentView=view; renderContent();
}
function renderContent(){
  document.querySelectorAll('.nav button').forEach(btn=>btn.classList.toggle('active',btn.dataset.view===currentView));
  const view=el('view'); if(!view) return; const user=currentUser(); if(!user){render();return;}
  if(currentView==='profile'){view.innerHTML=profileView();return;}
  if(isManagerial(user)){
    if(currentView==='dashboard') view.innerHTML=managerDashboard();
    else if(currentView==='roster') view.innerHTML=rosterView();
    else if(currentView==='employees') view.innerHTML=employeesView();
    else if(currentView==='credentials') view.innerHTML=credentialsView();
    else if(currentView==='requests') view.innerHTML=requestsView(true);
    else if(currentView==='timesheets') view.innerHTML=timesheetsView();
    else if(currentView==='reports') view.innerHTML=reportsView();
    else if(currentView==='notifications') view.innerHTML=notificationsView();
    else if(currentView==='settings') view.innerHTML=settingsView();
    else view.innerHTML=managerDashboard();
  }else{
    if(['myshifts','mywork','myhours'].includes(currentView)) view.innerHTML=employeeWorkView();
    else if(currentView==='teamschedule') view.innerHTML=v96TeamScheduleView();
    else if(['requesthub','availability','myrequests'].includes(currentView)) view.innerHTML=employeeRequestsAvailabilityView();
    else if(currentView==='clock') view.innerHTML=clockView();
    else if(currentView==='notifications') view.innerHTML=notificationsView();
    else view.innerHTML=employeeWorkView();
  }
}
window.v96RequestHub=v96RequestHub; window.v96CompletePasswordChange=v96CompletePasswordChange;

/* v97: dynamic team access, reliable account actions, explicit copy preview, dated team weeks */
function v97WeekRangeLabel(start){
  const s = start || rosterWeekStart || getMonday(new Date());
  const e = addDays(s,6);
  const current = getMonday(new Date());
  const isCurrent = isoDate(s) === isoDate(current);
  return `${isCurrent ? 'This week · ' : ''}${shortDate(s)} – ${shortDate(e)}`;
}

function v97TeamAccessStatus(u){
  if(u.status === 'removed') return {label:'Removed', cls:'muted'};
  if(u.status === 'inactive') return {label:'Paused', cls:'warn'};
  if(u.forcePasswordChange || u.status === 'invited') return {label:'Invite pending', cls:'warn'};
  if(u.emailVerified) return {label:'Active', cls:'good'};
  return {label:'Setup pending', cls:'warn'};
}

function credentialsView(){
  const b = business();
  const users = state.users
    .filter(u => u.businessId === b.id && u.status !== 'removed')
    .sort((a,b)=>({owner:0,manager:1,employee:2}[a.role]??9)-({owner:0,manager:1,employee:2}[b.role]??9) || a.name.localeCompare(b.name));
  const active = users.filter(u=>u.status==='active').length;
  const pending = users.filter(u=>u.status==='invited' || u.forcePasswordChange).length;
  const managers = users.filter(u=>u.role==='manager').length;
  return `<section class="apple-clean-page v97-team-access">
    <div class="v97-access-hero">
      <div><span class="eyebrow">Workspace access</span><h1>Team Access</h1><p>Invite, pause, reset, edit or remove access without losing historical roster records.</p></div>
      <button class="primary" onclick="openUserModal()">Add team member</button>
    </div>
    <div class="v97-access-summary">
      <button onclick="v97FilterTeamAccess('all')"><strong>${users.length}</strong><span>Total</span></button>
      <button onclick="v97FilterTeamAccess('active')"><strong>${active}</strong><span>Active</span></button>
      <button onclick="v97FilterTeamAccess('pending')"><strong>${pending}</strong><span>Pending</span></button>
      <button onclick="v97FilterTeamAccess('manager')"><strong>${managers}</strong><span>Managers</span></button>
    </div>
    <div class="v97-access-grid" id="v97-access-grid">${users.map(v97TeamAccessCard).join('')}</div>
  </section>`;
}

function v97TeamAccessCard(u){
  const status = v97TeamAccessStatus(u);
  const initials = (u.name||u.email||'?').split(/\s+/).map(x=>x[0]).join('').slice(0,2).toUpperCase();
  const isSelf = currentUser()?.id === u.id;
  return `<article class="v97-access-card" data-role="${esc(u.role)}" data-status="${esc(u.status||'active')}" data-pending="${u.forcePasswordChange||u.status==='invited'?'true':'false'}">
    <div class="v97-access-card-top"><span class="v97-avatar">${esc(initials)}</span><span class="badge ${status.cls}">${esc(status.label)}</span></div>
    <div class="v97-access-person"><h3>${esc(u.name)}</h3><p>${esc(u.email)}</p></div>
    <div class="v97-access-meta"><span>${esc(u.role)}</span><span>${u.hireDate ? `Hired ${friendlyDate(u.hireDate)}` : 'Hire date not set'}</span><span>${u.lastLoginAt ? `Last login ${dateTime(u.lastLoginAt)}` : 'Not signed in yet'}</span></div>
    <div class="v97-access-actions">
      <button class="primary" onclick="v97ManageUser('${u.id}')">Manage</button>
      <button onclick="v97PreviewAccessInfo('${u.id}')">View & copy</button>
      ${u.role!=='owner'?`<button onclick="resendInvite('${u.id}')">Resend invite</button>`:''}
      <button onclick="sendPasswordResetForUser('${u.id}')">Reset access</button>
      ${u.role!=='owner'&&!isSelf?`<button class="danger-text" onclick="v97RemoveUser('${u.id}')">Remove</button>`:''}
    </div>
  </article>`;
}

function v97FilterTeamAccess(mode){
  document.querySelectorAll('.v97-access-summary button').forEach(b=>b.classList.remove('active'));
  event?.currentTarget?.classList.add('active');
  document.querySelectorAll('.v97-access-card').forEach(card=>{
    let show = mode==='all';
    if(mode==='active') show = card.dataset.status==='active';
    if(mode==='pending') show = card.dataset.pending==='true';
    if(mode==='manager') show = card.dataset.role==='manager';
    card.hidden = !show;
  });
}

function v97ManageUser(userId){
  const u=state.users.find(x=>x.id===userId); if(!u) return;
  const self=currentUser()?.id===u.id;
  modal(`<div class="v97-manage-modal"><span class="eyebrow">Team access</span><h2>Manage ${esc(u.name)}</h2>
    <div class="v97-manage-grid">
      <label>Name<input id="v97-manage-name" value="${escAttr(u.name||'')}"></label>
      <label>Role<select id="v97-manage-role" ${u.role==='owner'?'disabled':''}><option value="employee" ${u.role==='employee'?'selected':''}>Employee</option><option value="manager" ${u.role==='manager'?'selected':''}>Manager</option><option value="owner" ${u.role==='owner'?'selected':''}>Owner</option></select></label>
      <label>Status<select id="v97-manage-status" ${u.role==='owner'?'disabled':''}><option value="active" ${u.status==='active'?'selected':''}>Active</option><option value="inactive" ${u.status==='inactive'?'selected':''}>Paused</option><option value="invited" ${u.status==='invited'?'selected':''}>Invite pending</option></select></label>
      <label>Hire date<input id="v97-manage-hire-date" type="date" value="${escAttr(u.hireDate || (u.createdAt ? isoDate(new Date(u.createdAt)) : isoDate(new Date())))}"></label>
      <label>Email<input value="${escAttr(u.email||'')}" disabled></label>
    </div>
    <div class="v97-manage-actions"><button class="primary" onclick="v97SaveManagedUser('${u.id}')">Save changes</button><button onclick="v97PreviewAccessInfo('${u.id}')">View access details</button><button onclick="resendInvite('${u.id}')">Resend invite</button><button onclick="sendPasswordResetForUser('${u.id}')">Reset access</button>${u.role!=='owner'&&!self?`<button class="danger-text" onclick="v97RemoveUser('${u.id}')">Remove user</button>`:''}<button onclick="closeModal()">Close</button></div>
  </div>`);
}

function v97SaveManagedUser(userId){
  const u=state.users.find(x=>x.id===userId); if(!u) return;
  const name=val('v97-manage-name').trim(); if(!name) return toast('Enter a name.');
  u.name=name;
  const hireDate = val('v97-manage-hire-date');
  if(hireDate && /^\d{4}-\d{2}-\d{2}$/.test(hireDate)) u.hireDate = hireDate;
  if(u.role!=='owner'){
    u.role=val('v97-manage-role');
    u.status=val('v97-manage-status');
    const employee=state.employees.find(e=>e.userId===u.id||e.id===u.id);
    if(employee){ employee.status=u.status==='active'?'active':'inactive'; employee.hireDate=u.hireDate || employee.hireDate; }
  }
  saveState(); closeModal(); renderContent(); toast('Team access updated.');
}

function v97RemoveUser(userId){
  const u=state.users.find(x=>x.id===userId); if(!u||u.role==='owner'||currentUser()?.id===u.id) return toast('This account cannot be removed.');
  const futureShifts=state.shifts.filter(s=>s.employeeId===u.id && s.date>=isoDate(new Date())).length;
  modal(`<h2>Remove ${esc(u.name)}?</h2><p>This removes sign-in access but keeps historical shifts, requests and timesheets for reporting.</p>${futureShifts?`<div class="notice warn">${futureShifts} current or future shift${futureShifts===1?'':'s'} will remain assigned for manager review.</div>`:''}<div class="actions"><button class="danger" onclick="v97ConfirmRemoveUser('${u.id}')">Remove access</button><button onclick="closeModal()">Cancel</button></div>`);
}
function v97ConfirmRemoveUser(userId){
  const u=state.users.find(x=>x.id===userId); if(!u) return;
  u.status='removed';u.removedAt=now();u.tempPassword='';u.forcePasswordChange=false;
  const employee=state.employees.find(e=>e.userId===u.id||e.id===u.id); if(employee) employee.status='removed';
  saveState();closeModal();renderContent();toast(`${u.name} was removed. Historical records were kept.`);
}

function v97AccessPayload(u){
  return {
    business: business()?.name||'',
    role: u.role||'',
    name: u.name||'',
    email: u.email||'',
    tempPassword: u.tempPassword||'',
    loginUrl: window.location.href.split('#')[0]
  };
}
function v97AccessText(u){
  const p=v97AccessPayload(u);
  return `MySchedule access\nBusiness: ${p.business}\nName: ${p.name}\nRole: ${p.role}\nEmail: ${p.email}${p.tempPassword?`\nTemporary password: ${p.tempPassword}`:''}\nLogin: ${p.loginUrl}${p.tempPassword?'\nChange the temporary password after first sign-in.':'\nUse Forgot password if access needs to be reset.'}`;
}
function v97PreviewAccessInfo(userId){
  const u=state.users.find(x=>x.id===userId); if(!u) return toast('User not found.');
  const p=v97AccessPayload(u);
  modal(`<div class="v97-copy-modal"><span class="eyebrow">Exact copy preview</span><h2>Access details for ${esc(u.name)}</h2><p class="muted">Only the details shown below will be copied.</p><div class="credential-card"><div class="cred-row"><span>Business</span><strong>${esc(p.business)}</strong></div><div class="cred-row"><span>Role</span><strong>${esc(p.role)}</strong></div><div class="cred-row"><span>Email</span><strong>${esc(p.email)}</strong></div>${p.tempPassword?`<div class="cred-row"><span>Temporary password</span><strong>${esc(p.tempPassword)}</strong></div>`:''}<div class="cred-row"><span>Login</span><strong>${esc(p.loginUrl)}</strong></div></div><div class="actions"><button class="primary" onclick="copyInviteInfo('${u.id}')">Copy these details</button><button onclick="v97CopyField('${escAttr(p.email)}','Email copied')">Copy email</button>${p.tempPassword?`<button onclick="v97CopyField('${escAttr(p.tempPassword)}','Temporary password copied')">Copy password</button>`:''}<button onclick="closeModal()">Close</button></div></div>`);
}
function v97CopyField(text,message){
  navigator.clipboard?.writeText(text).then(()=>toast(message)).catch(()=>{prompt('Copy this value:',text);});
}
function copyInviteInfo(userId){
  const u=state.users.find(x=>x.id===userId); if(!u) return toast('User not found.');
  const text=v97AccessText(u);
  navigator.clipboard?.writeText(text).then(()=>toast('The displayed access details were copied.')).catch(()=>{prompt('Copy access details:',text);});
}

function v97DeliveryStatusModal(u,title,body){
  const enabled=!!state.emailConfig?.enabled;
  modal(`<span class="eyebrow">Account delivery</span><h2>${esc(title)}</h2><div class="notice ${enabled?'oknotice':'warn'}">${enabled?'Email delivery was requested through the configured email service.':'Email sending is currently paused. The account message was saved in MySchedule; use Copy message to share it securely.'}</div><div class="v97-message-preview"><strong>To: ${esc(u.email)}</strong><p>${esc(body).replace(/\n/g,'<br>')}</p></div><div class="actions"><button class="primary" onclick="v97CopyField(${JSON.stringify(body)},'Account message copied')">Copy message</button><button onclick="v97PreviewAccessInfo('${u.id}')">View access details</button><button onclick="closeModal()">Close</button></div>`);
}

function resendInvite(userId){
  const u=state.users.find(x=>x.id===userId); if(!u) return;
  if(!u.tempPassword){u.tempPassword=v96GenerateTempPassword();u.forcePasswordChange=true;}
  if(u.status==='inactive') u.status='invited';
  const loginUrl=window.location.href.split('#')[0];
  const body=`Hi ${u.name},\n\nYou have access to ${business()?.name||'your workplace'} in MySchedule.\nEmail: ${u.email}\nTemporary password: ${u.tempPassword}\nLogin: ${loginUrl}\n\nYou will be asked to create a private password after signing in.`;
  notifyUser(u.id,'invite','MySchedule temporary access',body,{forceToEmail:u.email,recipientSource:'resend_invite_user_profile',templateType:'invite',loginUrl,tempPassword:u.tempPassword});
  u.inviteResentAt=now();saveState();renderContent();v97DeliveryStatusModal(u,'Invitation prepared',body);
}

async function sendPasswordResetForUser(userId){
  const u=state.users.find(x=>x.id===userId); if(!u) return;
  const email=normalizeEmail(u.email);
  let firebaseSent=false;
  try{
    const auth=requireAuth();
    await auth.sendPasswordResetEmail(email); // no continue URL: avoids unauthorized-domain/action-code errors
    firebaseSent=true;
  }catch(e){ console.warn('Firebase reset unavailable; using temporary access fallback.',e); }
  if(firebaseSent){
    const body=`A secure password reset link was requested for ${email}. Check inbox and spam.`;
    notifyUser(u.id,'login','Password reset requested',body,{forceToEmail:email,recipientSource:'password_reset'});
    v97DeliveryStatusModal(u,'Reset link requested',body);
    return;
  }
  u.tempPassword=v96GenerateTempPassword();u.forcePasswordChange=true;u.status='invited';u.resetCreatedAt=now();saveState();
  const body=`Firebase reset email was unavailable, so a new one-time password was created.\nEmail: ${email}\nTemporary password: ${u.tempPassword}\nLogin: ${window.location.href.split('#')[0]}\nChange the password immediately after signing in.`;
  notifyUser(u.id,'login','Temporary password created',body,{forceToEmail:email,recipientSource:'password_reset_fallback',templateType:'invite',tempPassword:u.tempPassword,loginUrl:window.location.href.split('#')[0]});
  renderContent();v97DeliveryStatusModal(u,'Temporary reset access created',body);
}

async function forgotPassword(){
  const email=normalizeEmail(val('reset-email')||val('login-email'));
  if(!isValidEmail(email)) return toast('Enter your email first.');
  const local=state.users.find(u=>normalizeEmail(u.email)===email&&u.status!=='removed');
  try{
    const auth=requireAuth();
    await auth.sendPasswordResetEmail(email);
    toast('Password reset link requested. Check your inbox and spam folder.');
  }catch(e){
    console.warn('Firebase password reset unavailable.',e);
    if(local){
      local.tempPassword=v96GenerateTempPassword();local.forcePasswordChange=true;local.status='invited';saveState();
      modal(`<h2>Temporary access created</h2><p>The email reset service is unavailable, so a one-time password was created for this account.</p><div class="credential-card"><div class="cred-row"><span>Email</span><strong>${esc(email)}</strong></div><div class="cred-row"><span>Temporary password</span><strong>${esc(local.tempPassword)}</strong></div></div><div class="actions"><button class="primary" onclick="v97CopyField('${escAttr(local.tempPassword)}','Temporary password copied')">Copy password</button><button onclick="closeModal()">Close</button></div>`);
    }else toast('Reset service is unavailable for this account. Contact your manager.');
  }
}

function v96TeamScheduleView(){
  const user=currentUser();
  const start=rosterWeekStart||getMonday(new Date());
  const days=Array.from({length:7},(_,i)=>addDays(start,i));
  const shifts=employeeTeamScheduleShifts(user);
  const total=shifts.reduce((n,s)=>n+shiftHours(s),0);
  const mine=shifts.filter(s=>shiftBelongsToUser(s,user)).length;
  return `<section class="v96-team-page v97-team-page apple-clean-page">
    <div class="v96-team-hero"><div><span class="eyebrow">Published roster</span><h1>Team Schedule</h1><p>${shortDate(start)} – ${shortDate(addDays(start,6))}</p></div><div class="v96-team-summary"><span><strong>${shifts.length}</strong> shifts</span><span><strong>${total.toFixed(1)}</strong> hrs</span><span><strong>${mine}</strong> yours</span></div></div>
    <div class="v96-team-toolbar"><div class="v96-week-switch"><button onclick="moveWeek(-7)" aria-label="Previous week">‹</button><button class="today v97-week-label" onclick="rosterWeekStart=getMonday(new Date());renderContent()">${esc(v97WeekRangeLabel(start))}</button><button onclick="moveWeek(7)" aria-label="Next week">›</button></div><button class="ghost" onclick="go('myshifts')">My shifts</button></div>
    <div class="v96-team-grid">${days.map(day=>{const date=isoDate(day);const rows=shifts.filter(s=>s.date===date).sort(sortShift);return `<article class="v96-team-day ${date===isoDate(new Date())?'today':''}"><header><div><strong>${dayName(day)}</strong><span>${shortDate(day)}</span></div><b>${rows.length}</b></header><div class="v96-team-day-body">${rows.length?rows.map(teamScheduleEmployeeCard).join(''):`<div class="v96-empty-day">No published shifts</div>`}</div></article>`}).join('')}</div>
  </section>`;
}

window.v97ManageUser=v97ManageUser;window.v97SaveManagedUser=v97SaveManagedUser;window.v97RemoveUser=v97RemoveUser;window.v97ConfirmRemoveUser=v97ConfirmRemoveUser;window.v97PreviewAccessInfo=v97PreviewAccessInfo;window.v97CopyField=v97CopyField;window.v97FilterTeamAccess=v97FilterTeamAccess;

/* v98: unified compact Team tab + Google Places business/category integration */
(function(){
  const baseGo = go;
  go = function(view){
    return baseGo(view === 'employees' ? 'credentials' : view);
  };

  const baseRenderContentV98 = renderContent;
  renderContent = function(){
    if(currentView === 'employees') currentView = 'credentials';
    baseRenderContentV98();
    requestAnimationFrame(()=>{
      document.querySelectorAll('button[data-view="credentials"]').forEach(btn=>btn.textContent='Team');
      document.querySelectorAll('button[data-view="employees"]').forEach(btn=>btn.remove());
      const title=document.querySelector('.v97-access-hero h1'); if(title) title.textContent='Team';
      const copy=document.querySelector('.v97-access-hero p'); if(copy) copy.textContent='Invite and manage people, access, roles and account status in one place.';
    });
  };

  window.MYSCHEDULE_GOOGLE_MAPS_API_KEY = window.MYSCHEDULE_GOOGLE_MAPS_API_KEY || '';
  let googlePlacesReadyPromise = null;
  function googlePlacesKey(){
    try{return window.MYSCHEDULE_GOOGLE_MAPS_API_KEY || localStorage.getItem('myscheduleGooglePlacesKey') || '';}catch(e){return window.MYSCHEDULE_GOOGLE_MAPS_API_KEY || '';}
  }
  function loadGooglePlaces(){
    const key=googlePlacesKey();
    if(!key) return Promise.resolve(false);
    if(window.google?.maps?.importLibrary) return Promise.resolve(true);
    if(googlePlacesReadyPromise) return googlePlacesReadyPromise;
    googlePlacesReadyPromise=new Promise(resolve=>{
      const cb='myscheduleGooglePlacesReady_'+Date.now();
      window[cb]=()=>{delete window[cb];resolve(true)};
      const s=document.createElement('script');
      s.src=`https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(key)}&libraries=places&v=weekly&callback=${cb}`;
      s.async=true;s.defer=true;
      s.onerror=()=>resolve(false);
      document.head.appendChild(s);
    });
    return googlePlacesReadyPromise;
  }
  const GOOGLE_TYPE_TO_INDUSTRY={
    restaurant:'Restaurant',cafe:'Café',coffee_shop:'Café',bakery:'Café',bar:'Hospitality',night_club:'Hospitality',
    fast_food_restaurant:'Fast food',meal_takeaway:'Fast food',meal_delivery:'Fast food',
    supermarket:'Grocery',grocery_store:'Grocery',convenience_store:'Grocery',food_store:'Grocery',
    store:'Retail',shopping_mall:'Retail',clothing_store:'Retail',department_store:'Retail',electronics_store:'Retail',
    lodging:'Hospitality',hotel:'Hospitality',motel:'Hospitality',hostel:'Hospitality',
    hospital:'Healthcare',doctor:'Healthcare',medical_clinic:'Healthcare',dentist:'Healthcare',pharmacy:'Healthcare',
    laundry:'Cleaning',cleaning_service:'Cleaning'
  };
  function industryFromGoogleTypes(primaryType,types=[]){
    const all=[primaryType,...types].filter(Boolean);
    for(const t of all){ if(GOOGLE_TYPE_TO_INDUSTRY[t]) return GOOGLE_TYPE_TO_INDUSTRY[t]; }
    return normaliseSuggestedIndustry(all.join(' '));
  }
  async function googleBusinessSuggestions(query){
    if(!query || query.length<2 || !(await loadGooglePlaces())) return [];
    try{
      const {AutocompleteSuggestion,AutocompleteSessionToken}=await google.maps.importLibrary('places');
      const token=new AutocompleteSessionToken();
      const request={input:query,sessionToken:token,includedPrimaryTypes:['establishment']};
      const result=await AutocompleteSuggestion.fetchAutocompleteSuggestions(request);
      const list=[];
      for(const suggestion of (result.suggestions||[]).slice(0,7)){
        const pred=suggestion.placePrediction;
        if(!pred) continue;
        let name=pred.mainText?.text || pred.text?.text || '';
        let industry='Other', type='Google business';
        try{
          const place=pred.toPlace();
          await place.fetchFields({fields:['displayName','primaryType','types']});
          name=place.displayName || name;
          industry=industryFromGoogleTypes(place.primaryType,place.types||[]);
          type=place.primaryType || 'Google business';
        }catch(e){
          industry=normaliseSuggestedIndustry(pred.types?.join(' ')||name);
        }
        if(name) list.push({name,industry,type,source:'google'});
      }
      return list;
    }catch(e){ console.warn('Google Places suggestions unavailable',e); return []; }
  }

  const baseUpdateBusinessSuggestionsV98 = updateBusinessNameSuggestions;
  let v98BusinessTimer=0;
  updateBusinessNameSuggestions = function(){
    baseUpdateBusinessSuggestionsV98();
    clearTimeout(v98BusinessTimer);
    const raw=(el('signup-business-name')?.value||'').trim();
    if(raw.length<2) return;
    v98BusinessTimer=setTimeout(async()=>{
      const googleRows=await googleBusinessSuggestions(raw);
      if(!googleRows.length) return;
      if((el('signup-business-name')?.value||'').trim()!==raw) return;
      renderBusinessSuggestionList(googleRows);
    },220);
  };

  const baseSelectBusinessSuggestionV98=selectBusinessSuggestion;
  selectBusinessSuggestion=function(name,industry){
    const mapped=INDUSTRY_OPTIONS.includes(industry)?industry:normaliseSuggestedIndustry(industry);
    baseSelectBusinessSuggestionV98(name,mapped);
    const industryInput=el('signup-industry');
    if(industryInput){
      industryInput.value=INDUSTRY_OPTIONS.includes(mapped)?mapped:'Other';
      industryInput.dispatchEvent(new Event('change',{bubbles:true}));
    }
    businessIndustryManualOverride=false;
    updateIndustryOtherField();
  };
})();

/* v99: authentication redirect hardening, role permissions and project-wide QA guards */
const V99_ROLE_VIEWS = {
  owner: ['dashboard','roster','credentials','requests','timesheets','reports','settings','notifications','profile'],
  manager: ['dashboard','roster','credentials','requests','timesheets','reports','notifications','profile'],
  employee: ['myshifts','mywork','myhours','teamschedule','requesthub','availability','myrequests','clock','notifications','profile']
};
function v99RoleHome(user=currentUser()){
  if(!user) return 'dashboard';
  return user.role === 'employee' ? 'myshifts' : 'dashboard';
}
function v99CanAccessView(user, view){
  const role = user?.role || 'employee';
  const normalized = view === 'employees' ? 'credentials' : view;
  return (V99_ROLE_VIEWS[role] || V99_ROLE_VIEWS.employee).includes(normalized);
}
function v99EnterWorkspace(user, message='Signed in successfully.'){
  if(!user) return false;
  setCurrentSession(user.id);
  currentView = requestedEmailViewForUser(user) || v99RoleHome(user);
  try{
    history.replaceState(null,'',`${location.pathname}${location.search}#${currentView}`);
  }catch(e){}
  render();
  requestAnimationFrame(()=>{
    const app = el('app');
    if(app && !app.querySelector('.layout')) render();
    window.scrollTo({top:0,behavior:'auto'});
  });
  if(message) toast(message);
  return true;
}

async function finishAuthLogin(authUser){
  const email = normalizeEmail(authUser?.email || '');
  let user = state.users.find(u=>u.authUid===authUser.uid && u.status!=='removed') ||
             state.users.find(u=>normalizeEmail(u.email)===email && u.status!=='removed');
  if(!user){
    try{ await firebaseAuth.signOut(); }catch(e){}
    clearCurrentSession();
    toast('This login is valid, but it is not linked to a MySchedule workplace. Ask the owner to invite this exact email.');
    return false;
  }
  if(user.authUid && user.authUid !== authUser.uid){
    try{ await firebaseAuth.signOut(); }catch(e){}
    clearCurrentSession();
    toast('This workplace profile is linked to another login. Ask the owner to reset your access.');
    return false;
  }
  user.authUid = authUser.uid;
  user.status = 'active';
  user.emailVerified = true;
  user.lastLoginAt = now();
  user.forcePasswordChange = false;
  user.tempPassword = '';
  delete user.password;
  saveState();
  return v99EnterWorkspace(user);
}

async function login(){
  const email=normalizeEmail(readCredentialFromInput('login-email','email'));
  const password=cleanPassword(readCredentialFromInput('login-password','password'));
  if(!isValidEmail(email)||!password) return toast('Enter your email and password.');
  v96RememberEmail?.(email);
  const localUser=state.users.find(u=>normalizeEmail(u.email)===email&&u.status!=='removed');
  if(localUser && ((localUser.tempPassword&&password===localUser.tempPassword)||(localUser.localPassword&&password===localUser.localPassword))){
    localUser.lastLoginAt=now();
    if(localUser.status==='inactive') return toast('This account is paused. Contact your owner or manager.');
    if(localUser.status==='invited') localUser.status='active';
    saveState();
    setCurrentSession(localUser.id);
    if(localUser.forcePasswordChange || localUser.tempPassword){
      render();
      setTimeout(()=>v96ShowPasswordChange(localUser),30);
      return;
    }
    return v99EnterWorkspace(localUser);
  }
  try{
    const auth=requireAuth();
    await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(()=>{});
    if(auth.currentUser&&normalizeEmail(auth.currentUser.email)!==email){
      await auth.signOut().catch(()=>{});
      clearCurrentSession();
    }
    const cred=await auth.signInWithEmailAndPassword(email,password);
    if(!cred.user.emailVerified){
      await cred.user.sendEmailVerification({url:window.location.href.split('#')[0]}).catch(()=>{});
      await auth.signOut().catch(()=>{});
      clearCurrentSession();
      return toast('Please verify your email first. A new verification email was requested.');
    }
    await finishAuthLogin(cred.user);
  }catch(e){
    console.warn('v99 login failed',e);
    toast(firebaseErrorMessage(e));
  }
}

function v96CompletePasswordChange(userId){
  const user=state.users.find(u=>u.id===userId);
  const password=val('v96-new-password');
  const confirmPassword=val('v96-confirm-password');
  if(!user) return toast('User account not found.');
  if(password.length<6) return toast('Use at least 6 characters.');
  if(password!==confirmPassword) return toast('Passwords do not match.');
  user.localPassword=password;
  user.tempPassword='';
  user.forcePasswordChange=false;
  user.status='active';
  user.emailVerified=true;
  user.passwordChangedAt=now();
  saveState();
  closeModal();
  v99EnterWorkspace(user,'Password updated. You are now signed in.');
}

function shellView(user){
  const ownerNav=`<button data-view="dashboard" onclick="go('dashboard')">Dashboard</button><button data-view="roster" onclick="go('roster')">Roster Builder</button><button data-view="credentials" onclick="go('credentials')">Team</button><button data-view="requests" onclick="go('requests')">Requests</button><button data-view="timesheets" onclick="go('timesheets')">Timesheets</button><button data-view="reports" onclick="go('reports')">Reports</button><button data-view="settings" onclick="go('settings')">Business Settings</button>`;
  const managerNav=`<button data-view="dashboard" onclick="go('dashboard')">Dashboard</button><button data-view="roster" onclick="go('roster')">Roster Builder</button><button data-view="credentials" onclick="go('credentials')">Team</button><button data-view="requests" onclick="go('requests')">Requests</button><button data-view="timesheets" onclick="go('timesheets')">Timesheets</button><button data-view="reports" onclick="go('reports')">Reports</button>`;
  const employeeNav=`<button data-view="myshifts" onclick="go('myshifts')">My Shifts</button><button data-view="teamschedule" onclick="go('teamschedule')">Team Schedule</button><button data-view="requesthub" onclick="go('requesthub')">Requests & Availability</button><button data-view="clock" onclick="go('clock')">Clock In/Out</button>`;
  const nav=user.role==='owner'?ownerNav:user.role==='manager'?managerNav:employeeNav;
  return `<section class="layout mobile-ready-shell role-${esc(user.role)}"><aside class="sidebar" aria-label="Workspace navigation"><nav class="nav">${nav}</nav></aside><section class="content"><div id="view"></div></section></section>`;
}

function go(view){
  closeModal();
  if(view==='employees') view='credentials';
  if(view==='availability'){requestHubMode='availability';view='requesthub';}
  else if(view==='myrequests'){requestHubMode='requests';view='requesthub';}
  const user=currentUser();
  if(user && !v99CanAccessView(user,view)){
    currentView=v99RoleHome(user);
    toast('That area is not available for your role.');
  }else currentView=view;
  try{ history.replaceState(null,'',`${location.pathname}${location.search}#${currentView}`); }catch(e){}
  renderContent();
  requestAnimationFrame(()=>window.scrollTo({top:0,behavior:'auto'}));
}

const v99BaseRenderContent=renderContent;
renderContent=function(){
  const user=currentUser();
  if(user && !v99CanAccessView(user,currentView)) currentView=v99RoleHome(user);
  v99BaseRenderContent();
};

function v99NormalizeProjectData(){
  const validRoles=new Set(['owner','manager','employee']);
  const seenEmails=new Set();
  state.users.forEach(u=>{
    u.email=normalizeEmail(u.email||'');
    if(!validRoles.has(u.role)) u.role='employee';
    if(!u.status) u.status='active';
    if(!state.businesses.some(b=>b.id===u.businessId) && state.businesses[0]) u.businessId=state.businesses[0].id;
    const key=`${u.businessId}|${u.email}`;
    if(u.status!=='removed' && seenEmails.has(key)) u.status='removed';
    else if(u.status!=='removed') seenEmails.add(key);
  });
  state.employees.forEach(e=>{
    const user=state.users.find(u=>u.id===e.userId||u.id===e.id);
    if(user){e.userId=user.id;e.businessId=user.businessId;}
  });
  state.shifts.forEach(s=>{
    if(!s.status) s.status='draft';
    if(!s.businessId && state.businesses[0]) s.businessId=state.businesses[0].id;
  });
  saveState();
}
try{v99NormalizeProjectData();}catch(e){console.warn('v99 data QA normalization skipped',e);}

window.v99EnterWorkspace=v99EnterWorkspace;

/* v101: mobile session stability and Requests & Availability routing QA */
async function enforceSessionSecurity(shouldRender=true, authUserOverride){
  if(!state) return false;
  initFirebase();
  const authUser = authUserOverride !== undefined ? authUserOverride : (firebaseAuth ? firebaseAuth.currentUser : null);
  const localUser = currentUserId ? state.users.find(u=>u.id===currentUserId && u.status!=='removed') : null;

  if(localUser){
    // Invited/local-password accounts are valid app sessions even when they do not yet
    // have a Firebase Auth UID. Do not log them out when Firebase reports no user.
    if(!localUser.authUid){
      try{ sessionStorage.setItem(CURRENT_KEY, localUser.id); }catch(e){}
      return true;
    }
    // Firebase-linked accounts must match the active Firebase identity.
    if(!authUser || localUser.authUid !== authUser.uid || normalizeEmail(localUser.email) !== normalizeEmail(authUser.email)){
      clearCurrentSession();
      currentView='dashboard';
      if(shouldRender) render();
      if(authUser) toast('Session switched. Please sign in again for this workspace user.');
      return false;
    }
    try{ sessionStorage.setItem(CURRENT_KEY, localUser.id); }catch(e){}
    return true;
  }

  if(shouldRender) render();
  return false;
}

function v101SafeEmployeeRoute(target, mode){
  const user=currentUser();
  if(!user){
    // A route click must never destroy a valid stored session. Restore it once if possible.
    let stored='';
    try{ stored=sessionStorage.getItem(CURRENT_KEY)||''; }catch(e){}
    const restored=state.users.find(u=>u.id===stored && u.status!=='removed');
    if(restored){ currentUserId=restored.id; }
  }
  const active=currentUser();
  if(!active){
    toast('Your session could not be restored. Please sign in again.');
    render();
    return false;
  }
  if(mode) requestHubMode=mode;
  currentView=target;
  try{ history.replaceState(null,'',`${location.pathname}${location.search}#${currentView}`); }catch(e){}
  renderContent();
  requestAnimationFrame(()=>window.scrollTo({top:0,behavior:'auto'}));
  return true;
}

v96RequestHub=function(mode='requests'){
  return v101SafeEmployeeRoute('requesthub',mode);
};

const v101PreviousGo=go;
go=function(view){
  if(view==='availability') return v101SafeEmployeeRoute('requesthub','availability');
  if(view==='myrequests'||view==='requesthub') return v101SafeEmployeeRoute('requesthub',view==='myrequests'?'requests':requestHubMode);
  return v101PreviousGo(view);
};

window.addEventListener('pageshow',()=>{
  if(currentUserId){
    try{ sessionStorage.setItem(CURRENT_KEY,currentUserId); }catch(e){}
  }
});


/* v102: practical workforce data QA — hire dates and safe legacy normalization */
function v102NormalizeWorkforceDates(){
  let changed=false;
  state.users.forEach(u=>{
    if(!u.hireDate){
      const source=u.createdAt ? new Date(u.createdAt) : new Date();
      u.hireDate=isoDate(Number.isNaN(source.getTime())?new Date():source);
      changed=true;
    }
  });
  state.employees.forEach(e=>{
    const u=state.users.find(x=>x.id===e.userId||x.id===e.id);
    if(!e.hireDate && u?.hireDate){e.hireDate=u.hireDate;changed=true;}
  });
  if(changed) saveState();
}
try{v102NormalizeWorkforceDates();}catch(error){console.warn('Workforce date normalization skipped',error);}

/* v103: employee portal recovery — stable tabs, session persistence and mobile-safe navigation */
const V103_PERSISTED_SESSION_KEY = 'myschedule_v103_active_user';

function v103RememberActiveUser(userId){
  if(!userId) return;
  currentUserId = userId;
  try{ sessionStorage.setItem(CURRENT_KEY,userId); }catch(e){}
  try{ localStorage.setItem(V103_PERSISTED_SESSION_KEY,userId); }catch(e){}
}

function v103RestoreActiveUser(){
  let id=currentUserId||'';
  try{ id=id||sessionStorage.getItem(CURRENT_KEY)||''; }catch(e){}
  try{ id=id||localStorage.getItem(V103_PERSISTED_SESSION_KEY)||''; }catch(e){}
  const user=(state?.users||[]).find(u=>u.id===id && u.status!=='removed' && u.status!=='inactive');
  if(user){
    v103RememberActiveUser(user.id);
    return user;
  }
  return null;
}

const v103OriginalSetCurrentSession=setCurrentSession;
setCurrentSession=function(userId){
  v103OriginalSetCurrentSession(userId);
  v103RememberActiveUser(userId);
};

const v103OriginalClearCurrentSession=clearCurrentSession;
clearCurrentSession=function(){
  v103OriginalClearCurrentSession();
  try{localStorage.removeItem(V103_PERSISTED_SESSION_KEY);}catch(e){}
};

function v103NormalizeEmployeeView(view){
  if(view==='availability') return {view:'requesthub',mode:'availability'};
  if(view==='myrequests') return {view:'requesthub',mode:'requests'};
  if(view==='requesthub') return {view:'requesthub',mode:requestHubMode||'requests'};
  if(['mywork','myhours'].includes(view)) return {view:'myshifts'};
  return {view};
}

function v103RenderEmployeeView(user, requestedView){
  const target=v103NormalizeEmployeeView(requestedView||currentView);
  if(target.mode) requestHubMode=target.mode;
  currentView=target.view;
  const container=el('view');
  if(!container) return false;
  document.querySelectorAll('.nav button').forEach(btn=>btn.classList.toggle('active',btn.dataset.view===currentView));
  try{
    if(currentView==='myshifts') container.innerHTML=employeeWorkView();
    else if(currentView==='teamschedule') container.innerHTML=v96TeamScheduleView();
    else if(currentView==='requesthub') container.innerHTML=employeeRequestsAvailabilityView();
    else if(currentView==='clock') container.innerHTML=clockView();
    else if(currentView==='notifications') container.innerHTML=notificationsView();
    else if(currentView==='profile') container.innerHTML=profileView();
    else { currentView='myshifts'; container.innerHTML=employeeWorkView(); }
  }catch(error){
    console.error('Employee view render failed',currentView,error);
    container.innerHTML=`<section class="apple-clean-page v103-recovery"><div class="apple-panel"><h2>Unable to open this section</h2><p>Your session is still active. Return to My Shifts and try again.</p><button class="primary" onclick="v103EmployeeGo('myshifts')">Open My Shifts</button></div></section>`;
  }
  document.querySelectorAll('.nav button').forEach(btn=>btn.classList.toggle('active',btn.dataset.view===currentView));
  return true;
}

function v103EmployeeGo(view,mode){
  closeModal();
  let user=currentUser()||v103RestoreActiveUser();
  if(!user){
    toast('Your session expired. Please sign in again.');
    render();
    return false;
  }
  if(user.role!=='employee') return v103ManagerGo(view);
  const normalized=v103NormalizeEmployeeView(mode?view:view);
  if(mode) normalized.mode=mode;
  if(normalized.mode) requestHubMode=normalized.mode;
  currentView=normalized.view;
  v103RememberActiveUser(user.id);
  try{history.replaceState(null,'',`${location.pathname}${location.search}#${currentView}`);}catch(e){}
  v103RenderEmployeeView(user,currentView);
  requestAnimationFrame(()=>window.scrollTo({top:0,behavior:'auto'}));
  return true;
}

function v103ManagerGo(view){
  const user=currentUser()||v103RestoreActiveUser();
  if(!user){render();return false;}
  if(view==='employees') view='credentials';
  if(!v99CanAccessView(user,view)) view=v99RoleHome(user);
  currentView=view;
  v103RememberActiveUser(user.id);
  try{history.replaceState(null,'',`${location.pathname}${location.search}#${currentView}`);}catch(e){}
  v99BaseRenderContent();
  requestAnimationFrame(()=>window.scrollTo({top:0,behavior:'auto'}));
  return true;
}

go=function(view){
  const user=currentUser()||v103RestoreActiveUser();
  if(user?.role==='employee') return v103EmployeeGo(view);
  return v103ManagerGo(view);
};

v96RequestHub=function(mode='requests'){
  return v103EmployeeGo('requesthub',mode);
};

renderContent=function(){
  const user=currentUser()||v103RestoreActiveUser();
  if(!user){render();return;}
  if(user.role==='employee'){
    if(!v99CanAccessView(user,v103NormalizeEmployeeView(currentView).view)) currentView='myshifts';
    v103RenderEmployeeView(user,currentView);
    return;
  }
  if(!v99CanAccessView(user,currentView)) currentView=v99RoleHome(user);
  v99BaseRenderContent();
};

function v103InstallEmployeeNav(){
  document.removeEventListener('click',window.__v103EmployeeNavHandler,true);
  window.__v103EmployeeNavHandler=function(event){
    const button=event.target.closest('.role-employee .nav button[data-view]');
    if(!button) return;
    event.preventDefault();
    event.stopPropagation();
    v103EmployeeGo(button.dataset.view);
  };
  document.addEventListener('click',window.__v103EmployeeNavHandler,true);
}
v103InstallEmployeeNav();

window.v103EmployeeGo=v103EmployeeGo;
window.addEventListener('pageshow',()=>{
  const user=currentUser()||v103RestoreActiveUser();
  if(user) v103RememberActiveUser(user.id);
});

/* v104: simple, stable employee tab navigation and session lookup */
function currentUser(){
  if(!state || !Array.isArray(state.users)) return null;
  let id=currentUserId || '';
  try{ id=id || sessionStorage.getItem(CURRENT_KEY) || ''; }catch(e){}
  try{ id=id || localStorage.getItem(V103_PERSISTED_SESSION_KEY) || ''; }catch(e){}
  const user=state.users.find(u=>u.id===id && u.status!=='removed' && u.status!=='inactive') || null;
  if(user && currentUserId!==user.id){
    currentUserId=user.id;
    try{sessionStorage.setItem(CURRENT_KEY,user.id);}catch(e){}
  }
  return user;
}

function v104OpenView(view, mode){
  const user=currentUser();
  if(!user){
    toast('Please sign in again.');
    render();
    return false;
  }
  closeModal();
  if(view==='employees') view='credentials';
  if(view==='availability'){ mode='availability'; view='requesthub'; }
  if(view==='myrequests'){ mode='requests'; view='requesthub'; }
  if(mode) requestHubMode=mode;
  if(!v99CanAccessView(user,view)) view=v99RoleHome(user);
  currentView=view;
  try{history.replaceState(null,'',`${location.pathname}${location.search}#${currentView}`);}catch(e){}
  const app=el('app');
  if(!app || !app.querySelector('.layout')){
    render();
  }else{
    renderContent();
  }
  requestAnimationFrame(()=>window.scrollTo({top:0,behavior:'auto'}));
  return true;
}

go=function(view){ return v104OpenView(view); };
v96RequestHub=function(mode='requests'){ return v104OpenView('requesthub',mode); };
v103EmployeeGo=function(view,mode){ return v104OpenView(view,mode); };
v103ManagerGo=function(view){ return v104OpenView(view); };

// One delegated navigation command only. Prevent old stacked handlers from firing twice.
if(window.__v103EmployeeNavHandler){
  document.removeEventListener('click',window.__v103EmployeeNavHandler,true);
}
window.__v104WorkspaceNavHandler=function(event){
  const button=event.target.closest('.sidebar .nav button[data-view]');
  if(!button) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  v104OpenView(button.dataset.view);
};
document.addEventListener('click',window.__v104WorkspaceNavHandler,true);


/* v105: root session fix — employee tab changes must never trigger logout */
async function enforceSessionSecurity(shouldRender=true, authUserOverride){
  if(!state) return false;
  const localUser=currentUser();
  if(localUser){
    // Keep the app session authoritative during normal workspace navigation.
    // Firebase may briefly report null while restoring mobile/browser auth state;
    // that transient state must not clear a valid MySchedule session.
    try{sessionStorage.setItem(CURRENT_KEY,localUser.id);}catch(e){}
    try{localStorage.setItem(V103_PERSISTED_SESSION_KEY,localUser.id);}catch(e){}
    currentUserId=localUser.id;
    return true;
  }
  if(shouldRender) render();
  return false;
}

function v105RestoreWorkspaceUser(){
  if(!state||!Array.isArray(state.users)) return null;
  const candidates=[];
  if(currentUserId) candidates.push(currentUserId);
  try{const x=sessionStorage.getItem(CURRENT_KEY);if(x)candidates.push(x);}catch(e){}
  try{const x=localStorage.getItem(V103_PERSISTED_SESSION_KEY);if(x)candidates.push(x);}catch(e){}
  for(const id of candidates){
    const user=state.users.find(u=>u.id===id&&u.status!=='removed'&&u.status!=='inactive');
    if(user){
      currentUserId=user.id;
      try{sessionStorage.setItem(CURRENT_KEY,user.id);}catch(e){}
      try{localStorage.setItem(V103_PERSISTED_SESSION_KEY,user.id);}catch(e){}
      return user;
    }
  }
  return null;
}

function v105OpenWorkspaceView(view,mode){
  const user=currentUser()||v105RestoreWorkspaceUser();
  if(!user){
    toast('Your session has ended. Please sign in again.');
    render();
    return false;
  }
  closeModal();
  if(view==='employees') view='credentials';
  if(view==='availability'){mode='availability';view='requesthub';}
  if(view==='myrequests'){mode='requests';view='requesthub';}
  if(mode) requestHubMode=mode;
  if(!v99CanAccessView(user,view)) view=v99RoleHome(user);
  currentView=view;
  currentUserId=user.id;
  try{sessionStorage.setItem(CURRENT_KEY,user.id);}catch(e){}
  try{localStorage.setItem(V103_PERSISTED_SESSION_KEY,user.id);}catch(e){}
  try{history.replaceState(null,'',`${location.pathname}${location.search}#${currentView}`);}catch(e){}
  renderContent();
  requestAnimationFrame(()=>window.scrollTo({top:0,behavior:'auto'}));
  return true;
}

go=function(view){return v105OpenWorkspaceView(view);};
v96RequestHub=function(mode='requests'){return v105OpenWorkspaceView('requesthub',mode);};
v103EmployeeGo=function(view,mode){return v105OpenWorkspaceView(view,mode);};
v103ManagerGo=function(view){return v105OpenWorkspaceView(view);};

if(window.__v104WorkspaceNavHandler){
  document.removeEventListener('click',window.__v104WorkspaceNavHandler,true);
}
window.__v105WorkspaceNavHandler=function(event){
  const button=event.target.closest('.layout .nav button[data-view]');
  if(!button) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  v105OpenWorkspaceView(button.dataset.view);
};
document.addEventListener('click',window.__v105WorkspaceNavHandler,true);

window.addEventListener('pageshow',()=>{v105RestoreWorkspaceUser(); setTimeout(applyEmailDeepLinkToLogin,60);});
setTimeout(applyEmailDeepLinkToLogin,250);


/* v107 — structured roster email/inbox presentation */
function rosterNotificationData(n){
  const data = n && n.templateData ? n.templateData : {};
  const shifts = Array.isArray(data.shifts) ? data.shifts : [];
  return {
    weekStartText: data.weekStartText || "",
    weekEndText: data.weekEndText || "",
    totalShifts: Number(data.totalShifts || shifts.length || 0),
    totalHours: data.totalHours || (shifts.reduce((sum,s)=>sum + Number(s.hours || 0),0).toFixed(1)),
    shifts
  };
}
function rosterInboxCard(n){
  const data = rosterNotificationData(n);
  if(!data.shifts.length) return "";
  const rows = data.shifts.map((s,idx)=>{
    const d = dateObj(s.date);
    const day = d.toLocaleDateString(undefined,{weekday:"short"});
    const date = d.toLocaleDateString(undefined,{month:"short",day:"numeric"});
    const time = `${formatEmailShiftTime(s.start)} – ${formatEmailShiftTime(s.end)}${emailShiftCrossesMidnight(s) ? " next day" : ""}`;
    const detail = [s.role && s.role !== "Shift" ? s.role : "", s.location || "", s.notes || ""].filter(Boolean).join(" · ");
    return `<div class="roster-inbox-row ${idx % 2 ? "is-alt" : ""}">
      <div class="roster-inbox-date"><strong>${esc(day)}</strong><span>${esc(date)}</span></div>
      <div class="roster-inbox-shift"><strong>${esc(time)}</strong>${detail ? `<span>${esc(detail)}</span>` : ``}</div>
      <div class="roster-inbox-hours">${esc(s.hours || shiftHours(s).toFixed(1))}<span>hrs</span></div>
    </div>`;
  }).join("");
  return `<div class="roster-inbox-card">
    <div class="roster-inbox-head">
      <div><span class="roster-kicker">Published schedule</span><strong>${esc(data.weekStartText)} – ${esc(data.weekEndText)}</strong></div>
      <div class="roster-inbox-total"><strong>${esc(data.totalHours)}</strong><span>total hrs</span></div>
    </div>
    <div class="roster-inbox-table">${rows}</div>
    <div class="roster-inbox-summary"><span>${data.totalShifts} shift${data.totalShifts === 1 ? "" : "s"}</span><button class="tiny primary" onclick="event.stopPropagation(); go('myshifts')">View my schedule</button></div>
  </div>`;
}
function myNotificationsCards(rows){
  if(!rows.length) return `<div class="apple-empty-state qa-empty"><div class="apple-empty-icon">✓</div><h3>All clear</h3><p class="muted">No notifications in this view.</p></div>`;
  return `<div class="apple-notification-list simple-list qa-note-list">${rows.map(n => {
    const title = esc(cleanNotificationSubject(n));
    const created = n.createdAt || now();
    const roster = (n.templateType === "roster" || n.type === "roster") ? rosterInboxCard(n) : "";
    const message = roster ? "" : `<p class="apple-note-message">${esc(n.originalMessage || n.message || "")}</p>`;
    return `<article class="apple-note-card simple-note qa-note-card ${n.read ? "is-read" : "is-new"}" onclick="openNotification('${n.id}')">
      <div class="qa-note-icon">${notificationIcon(n)}</div>
      <div class="apple-note-main">
        <div class="apple-note-top"><div><h3>${title}</h3><p class="apple-note-meta">${friendlyDate(created.slice(0,10))} · ${relativeTime(created)}</p></div>${!n.read ? `<span class="ios-badge new-dot">New</span>` : ``}</div>
        ${roster || message}
        <div class="apple-note-footer simple-footer"><button class="tiny apple-link-button" onclick="event.stopPropagation(); openNotification('${n.id}')">${notificationActionLabel(n)}</button><button class="tiny apple-clear-button" onclick="event.stopPropagation(); clearNotification('${n.id}')">Clear</button></div>
      </div>
    </article>`;
  }).join("")}</div>`;
}

/* v115: practical manager request approvals + truly responsive roster email */
function requestApprovalCheck(r){
  const actor = currentUser();
  if(!actor || !isManagerial(actor)) return {ok:false, title:"Manager access required", reason:"Only an owner or manager can approve employee requests.", action:"Sign in with a manager account and open Requests again."};
  if(!r) return {ok:false, title:"Request unavailable", reason:"This request no longer exists or was already removed.", action:"Refresh the Requests page and open the latest request."};
  if(r.businessId !== actor.businessId) return {ok:false, title:"Different workplace", reason:"This request belongs to another workplace.", action:"Switch to the correct workplace before reviewing it."};
  if(r.status !== "pending") return {ok:false, title:"Already reviewed", reason:`This request is already ${r.status || "handled"}.`, action:"Open request history to review the final decision."};
  const employee = state.users.find(u => u.id === r.employeeId && u.businessId === actor.businessId && u.status !== "removed");
  if(!employee) return {ok:false, title:"Employee record unavailable", reason:"The employee is no longer active in this workplace.", action:"Review the Team record before deciding whether to close this request."};
  if(r.type === "availability"){
    const a = state.availability.find(x => x.id === r.availabilityId);
    if(!a) return {ok:false, title:"Availability details missing", reason:"The requested unavailable period cannot be found.", action:"Ask the employee to submit the availability request again."};
  }
  if(["change","swap","cover"].includes(r.type)){
    const s = state.shifts.find(x => x.id === r.shiftId);
    if(!s) return {ok:false, title:"Roster shift no longer exists", reason:"The shift linked to this request was deleted or replaced after the employee submitted it.", action:"Open the roster, confirm the current shift, then ask the employee to submit a new request if needed."};
    if(s.businessId !== actor.businessId) return {ok:false, title:"Wrong roster", reason:"The linked shift belongs to another workplace.", action:"Open the correct workplace roster before approving."};
  }
  return {ok:true};
}

function showRequestDecisionProblem(problem){
  modal(`<div class="request-decision-problem">
    <span class="eyebrow">Approval could not be completed</span>
    <h3>${esc(problem.title || "Request needs review")}</h3>
    <p>${esc(problem.reason || "The request cannot be approved in its current state.")}</p>
    <div class="request-next-step"><strong>What to do</strong><span>${esc(problem.action || "Review the request details and try again.")}</span></div>
    <div class="actions"><button class="primary" onclick="closeModal(); go('requests')">Back to requests</button><button onclick="closeModal(); go('roster')">Open roster</button></div>
  </div>`);
}

function approveRequest(id){
  const r = state.requests.find(x => x.id === id);
  const check = requestApprovalCheck(r);
  if(!check.ok){ showRequestDecisionProblem(check); return false; }
  const actor = currentUser();
  try{
    if(r.type === "change"){
      const s = state.shifts.find(x => x.id === r.shiftId);
      state.shifts = state.shifts.filter(x => x.id !== s.id);
      r.rosterAction = "removed_shift";
      r.decisionNote = "Shift removed from the active roster after manager approval.";
    }else if(r.type === "availability"){
      const a = state.availability.find(x => x.id === r.availabilityId);
      if(a.requestAction === "remove" || a.status === "pending_removal"){
        state.availability = state.availability.filter(x => x.id !== a.id);
        r.decisionNote = "Approved unavailable period was removed.";
      }else{
        a.status = "approved";
        a.requestAction = "add";
        r.decisionNote = "Unavailable period approved and added to scheduling checks.";
      }
    }else if(r.type === "swap"){
      const result = approveTwoWaySwapRequest(r);
      if(result === false) return false;
      if(r.status === "approved") return true;
      return false;
    }else if(r.type === "cover"){
      const s = state.shifts.find(x => x.id === r.shiftId);
      const targetId = r.targetEmployeeId || r.employeeId;
      const target = state.users.find(u => u.id === targetId && u.businessId === actor.businessId && u.status !== "removed");
      if(!target){ showRequestDecisionProblem({title:"Replacement employee unavailable",reason:"The selected employee cannot receive this shift.",action:"Choose another active employee from the roster."}); return false; }
      const conflict = availabilityConflict({...s,employeeId:target.id});
      if(conflict){ showRequestDecisionProblem({title:"Scheduling conflict",reason:conflict,action:"Choose another employee or adjust the shift before approving."}); return false; }
      s.employeeId = target.id;
      s.status = "published";
      r.rosterAction = "reassigned_shift";
      r.decisionNote = `Shift assigned to ${target.name}.`;
    }
    r.status = "approved";
    r.approvedAt = now();
    r.approvedBy = actor.id;
    r.rosterActionAt = r.rosterActionAt || now();
    saveState();
    notifyUser(r.employeeId,"approval","Request approved",`Your ${requestTypeLabel(r).toLowerCase()} request has been approved.${r.decisionNote ? " " + r.decisionNote : ""}`,{requestId:r.id,shiftId:r.shiftId||"",targetView:"myrequests"});
    renderContent();
    toast("Request approved and roster records updated.");
    return true;
  }catch(error){
    console.error("approveRequest",error);
    showRequestDecisionProblem({title:"Request data needs attention",reason:"The request contains incomplete or outdated roster information.",action:"Open the roster, confirm the employee and shift details, then try the approval again."});
    return false;
  }
}

function rejectRequest(id){
  const r = state.requests.find(x => x.id === id);
  const check = requestApprovalCheck(r);
  if(!check.ok){ showRequestDecisionProblem(check); return false; }
  if(r.type === "availability"){
    const a = state.availability.find(x => x.id === r.availabilityId);
    if(a){
      if(a.status === "pending") a.status = "rejected";
      else if(a.status === "pending_removal") a.status = "approved";
      a.requestAction = "add";
    }
  }
  r.status = "rejected";
  r.rejectedAt = now();
  r.rejectedBy = currentUser().id;
  saveState();
  notifyUser(r.employeeId,"approval","Request rejected",`Your ${requestTypeLabel(r).toLowerCase()} request was not approved. Contact your manager if you need more information.`,{requestId:r.id,shiftId:r.shiftId||"",targetView:"myrequests"});
  renderContent();
  toast("Request rejected.");
  return true;
}

function decideRequestAndClose(id, decision){
  const ok = decision === "approve" ? approveRequest(id) : rejectRequest(id);
  if(ok) closeModal();
}

function requestDetailModal(id){
  const r = state.requests.find(x => x.id === id);
  if(!r) return toast("Request not found.");
  markRequestSeen(id);
  const managerMode = isManagerial(currentUser());
  modal(`<div class="request-review-modal">
    <span class="eyebrow">${esc(requestTypeLabel(r))}</span>
    <h3>${esc(requestShortMessage(r))}</h3>
    <p class="muted">${requestDateLine(r)}</p>
    <div class="request-review-detail">${requestSnapshotText(r)}</div>
    ${r.message ? `<div class="request-manager-note"><strong>Employee note</strong><span>${esc(r.message)}</span></div>` : ""}
    <div class="actions">
      ${managerMode && r.status === "pending" ? `<button class="success" onclick="decideRequestAndClose('${r.id}','approve')">Approve request</button><button class="danger" onclick="decideRequestAndClose('${r.id}','reject')">Reject request</button>` : ""}
      ${managerMode && r.shiftId ? `<button onclick="closeModal(); go('roster')">Open roster</button>` : ""}
      <button onclick="closeModal()">Close</button>
    </div>
  </div>`);
}

const __v114BuildHtmlEmail = buildHtmlEmail;
buildHtmlEmail = function(args){
  if(args.type !== "roster") return __v114BuildHtmlEmail(args);
  const shifts = args.shifts || [];
  const resolvedUrl = getScheduleEmailUrl(args.loginUrl);
  const safeUrl = esc(resolvedUrl);
  const totalHours = args.totalHours || shifts.reduce((sum,s)=>sum+Number(s.hours || shiftHours(s)),0).toFixed(1);
  const rows = shifts.map((s,idx)=>{
    const d = dateObj(s.date);
    const day = d.toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric"});
    const time = `${formatEmailShiftTime(s.start)} – ${formatEmailShiftTime(s.end)}${emailShiftCrossesMidnight(s)?" next day":""}`;
    const role = s.role && s.role !== "Shift" ? s.role : "Team Member";
    const location = s.location && s.location !== "Location TBA" ? s.location : "";
    return `<tr><td class="shift-left" width="58%" valign="middle" style="padding:18px 20px;border-top:${idx?"1px solid #dfe7f2":"0"};background:${idx%2?"#f7faff":"#ffffff"};"><div style="font-size:16px;line-height:22px;font-weight:800;color:#172033;">${esc(day)}</div><div style="margin-top:4px;font-size:13px;line-height:19px;color:#667085;">${esc([role,location].filter(Boolean).join(" · "))}</div></td><td class="shift-right" width="42%" align="right" valign="middle" style="padding:18px 20px;border-top:${idx?"1px solid #dfe7f2":"0"};background:${idx%2?"#f7faff":"#ffffff"};"><div style="font-size:16px;line-height:22px;font-weight:800;color:#0b5cff;white-space:nowrap;">${esc(time)}</div><div style="margin-top:4px;font-size:13px;line-height:19px;font-weight:700;color:#667085;">${esc(s.hours || shiftHours(s).toFixed(1))} hrs</div></td></tr>`;
  }).join("");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>@media only screen and (max-width:620px){.email-shell{width:100%!important}.email-pad{padding:20px 16px!important}.summary-cell{display:block!important;width:100%!important;text-align:left!important;padding:0 0 12px!important}.shift-left,.shift-right{display:block!important;width:auto!important;text-align:left!important;padding:14px 16px!important}.shift-right{border-top:0!important;padding-top:0!important}.cta{display:block!important;width:auto!important}.outer-pad{padding:12px 8px!important}}</style></head><body style="margin:0;padding:0;background:#f4f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f4f7fb;border-collapse:collapse;"><tr><td class="outer-pad" align="center" style="padding:30px 16px;"><table class="email-shell" role="presentation" width="760" cellspacing="0" cellpadding="0" border="0" style="width:760px;max-width:760px;background:#ffffff;border:1px solid #dce4ef;border-radius:20px;overflow:hidden;border-collapse:separate;"><tr><td class="email-pad" style="padding:32px 38px;background:#0b2f6b;color:#ffffff;"><div style="font-size:20px;font-weight:800;">MySchedule</div><div style="margin-top:20px;font-size:30px;line-height:36px;font-weight:800;">Hi ${esc(args.toName)} 👋</div><div style="margin-top:8px;font-size:16px;line-height:24px;color:#eaf1ff;">Your upcoming shifts at <strong style="color:#fff;">${esc(args.businessName)}</strong> are ready.</div></td></tr><tr><td class="email-pad" style="padding:28px 38px 32px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td class="summary-cell" valign="bottom"><div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.6px;color:#7a8494;">Schedule period</div><div style="margin-top:5px;font-size:17px;line-height:24px;font-weight:800;color:#172033;">${esc(args.weekStartText)} – ${esc(args.weekEndText)}</div></td><td class="summary-cell" align="right" valign="bottom" style="white-space:nowrap;"><span style="display:inline-block;background:#eef4ff;color:#0b5cff;border-radius:999px;padding:7px 11px;font-size:12px;font-weight:800;">${shifts.length} shifts</span><span style="display:inline-block;background:#edf9f2;color:#157347;border-radius:999px;padding:7px 11px;font-size:12px;font-weight:800;margin-left:6px;">${esc(totalHours)} hrs</span></td></tr></table><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:18px;width:100%;border:1px solid #dfe7f2;border-radius:14px;overflow:hidden;border-collapse:separate;border-spacing:0;"><tr><td width="58%" style="padding:12px 20px;background:#eef4ff;color:#49617f;font-size:11px;font-weight:800;text-transform:uppercase;">Day, role and location</td><td width="42%" align="right" style="padding:12px 20px;background:#eef4ff;color:#49617f;font-size:11px;font-weight:800;text-transform:uppercase;">Shift time</td></tr>${rows}</table><div style="text-align:center;padding-top:26px;">${safeUrl?`<a class="cta" href="${safeUrl}" target="_blank" style="display:inline-block;background:#0b5cff;color:#fff;text-decoration:none;font-size:15px;font-weight:800;padding:14px 26px;border-radius:999px;">View my schedule</a>`:""}</div><div style="margin-top:18px;font-size:13px;line-height:20px;color:#6b7280;text-align:center;">Open MySchedule to review shift notes and the latest schedule changes.</div></td></tr><tr><td align="center" style="padding:17px 24px;background:#f8fafc;border-top:1px solid #e5e7eb;color:#798292;font-size:12px;line-height:18px;">Sent by MySchedule for ${esc(args.businessName)}.<br>This is an automated notification. Replies are sent to your workplace owner.</td></tr></table></td></tr></table></body></html>`;
};

/* v116: unified owner/manager internal navigation — fixes dashboard Open requests and similar stale handlers */
function openWorkspaceSection(view, event){
  if(event){
    try{ event.preventDefault(); event.stopPropagation(); }catch(e){}
  }
  const user = currentUser() || (typeof v105RestoreWorkspaceUser === 'function' ? v105RestoreWorkspaceUser() : null);
  if(!user){
    toast('Please sign in again to continue.');
    render();
    return false;
  }
  const aliases = {employees:'credentials', availability:'requesthub', myrequests:'requesthub'};
  const requested = aliases[view] || view;
  if(view === 'availability') requestHubMode = 'availability';
  if(view === 'myrequests') requestHubMode = 'requests';
  if(!v99CanAccessView(user, requested)){
    toast('This area is not available for your role.');
    return false;
  }
  closeModal();
  currentUserId = user.id;
  currentView = requested;
  try{ sessionStorage.setItem(CURRENT_KEY,user.id); }catch(e){}
  try{ localStorage.setItem(V103_PERSISTED_SESSION_KEY,user.id); }catch(e){}
  try{ history.replaceState(null,'',`${location.pathname}${location.search}#${currentView}`); }catch(e){}
  try{
    const shell = document.querySelector('.layout');
    if(!shell){ render(); }
    else { renderContent(); }
  }catch(error){
    console.error('Workspace navigation failed', requested, error);
    toast('This section could not open. Refresh once and try again.');
    return false;
  }
  requestAnimationFrame(()=>window.scrollTo({top:0,behavior:'auto'}));
  return true;
}

// Keep every internal route on the same command, including dashboard cards and modal actions.
go = function(view){ return openWorkspaceSection(view); };
v103ManagerGo = function(view){ return openWorkspaceSection(view); };
v103EmployeeGo = function(view,mode){ if(mode) requestHubMode=mode; return openWorkspaceSection(view); };
v96RequestHub = function(mode='requests'){ requestHubMode=mode; return openWorkspaceSection('requesthub'); };

// Capture stale request links created by earlier dashboard versions.
if(window.__v116RequestNavigationHandler){
  document.removeEventListener('click',window.__v116RequestNavigationHandler,true);
}
window.__v116RequestNavigationHandler=function(event){
  const target=event.target.closest('[data-open-requests], button[title="Open requests"]');
  if(!target) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  openWorkspaceSection('requests');
};
document.addEventListener('click',window.__v116RequestNavigationHandler,true);

/* v117: root owner/manager request navigation and resilient business-request QA */
(function(){
  function activeWorkspaceUser(){
    let user=null;
    try{ user=currentUser(); }catch(e){}
    if(user) return user;
    let id='';
    try{id=sessionStorage.getItem(CURRENT_KEY)||'';}catch(e){}
    try{id=id||localStorage.getItem(V103_PERSISTED_SESSION_KEY)||'';}catch(e){}
    user=(state?.users||[]).find(u=>u.id===id&&u.status!=='removed'&&u.status!=='inactive')||null;
    if(user){
      currentUserId=user.id;
      try{sessionStorage.setItem(CURRENT_KEY,user.id);}catch(e){}
    }
    return user;
  }

  function normalizeBusinessRequests(){
    let changed=false;
    const users=state?.users||[];
    const shifts=state?.shifts||[];
    (state?.requests||[]).forEach(r=>{
      if(!r.id){r.id=uuid();changed=true;}
      if(!r.status){r.status='pending';changed=true;}
      if(!r.createdAt){r.createdAt=now();changed=true;}
      if(!Array.isArray(r.seenBy)){r.seenBy=[];changed=true;}
      if(!r.businessId){
        const employee=users.find(u=>u.id===r.employeeId);
        const shift=shifts.find(s=>s.id===r.shiftId);
        r.businessId=employee?.businessId||shift?.businessId||'';
        if(r.businessId) changed=true;
      }
      if(!r.type) {r.type='change';changed=true;}
    });
    if(changed) saveState();
  }

  function safeManagerRequestsView(user){
    normalizeBusinessRequests();
    try{return requestsView(true);}catch(error){
      console.error('Requests page render failed',error);
      const rows=(state.requests||[]).filter(r=>r.businessId===user.businessId).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
      return `<section class="apple-clean-page qa-requests-page"><div class="page-hero"><div><span class="eyebrow">Manager workspace</span><h1>Requests</h1><p>Review employee requests for this business.</p></div><span class="apple-count-bubble">${rows.length}</span></div>${rows.length?`<div class="apple-panel"><div class="simple-list">${rows.map(r=>{const employee=(state.users||[]).find(u=>u.id===r.employeeId);return `<button class="action-item" onclick="requestDetailModal('${escAttr(r.id)}')"><div><strong>${esc(employee?.name||'Employee')} · ${esc(requestTypeLabel(r))}</strong><small>${esc(r.message||'Open to review details')}</small></div><em>${esc(r.status||'pending')}</em></button>`}).join('')}</div></div>`:`<div class="apple-empty-state qa-empty"><div class="apple-empty-icon">✓</div><h3>No requests</h3><p>No employee requests are waiting for this business.</p></div>`}</section>`;
    }
  }

  function renderWorkspaceView(){
    const user=activeWorkspaceUser();
    if(!user){ render(); return false; }
    const view=el('view');
    if(!view){ render(); return false; }
    document.querySelectorAll('.nav button[data-view]').forEach(btn=>btn.classList.toggle('active',btn.dataset.view===currentView));
    try{
      if(user.role==='employee'){
        if(currentView==='availability'){requestHubMode='availability';currentView='requesthub';}
        if(currentView==='myrequests'){requestHubMode='requests';currentView='requesthub';}
        if(!['myshifts','teamschedule','requesthub','clock','notifications','profile'].includes(currentView)) currentView='myshifts';
        if(currentView==='myshifts') view.innerHTML=employeeWorkView();
        else if(currentView==='teamschedule') view.innerHTML=v96TeamScheduleView();
        else if(currentView==='requesthub') view.innerHTML=employeeRequestsAvailabilityView();
        else if(currentView==='clock') view.innerHTML=clockView();
        else if(currentView==='notifications') view.innerHTML=notificationsView();
        else view.innerHTML=profileView();
      }else{
        if(currentView==='employees') currentView='credentials';
        const allowed=user.role==='owner'?['dashboard','roster','credentials','requests','timesheets','reports','settings','notifications','profile']:['dashboard','roster','credentials','requests','timesheets','reports','notifications','profile'];
        if(!allowed.includes(currentView)) currentView='dashboard';
        if(currentView==='dashboard') view.innerHTML=managerDashboard();
        else if(currentView==='roster') view.innerHTML=rosterView();
        else if(currentView==='credentials') view.innerHTML=credentialsView();
        else if(currentView==='requests') view.innerHTML=safeManagerRequestsView(user);
        else if(currentView==='timesheets') view.innerHTML=timesheetsView();
        else if(currentView==='reports') view.innerHTML=reportsView();
        else if(currentView==='settings'&&user.role==='owner') view.innerHTML=settingsView();
        else if(currentView==='notifications') view.innerHTML=notificationsView();
        else if(currentView==='profile') view.innerHTML=profileView();
        else view.innerHTML=managerDashboard();
      }
      document.querySelectorAll('.nav button[data-view]').forEach(btn=>btn.classList.toggle('active',btn.dataset.view===currentView));
      return true;
    }catch(error){
      console.error('Workspace view failed',currentView,error);
      view.innerHTML=`<section class="apple-clean-page"><div class="apple-panel"><h2>This section needs attention</h2><p>The page could not display one older record safely. Your account is still signed in.</p><div class="actions"><button class="primary" onclick="openWorkspaceSection('${user.role==='employee'?'myshifts':'dashboard'}')">Return to dashboard</button>${user.role!=='employee'?`<button onclick="openWorkspaceSection('requests')">Retry requests</button>`:''}</div></div></section>`;
      return false;
    }
  }

  window.openWorkspaceSection=function(view,event){
    if(event){try{event.preventDefault();event.stopPropagation();}catch(e){}}
    const user=activeWorkspaceUser();
    if(!user){toast('Please sign in again.');render();return false;}
    closeModal();
    if(view==='employees') view='credentials';
    if(view==='availability'){requestHubMode='availability';view='requesthub';}
    if(view==='myrequests'){requestHubMode='requests';view='requesthub';}
    currentView=view;
    currentUserId=user.id;
    try{sessionStorage.setItem(CURRENT_KEY,user.id);}catch(e){}
    try{history.replaceState(null,'',`${location.pathname}${location.search}#${currentView}`);}catch(e){}
    if(!document.querySelector('.layout')) render();
    else renderWorkspaceView();
    requestAnimationFrame(()=>window.scrollTo({top:0,behavior:'auto'}));
    return true;
  };

  go=function(view){return window.openWorkspaceSection(view);};
  renderContent=renderWorkspaceView;
  v103ManagerGo=function(view){return window.openWorkspaceSection(view);};
  v103EmployeeGo=function(view,mode){if(mode)requestHubMode=mode;return window.openWorkspaceSection(view);};
  v96RequestHub=function(mode='requests'){requestHubMode=mode;return window.openWorkspaceSection('requesthub');};

  if(window.__v116RequestNavigationHandler) document.removeEventListener('click',window.__v116RequestNavigationHandler,true);
  if(window.__v117WorkspaceNavHandler) document.removeEventListener('click',window.__v117WorkspaceNavHandler,true);
  window.__v117WorkspaceNavHandler=function(event){
    const target=event.target instanceof Element?event.target.closest('[data-open-requests], .nav button[data-view]'):null;
    if(!target) return;
    const view=target.hasAttribute('data-open-requests')?'requests':target.dataset.view;
    if(!view) return;
    event.preventDefault();event.stopImmediatePropagation();
    window.openWorkspaceSection(view,event);
  };
  document.addEventListener('click',window.__v117WorkspaceNavHandler,true);

  try{normalizeBusinessRequests();}catch(e){console.warn('Request normalization skipped',e);}
})();

/* v118: working request queue controls — New, Action needed, and Open */
let requestQueueFilter = 'all';

function setRequestQueueFilter(filter){
  requestQueueFilter = ['all','new','action'].includes(filter) ? filter : 'all';
  renderContent();
}

function requestIsNewForCurrentUser(r){
  const user = currentUser();
  if(!user) return false;
  return !Array.isArray(r.seenBy) || !r.seenBy.includes(user.id);
}

function v118VisibleCurrentRequests(rows, managerMode){
  if(requestQueueFilter === 'new') return rows.filter(requestIsNewForCurrentUser);
  if(requestQueueFilter === 'action') return managerMode ? rows.filter(r => r.status === 'pending') : rows.filter(r => r.status === 'pending');
  return rows;
}

function requestsCards(rows, managerMode, history=false){
  if(!rows.length) return `<div class="apple-empty-mini"><strong>No matching requests</strong><span>Choose another filter to view other records.</span></div>`;
  return `<div class="apple-request-list ${history ? 'is-history' : ''}">
    ${rows.map(r=>{
      const isNew=requestIsNewForCurrentUser(r);
      const needsAction=managerMode && r.status==='pending';
      return `<article class="apple-request-card ${isNew?'is-new':''} ${r.status==='pending'?'is-current':''}" data-request-open="${escAttr(r.id)}" tabindex="0" role="button" aria-label="Open ${escAttr(requestTypeLabel(r))}">
        <div class="apple-request-main">
          <div class="apple-request-title-row"><h3>${esc(requestTypeLabel(r))}</h3><span class="badge ${escAttr(r.status)}">${esc(r.status)}</span></div>
          <p>${esc(requestShortMessage(r))}</p>
          <span class="apple-note-meta">${requestDateLine(r)}</span>
        </div>
        <div class="apple-request-side">
          ${isNew?`<button type="button" class="ios-badge new-dot request-status-control" data-request-filter="new" aria-label="Show new requests">New</button>`:''}
          ${needsAction?`<button type="button" class="ios-badge action-dot request-status-control" data-request-filter="action" aria-label="Show requests needing action">Action needed</button>`:''}
          <button type="button" class="tiny apple-link-button request-open-button" data-request-open="${escAttr(r.id)}">Open</button>
        </div>
      </article>`;
    }).join('')}
  </div>`;
}

function requestsView(managerMode){
  const user=currentUser();
  const b=business();
  const allRows=(managerMode
    ? (state.requests||[]).filter(r=>r.businessId===b.id)
    : (state.requests||[]).filter(r=>r.employeeId===user.id)
  ).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
  const currentRows=allRows.filter(r=>r.status==='pending');
  const newCount=currentRows.filter(requestIsNewForCurrentUser).length;
  const actionCount=managerMode?currentRows.filter(r=>r.status==='pending').length:currentRows.length;
  const visible=v118VisibleCurrentRequests(currentRows,managerMode);
  const history=allRows.filter(r=>r.status!=='pending');
  const approved=history.filter(r=>r.status==='approved').length;
  const rejected=history.filter(r=>r.status==='rejected').length;
  const filteredHistory=filteredHistoryRows(history);
  return `<section class="apple-requests-page qa-requests-page">
    ${pageHero(managerMode?'Requests':'My Requests','Review current requests and completed history.',currentRows.length?`<span class="apple-count-bubble">${currentRows.length}</span>`:`<span class="apple-clear-bubble">0</span>`)}
    <div class="v118-request-queue-controls" role="tablist" aria-label="Request filters">
      <button type="button" class="${requestQueueFilter==='all'?'active':''}" data-request-filter="all">All <b>${currentRows.length}</b></button>
      <button type="button" class="${requestQueueFilter==='new'?'active':''}" data-request-filter="new">New <b>${newCount}</b></button>
      <button type="button" class="${requestQueueFilter==='action'?'active':''}" data-request-filter="action">Action needed <b>${actionCount}</b></button>
    </div>
    ${currentRows.length?requestsCards(visible,managerMode):`<div class="apple-empty-state qa-empty"><div class="apple-empty-icon">✓</div><h3>No current requests</h3><p>New employee requests will appear here.</p></div>`}
    ${history.length?`<details class="apple-history"><summary>Request history (${history.length})</summary><div class="v95-request-filters"><button class="${requestHistoryFilter==='all'?'active':''}" onclick="setRequestHistoryFilter('all')">All <b>${history.length}</b></button><button class="${requestHistoryFilter==='approved'?'active':''}" onclick="setRequestHistoryFilter('approved')">Approved <b>${approved}</b></button><button class="${requestHistoryFilter==='rejected'?'active':''}" onclick="setRequestHistoryFilter('rejected')">Rejected <b>${rejected}</b></button></div>${filteredHistory.length?requestsCards(filteredHistory,managerMode,true):`<div class="apple-empty-mini"><strong>No ${requestHistoryFilter} requests</strong></div>`}</details>`:''}
  </section>`;
}

if(window.__v118RequestControlHandler) document.removeEventListener('click',window.__v118RequestControlHandler,true);
window.__v118RequestControlHandler=function(event){
  const target=event.target instanceof Element ? event.target : null;
  if(!target) return;
  const filterButton=target.closest('[data-request-filter]');
  if(filterButton){
    event.preventDefault();
    event.stopImmediatePropagation();
    setRequestQueueFilter(filterButton.getAttribute('data-request-filter'));
    return;
  }
  const openButton=target.closest('[data-request-open]');
  if(openButton){
    event.preventDefault();
    event.stopImmediatePropagation();
    const id=openButton.getAttribute('data-request-open');
    if(id) requestDetailModal(id);
  }
};
document.addEventListener('click',window.__v118RequestControlHandler,true);

document.addEventListener('keydown',function(event){
  if(event.key!=='Enter' && event.key!==' ') return;
  const target=event.target instanceof Element ? event.target.closest('article[data-request-open]') : null;
  if(!target) return;
  event.preventDefault();
  const id=target.getAttribute('data-request-open');
  if(id) requestDetailModal(id);
});

window.setRequestQueueFilter=setRequestQueueFilter;

/* v119: root authentication, request hub, and responsive email stability */
(function(){
  const LEGACY_ACTIVE_KEY = typeof V103_PERSISTED_SESSION_KEY !== 'undefined' ? V103_PERSISTED_SESSION_KEY : 'myschedule_v103_active_user';

  // Never restore a workspace from browser-wide local storage. A user must explicitly
  // sign in for each browser session; normal refreshes in the same tab still work.
  try{ localStorage.removeItem(LEGACY_ACTIVE_KEY); }catch(e){}
  try{ localStorage.removeItem(LEGACY_CURRENT_KEY); }catch(e){}

  currentUser = function(){
    if(!state || !Array.isArray(state.users)) return null;
    let id = currentUserId || '';
    try{ id = id || sessionStorage.getItem(CURRENT_KEY) || ''; }catch(e){}
    const user = state.users.find(u => u.id === id && u.status !== 'removed' && u.status !== 'inactive') || null;
    if(user){
      currentUserId = user.id;
      try{ sessionStorage.setItem(CURRENT_KEY,user.id); }catch(e){}
    }
    return user;
  };

  setCurrentSession = function(userId){
    currentUserId = userId || null;
    markActivity();
    try{
      if(userId) sessionStorage.setItem(CURRENT_KEY,userId);
      else sessionStorage.removeItem(CURRENT_KEY);
    }catch(e){}
    try{ localStorage.removeItem(LEGACY_ACTIVE_KEY); }catch(e){}
    try{ localStorage.removeItem(LEGACY_CURRENT_KEY); }catch(e){}
  };

  clearCurrentSession = function(){
    currentUserId = null;
    try{ sessionStorage.removeItem(CURRENT_KEY); }catch(e){}
    try{ localStorage.removeItem(LEGACY_ACTIVE_KEY); }catch(e){}
    try{ localStorage.removeItem(LEGACY_CURRENT_KEY); }catch(e){}
  };

  // Firebase may remember credentials, but it must not automatically enter a workplace.
  enforceSessionSecurity = async function(shouldRender=true){
    const user = currentUser();
    if(user) return true;
    if(shouldRender) render();
    return false;
  };

  function safeBusinessForUser(user){
    return (state.businesses||[]).find(b=>b.id===user?.businessId) || null;
  }

  function employeeAvailabilityPanel(user){
    const rows=(state.availability||[])
      .filter(a=>a.employeeId===user.id)
      .sort((a,b)=>(b.date||b.createdAt||'').localeCompare(a.date||a.createdAt||''));
    return `<section class="v119-hub-section">
      <div class="panel-head v119-hub-panel-head"><div><h2>Availability</h2><p class="muted">Submit only the dates and times you cannot work.</p></div><button class="primary" type="button" onclick="openAvailabilityModal()">Request unavailable</button></div>
      <div class="notice oknotice">Approved unavailable periods prevent conflicting shifts from being assigned or published.</div>
      <div class="panel v119-responsive-table">${availabilityTable(rows)}</div>
    </section>`;
  }

  employeeRequestsAvailabilityView = function(){
    const user=currentUser();
    if(!user || user.role!=='employee') return `<section class="apple-clean-page"><div class="apple-panel"><h2>Employee access required</h2><p>Please sign in with an employee account.</p></div></section>`;
    const mode=requestHubMode==='availability'?'availability':'requests';
    const body=mode==='availability' ? employeeAvailabilityPanel(user) : requestsView(false);
    return `<section class="v96-requesthub v119-requesthub apple-clean-page">
      <div class="v96-requesthub-head v119-requesthub-head">
        <div><span class="eyebrow">Employee workspace</span><h1>Requests & Availability</h1></div>
        <div class="v96-segmented v119-segmented" role="tablist" aria-label="Requests and availability">
          <button type="button" class="${mode==='requests'?'active':''}" data-request-hub-mode="requests" aria-selected="${mode==='requests'}">My requests</button>
          <button type="button" class="${mode==='availability'?'active':''}" data-request-hub-mode="availability" aria-selected="${mode==='availability'}">Availability</button>
        </div>
      </div>
      <div class="v96-requesthub-body ${mode}">${body}</div>
    </section>`;
  };

  function renderStableWorkspace(){
    const user=currentUser();
    if(!user){ render(); return false; }
    const view=el('view');
    if(!view){ render(); return false; }
    try{
      if(user.role==='employee'){
        if(currentView==='availability'){requestHubMode='availability';currentView='requesthub';}
        if(currentView==='myrequests'){requestHubMode='requests';currentView='requesthub';}
        const allowed=['myshifts','teamschedule','requesthub','clock','notifications','profile'];
        if(!allowed.includes(currentView)) currentView='myshifts';
        if(currentView==='myshifts') view.innerHTML=employeeWorkView();
        else if(currentView==='teamschedule') view.innerHTML=v96TeamScheduleView();
        else if(currentView==='requesthub') view.innerHTML=employeeRequestsAvailabilityView();
        else if(currentView==='clock') view.innerHTML=clockView();
        else if(currentView==='notifications') view.innerHTML=notificationsView();
        else view.innerHTML=profileView();
      }else{
        if(currentView==='employees') currentView='credentials';
        const allowed=user.role==='owner'?['dashboard','roster','credentials','requests','timesheets','reports','settings','notifications','profile']:['dashboard','roster','credentials','requests','timesheets','reports','notifications','profile'];
        if(!allowed.includes(currentView)) currentView='dashboard';
        if(currentView==='dashboard') view.innerHTML=managerDashboard();
        else if(currentView==='roster') view.innerHTML=rosterView();
        else if(currentView==='credentials') view.innerHTML=credentialsView();
        else if(currentView==='requests') view.innerHTML=requestsView(true);
        else if(currentView==='timesheets') view.innerHTML=timesheetsView();
        else if(currentView==='reports') view.innerHTML=reportsView();
        else if(currentView==='settings'&&user.role==='owner') view.innerHTML=settingsView();
        else if(currentView==='notifications') view.innerHTML=notificationsView();
        else view.innerHTML=profileView();
      }
      document.querySelectorAll('.nav button[data-view]').forEach(btn=>btn.classList.toggle('active',btn.dataset.view===currentView));
      return true;
    }catch(error){
      console.error('v119 workspace render failed',currentView,error);
      view.innerHTML=`<section class="apple-clean-page"><div class="apple-panel"><h2>This section could not open</h2><p>Your account is still signed in. Return to the main page and retry.</p><button class="primary" onclick="openWorkspaceSection('${user.role==='employee'?'myshifts':'dashboard'}')">Return</button></div></section>`;
      return false;
    }
  }

  window.openWorkspaceSection = function(view,event){
    if(event){ try{event.preventDefault();event.stopPropagation();}catch(e){} }
    const user=currentUser();
    if(!user){ toast('Please sign in to continue.'); render(); return false; }
    closeModal();
    if(view==='employees') view='credentials';
    if(view==='availability'){requestHubMode='availability';view='requesthub';}
    if(view==='myrequests'){requestHubMode='requests';view='requesthub';}
    if(user.role==='employee' && !['myshifts','teamschedule','requesthub','clock','notifications','profile'].includes(view)) view='myshifts';
    if(user.role!=='employee' && !v99CanAccessView(user,view)) view=v99RoleHome(user);
    currentView=view;
    currentUserId=user.id;
    try{sessionStorage.setItem(CURRENT_KEY,user.id);}catch(e){}
    try{history.replaceState(null,'',`${location.pathname}${location.search}#${currentView}`);}catch(e){}
    if(!document.querySelector('.layout')) render(); else renderStableWorkspace();
    requestAnimationFrame(()=>window.scrollTo({top:0,behavior:'auto'}));
    return true;
  };

  go=function(view){return window.openWorkspaceSection(view);};
  renderContent=renderStableWorkspace;
  v103EmployeeGo=function(view,mode){if(mode)requestHubMode=mode;return window.openWorkspaceSection(view);};
  v103ManagerGo=function(view){return window.openWorkspaceSection(view);};
  v96RequestHub=function(mode='requests'){requestHubMode=mode;return window.openWorkspaceSection('requesthub');};

  if(window.__v119HubHandler) document.removeEventListener('click',window.__v119HubHandler,true);
  window.__v119HubHandler=function(event){
    const target=event.target instanceof Element?event.target:null;
    if(!target) return;
    const modeBtn=target.closest('[data-request-hub-mode]');
    if(modeBtn){
      event.preventDefault();event.stopImmediatePropagation();
      requestHubMode=modeBtn.getAttribute('data-request-hub-mode')==='availability'?'availability':'requests';
      currentView='requesthub';
      renderStableWorkspace();
      return;
    }
  };
  document.addEventListener('click',window.__v119HubHandler,true);

  // Replace browser-wide Firebase persistence used by a late legacy login override.
  const legacyLogin=login;
  login=async function(){
    const email=normalizeEmail(readCredentialFromInput('login-email','email'));
    const password=cleanPassword(readCredentialFromInput('login-password','password'));
    if(!isValidEmail(email)||!password) return toast('Enter your email and password.');
    v96RememberEmail?.(email);
    const localUser=(state.users||[]).find(u=>normalizeEmail(u.email)===email&&u.status!=='removed');
    if(localUser&&((localUser.tempPassword&&password===localUser.tempPassword)||(localUser.localPassword&&password===localUser.localPassword))){
      if(localUser.status==='inactive') return toast('This account is paused. Contact your owner or manager.');
      localUser.lastLoginAt=now();
      if(localUser.status==='invited') localUser.status='active';
      saveState();setCurrentSession(localUser.id);
      if(localUser.forcePasswordChange||localUser.tempPassword){render();setTimeout(()=>v96ShowPasswordChange(localUser),30);return;}
      return v99EnterWorkspace(localUser);
    }
    try{
      const auth=requireAuth();
      await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION).catch(()=>{});
      if(auth.currentUser&&normalizeEmail(auth.currentUser.email)!==email) await auth.signOut().catch(()=>{});
      clearCurrentSession();
      const cred=await auth.signInWithEmailAndPassword(email,password);
      if(!cred.user.emailVerified){
        const verificationPending=v133PendingAccess();
        const verificationToken=(verificationPending?.type==='invite'&&verificationPending.token)||v133InviteToken();
        await cred.user.sendEmailVerification({url:verificationToken?v133SecureLink(verificationToken):window.location.href.split('#')[0]}).catch(()=>{});
        await auth.signOut().catch(()=>{});
        return toast('Please verify your email first. A new verification email was requested.');
      }
      const cloudState = await loadFirebaseState();
    if(cloudState){
      state = migrateState(cloudState);
      try{ localStorage.setItem(APP_KEY, JSON.stringify(state)); }catch(_e){}
    }
    startFirebaseLiveUpdates();
    await finishAuthLogin(cred.user);
    }catch(e){console.warn('v119 login failed',e);toast(firebaseErrorMessage(e));}
  };

  // Final email renderer: fluid on phones, desktop-width on larger clients, and email-safe.
  const previousBuildHtmlEmail=buildHtmlEmail;
  buildHtmlEmail=function(args){
    if(args.type!=='roster') return previousBuildHtmlEmail(args);
    const shifts=Array.isArray(args.shifts)?args.shifts:[];
    const url=getScheduleEmailUrl(args.loginUrl);
    const total=Number(args.totalHours||shifts.reduce((n,s)=>n+Number(s.hours||shiftHours(s)),0)).toFixed(1);
    const rows=shifts.map((s,i)=>{
      const d=dateObj(s.date);
      const day=d.toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'});
      const role=s.role&&s.role!=='Shift'?s.role:'Team Member';
      const location=s.location&&s.location!=='Location TBA'?s.location:'Main Store';
      const time=`${formatEmailShiftTime(s.start)} – ${formatEmailShiftTime(s.end)}${emailShiftCrossesMidnight(s)?' next day':''}`;
      const hours=Number(s.hours||shiftHours(s)).toFixed(1);
      return `<tr><td style="padding:17px 18px;border-top:${i?'1px solid #dfe7f2':'0'};background:${i%2?'#f7faff':'#ffffff'};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="top" style="width:62%;padding-right:12px;"><div style="font-size:16px;line-height:22px;font-weight:700;color:#172033;">${esc(day)}</div><div style="margin-top:4px;font-size:13px;line-height:19px;color:#667085;">${esc(role)} · ${esc(location)}</div></td><td valign="top" align="right" style="width:38%;"><div style="font-size:15px;line-height:21px;font-weight:700;color:#0b5cff;">${esc(time)}</div><div style="margin-top:4px;font-size:13px;line-height:19px;color:#667085;">${hours} hrs</div></td></tr></table></td></tr>`;
    }).join('');
    return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>@media screen and (max-width:620px){.outer{padding:10px 6px!important}.shell{width:100%!important}.pad{padding-left:18px!important;padding-right:18px!important}.summary-right{display:block!important;text-align:left!important;padding-top:10px!important}}</style></head><body style="margin:0;padding:0;background:#f3f6fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background:#f3f6fa;"><tr><td class="outer" align="center" style="padding:28px 14px;"><!--[if mso]><table role="presentation" width="760" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]--><table class="shell" role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:760px;background:#ffffff;border:1px solid #dce4ef;border-radius:18px;overflow:hidden;"><tr><td class="pad" style="padding:30px 34px;background:#0b2f6b;color:#ffffff;"><div style="font-size:20px;font-weight:800;">MySchedule</div><div style="margin-top:18px;font-size:29px;line-height:35px;font-weight:800;">Hi ${esc(args.toName)} 👋</div><div style="margin-top:8px;font-size:16px;line-height:24px;color:#eaf1ff;">Your upcoming shifts at <strong style="color:#ffffff;">${esc(args.businessName)}</strong> are ready.</div></td></tr><tr><td class="pad" style="padding:26px 34px 32px;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td valign="bottom"><div style="font-size:11px;letter-spacing:.5px;text-transform:uppercase;font-weight:800;color:#7a8494;">Schedule period</div><div style="margin-top:5px;font-size:17px;line-height:24px;font-weight:800;color:#172033;">${esc(args.weekStartText)} – ${esc(args.weekEndText)}</div></td><td class="summary-right" align="right" valign="bottom"><span style="display:inline-block;padding:7px 10px;border-radius:999px;background:#eef4ff;color:#0b5cff;font-size:12px;font-weight:800;">${shifts.length} shifts</span> <span style="display:inline-block;padding:7px 10px;border-radius:999px;background:#edf9f2;color:#157347;font-size:12px;font-weight:800;">${total} hrs</span></td></tr></table><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px;border:1px solid #dfe7f2;border-radius:13px;overflow:hidden;">${rows}</table>${url?`<div style="padding-top:24px;text-align:center;"><a href="${escAttr(url)}" target="_blank" style="display:inline-block;padding:14px 25px;border-radius:999px;background:#0b5cff;color:#ffffff;text-decoration:none;font-size:15px;font-weight:800;">View my schedule</a></div>`:''}<div style="margin-top:18px;text-align:center;font-size:13px;line-height:20px;color:#6b7280;">Open MySchedule to review shift notes and the latest schedule changes.</div></td></tr><tr><td align="center" style="padding:16px 20px;background:#f8fafc;border-top:1px solid #e5e7eb;font-size:12px;line-height:18px;color:#798292;">Sent by MySchedule for ${esc(args.businessName)}.<br>This is an automated notification. Replies are sent to your workplace owner.</td></tr></table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
  };
})();

/* v120: definitive Requests & Availability interaction repair */
(function(){
  function requestRowsFor(managerMode){
    const user=currentUser();
    const b=business();
    if(!user) return [];
    return (state.requests||[])
      .filter(r=>managerMode ? (!!b && r.businessId===b.id) : r.employeeId===user.id)
      .sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
  }

  function isUnreadRequest(r){
    const user=currentUser();
    return !!user && (!Array.isArray(r.seenBy) || !r.seenBy.includes(user.id));
  }

  window.v120SetRequestFilter=function(filter){
    requestQueueFilter=['all','new','action'].includes(filter)?filter:'all';
    renderContent();
    return false;
  };

  window.v120OpenRequest=function(id){
    const r=(state.requests||[]).find(x=>String(x.id)===String(id));
    if(!r){ toast('This request is no longer available. Refresh the page and try again.'); return false; }
    const user=currentUser();
    if(user){
      if(!Array.isArray(r.seenBy)) r.seenBy=[];
      if(!r.seenBy.includes(user.id)){ r.seenBy.push(user.id); saveState(); }
    }
    const managerMode=isManagerial(user);
    modal(`<div class="request-review-modal v120-request-modal">
      <span class="eyebrow">${esc(requestTypeLabel(r))}</span>
      <h3>${esc(requestShortMessage(r))}</h3>
      <p class="muted">${requestDateLine(r)}</p>
      <div class="request-review-detail">${requestSnapshotText(r)}</div>
      ${r.message?`<div class="request-manager-note"><strong>Employee note</strong><span>${esc(r.message)}</span></div>`:''}
      <div class="actions">
        ${managerMode&&r.status==='pending'?`<button class="success" type="button" onclick="decideRequestAndClose('${escAttr(r.id)}','approve')">Approve request</button><button class="danger" type="button" onclick="decideRequestAndClose('${escAttr(r.id)}','reject')">Reject request</button>`:''}
        ${managerMode&&r.shiftId?`<button type="button" onclick="closeModal(); openWorkspaceSection('roster')">Open roster</button>`:''}
        <button type="button" onclick="closeModal()">Close</button>
      </div>
    </div>`);
    return false;
  };

  requestsCards=function(rows,managerMode,history=false){
    if(!rows.length) return `<div class="apple-empty-mini"><strong>No matching requests</strong><span>Choose another filter to see other requests.</span></div>`;
    return `<div class="apple-request-list ${history?'is-history':''}">${rows.map(r=>{
      const unread=isUnreadRequest(r);
      const needsAction=managerMode&&r.status==='pending';
      return `<article class="apple-request-card ${unread?'is-new':''} ${r.status==='pending'?'is-current':''}">
        <div class="apple-request-main">
          <div class="apple-request-title-row"><h3>${esc(requestTypeLabel(r))}</h3><span class="badge ${escAttr(r.status||'pending')}">${esc(r.status||'pending')}</span></div>
          <p>${esc(requestShortMessage(r))}</p>
          <span class="apple-note-meta">${requestDateLine(r)}</span>
        </div>
        <div class="apple-request-side">
          ${unread?`<span class="ios-badge new-dot">New</span>`:''}
          ${needsAction?`<span class="ios-badge action-dot">Action needed</span>`:''}
          <button type="button" class="tiny apple-link-button" onclick="return v120OpenRequest('${escAttr(r.id)}')">Open</button>
        </div>
      </article>`;
    }).join('')}</div>`;
  };

  requestsView=function(managerMode){
    const all=requestRowsFor(managerMode);
    const pending=all.filter(r=>(r.status||'pending')==='pending');
    const newCount=pending.filter(isUnreadRequest).length;
    const actionCount=pending.length;
    let visible=pending;
    if(requestQueueFilter==='new') visible=pending.filter(isUnreadRequest);
    if(requestQueueFilter==='action') visible=pending;
    const history=all.filter(r=>(r.status||'pending')!=='pending');
    const approved=history.filter(r=>r.status==='approved').length;
    const rejected=history.filter(r=>r.status==='rejected').length;
    const filtered=filteredHistoryRows(history);
    return `<section class="apple-requests-page qa-requests-page v120-requests-page">
      ${pageHero(managerMode?'Requests':'My Requests','Review current requests and completed history.',pending.length?`<span class="apple-count-bubble">${pending.length}</span>`:`<span class="apple-clear-bubble">0</span>`)}
      <div class="v118-request-queue-controls" role="tablist" aria-label="Request filters">
        <button type="button" class="${requestQueueFilter==='all'?'active':''}" onclick="return v120SetRequestFilter('all')">All <b>${pending.length}</b></button>
        <button type="button" class="${requestQueueFilter==='new'?'active':''}" onclick="return v120SetRequestFilter('new')">New <b>${newCount}</b></button>
        <button type="button" class="${requestQueueFilter==='action'?'active':''}" onclick="return v120SetRequestFilter('action')">Action needed <b>${actionCount}</b></button>
      </div>
      ${pending.length?requestsCards(visible,managerMode):`<div class="apple-empty-state qa-empty"><div class="apple-empty-icon">✓</div><h3>No current requests</h3><p>New availability, swap and change requests will appear here.</p></div>`}
      ${history.length?`<details class="apple-history"><summary>Request history (${history.length})</summary><div class="v95-request-filters"><button class="${requestHistoryFilter==='all'?'active':''}" onclick="setRequestHistoryFilter('all')">All <b>${history.length}</b></button><button class="${requestHistoryFilter==='approved'?'active':''}" onclick="setRequestHistoryFilter('approved')">Approved <b>${approved}</b></button><button class="${requestHistoryFilter==='rejected'?'active':''}" onclick="setRequestHistoryFilter('rejected')">Rejected <b>${rejected}</b></button></div>${filtered.length?requestsCards(filtered,managerMode,true):`<div class="apple-empty-mini"><strong>No ${requestHistoryFilter} requests</strong></div>`}</details>`:''}
    </section>`;
  };

  window.v120SwitchRequestHub=function(mode){
    requestHubMode=mode==='availability'?'availability':'requests';
    currentView='requesthub';
    renderContent();
    return false;
  };

  employeeRequestsAvailabilityView=function(){
    const user=currentUser();
    if(!user||user.role!=='employee') return `<section class="apple-clean-page"><div class="apple-panel"><h2>Employee access required</h2><p>Please sign in with an employee account.</p></div></section>`;
    const mode=requestHubMode==='availability'?'availability':'requests';
    const body=mode==='availability'?employeeAvailabilityPanel(user):requestsView(false);
    return `<section class="v96-requesthub v119-requesthub apple-clean-page">
      <div class="v96-requesthub-head v119-requesthub-head">
        <div><span class="eyebrow">Employee workspace</span><h1>Requests & Availability</h1></div>
        <div class="v96-segmented v119-segmented" role="tablist" aria-label="Requests and availability">
          <button type="button" class="${mode==='requests'?'active':''}" onclick="return v120SwitchRequestHub('requests')">My requests</button>
          <button type="button" class="${mode==='availability'?'active':''}" onclick="return v120SwitchRequestHub('availability')">Availability</button>
        </div>
      </div>
      <div class="v96-requesthub-body ${mode}">${body}</div>
    </section>`;
  };

  // Remove legacy capture handlers that swallowed these controls before onclick could run.
  if(window.__v118RequestControlHandler) document.removeEventListener('click',window.__v118RequestControlHandler,true);
  if(window.__v119HubHandler) document.removeEventListener('click',window.__v119HubHandler,true);
})();

/* v121: stable role-based Requests & Availability workspace */
(function(){
  let v121ManagerRequestMode = 'queue';
  let v121EmployeeRequestMode = (typeof requestHubMode !== 'undefined' && requestHubMode === 'availability') ? 'availability' : 'requests';

  function v121User(){
    try { return currentUser(); } catch(e) { return null; }
  }
  function v121Business(){
    const u=v121User();
    return (state.businesses||[]).find(b=>b.id===u?.businessId) || null;
  }
  function v121IsManager(user){ return !!user && (user.role==='owner'||user.role==='manager'); }
  function v121RequestRows(managerMode){
    const u=v121User(), b=v121Business();
    if(!u) return [];
    return (state.requests||[])
      .filter(r=> managerMode ? (!!b && r.businessId===b.id) : r.employeeId===u.id)
      .sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
  }
  function v121AvailabilityRows(managerMode){
    const u=v121User(), b=v121Business();
    if(!u) return [];
    return (state.availability||[])
      .filter(a=> managerMode ? (!!b && a.businessId===b.id) : a.employeeId===u.id)
      .sort((a,b)=>String(b.date||b.createdAt||'').localeCompare(String(a.date||a.createdAt||'')));
  }
  function v121StatusLabel(status){
    const s=String(status||'pending').replace(/_/g,' ');
    return s.charAt(0).toUpperCase()+s.slice(1);
  }
  function v121AvailabilitySummary(a){
    const date=a.date?friendlyDate(a.date):(a.day||'Recurring day');
    const time=`${a.start||'00:00'}–${a.end||'23:59'}`;
    return `${date} · ${time}`;
  }
  function v121AvailabilityCard(a,managerMode){
    const related=(state.requests||[]).find(r=>r.availabilityId===a.id && r.status==='pending');
    const canDelete=!managerMode && ['pending','rejected'].includes(a.status||'pending');
    return `<article class="v121-avail-card status-${escAttr(a.status||'pending')}">
      <div class="v121-avail-date"><strong>${esc(a.date?new Date(a.date+'T00:00:00').toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'}):(a.day||'Availability'))}</strong><span>${esc(`${a.start||'00:00'}–${a.end||'23:59'}`)}</span></div>
      <div class="v121-avail-main"><strong>${managerMode?esc(userName(a.employeeId)):esc(a.reason||'Unavailable')}</strong><span>${managerMode?esc(a.reason||a.notes||'Unavailable'):esc(a.notes||'')}</span></div>
      <div class="v121-avail-actions"><span class="badge ${escAttr(a.status||'pending')}">${esc(v121StatusLabel(a.status))}</span>
        ${managerMode&&related?`<button type="button" class="tiny" onclick="return v121OpenRequest('${escAttr(related.id)}')">Review</button>`:''}
        ${canDelete?`<button type="button" class="tiny danger" onclick="deleteAvailability('${escAttr(a.id)}')">Delete</button>`:''}
      </div>
    </article>`;
  }
  function v121AvailabilityList(rows,managerMode){
    if(!rows.length) return `<div class="apple-empty-state qa-empty"><div class="apple-empty-icon">✓</div><h3>No availability exceptions</h3><p>${managerMode?'Employee unavailability will appear here.':'You are available by default until you submit an exception.'}</p></div>`;
    return `<div class="v121-avail-list">${rows.map(a=>v121AvailabilityCard(a,managerMode)).join('')}</div>`;
  }
  function v121Unread(r){
    const u=v121User();
    return !!u && (!Array.isArray(r.seenBy)||!r.seenBy.includes(u.id));
  }
  function v121RequestCard(r,managerMode){
    const action=managerMode&&r.status==='pending';
    return `<article class="v121-request-card ${v121Unread(r)?'is-new':''}">
      <button type="button" class="v121-request-open" onclick="return v121OpenRequest('${escAttr(r.id)}')">
        <div class="v121-request-copy"><span class="eyebrow">${esc(requestTypeLabel(r))}</span><strong>${esc(requestShortMessage(r))}</strong><small>${requestDateLine(r)}</small></div>
        <div class="v121-request-meta">${v121Unread(r)?'<span class="ios-badge new-dot">New</span>':''}${action?'<span class="ios-badge action-dot">Action needed</span>':''}<span class="badge ${escAttr(r.status||'pending')}">${esc(v121StatusLabel(r.status))}</span><em>Open</em></div>
      </button>
    </article>`;
  }
  function v121RequestQueue(managerMode){
    const all=v121RequestRows(managerMode);
    const pending=all.filter(r=>(r.status||'pending')==='pending');
    const history=all.filter(r=>(r.status||'pending')!=='pending');
    const filter=(typeof requestQueueFilter!=='undefined'?requestQueueFilter:'all')||'all';
    let visible=pending;
    if(filter==='new') visible=pending.filter(v121Unread);
    if(filter==='action') visible=pending;
    const newCount=pending.filter(v121Unread).length;
    return `<section class="v121-request-queue">
      <div class="v121-filter-row" role="tablist">
        <button type="button" class="${filter==='all'?'active':''}" onclick="return v121SetRequestFilter('all')">All <b>${pending.length}</b></button>
        <button type="button" class="${filter==='new'?'active':''}" onclick="return v121SetRequestFilter('new')">New <b>${newCount}</b></button>
        <button type="button" class="${filter==='action'?'active':''}" onclick="return v121SetRequestFilter('action')">Action needed <b>${pending.length}</b></button>
      </div>
      ${visible.length?`<div class="v121-request-list">${visible.map(r=>v121RequestCard(r,managerMode)).join('')}</div>`:`<div class="apple-empty-state qa-empty"><div class="apple-empty-icon">✓</div><h3>No matching requests</h3><p>Choose another filter or wait for a new request.</p></div>`}
      ${history.length?`<details class="apple-history"><summary>Completed requests (${history.length})</summary><div class="v121-request-list history">${history.map(r=>v121RequestCard(r,managerMode)).join('')}</div></details>`:''}
    </section>`;
  }

  window.v121SetRequestFilter=function(filter){
    requestQueueFilter=['all','new','action'].includes(filter)?filter:'all';
    v121RenderCurrent();
    return false;
  };
  window.v121SwitchEmployeeHub=function(mode){
    v121EmployeeRequestMode=mode==='availability'?'availability':'requests';
    requestHubMode=v121EmployeeRequestMode;
    currentView='requesthub';
    v121RenderCurrent();
    return false;
  };
  window.v121SwitchManagerHub=function(mode){
    v121ManagerRequestMode=mode==='availability'?'availability':'queue';
    currentView='requests';
    v121RenderCurrent();
    return false;
  };
  window.v121OpenRequest=function(id){
    const r=(state.requests||[]).find(x=>String(x.id)===String(id));
    if(!r){ toast('This request is no longer available.'); return false; }
    const u=v121User();
    if(u){ if(!Array.isArray(r.seenBy)) r.seenBy=[]; if(!r.seenBy.includes(u.id)){r.seenBy.push(u.id);saveState();} }
    const managerMode=v121IsManager(u);
    const a=r.availabilityId?(state.availability||[]).find(x=>x.id===r.availabilityId):null;
    const detail=a?`<div class="v121-review-grid"><div><span>Date</span><strong>${esc(a.date?friendlyDate(a.date):(a.day||'Recurring'))}</strong></div><div><span>Time</span><strong>${esc(`${a.start||'00:00'}–${a.end||'23:59'}`)}</strong></div><div><span>Reason</span><strong>${esc(a.reason||'Unavailable')}</strong></div><div><span>Status</span><strong>${esc(v121StatusLabel(a.status))}</strong></div></div>`:requestSnapshotText(r);
    modal(`<div class="request-review-modal v121-review-modal"><span class="eyebrow">${esc(requestTypeLabel(r))}</span><h3>${esc(requestShortMessage(r))}</h3><p class="muted">${requestDateLine(r)}</p>${detail}${r.message?`<div class="request-manager-note"><strong>Request note</strong><span>${esc(r.message)}</span></div>`:''}<div class="actions">${managerMode&&r.status==='pending'?`<button class="success" type="button" onclick="decideRequestAndClose('${escAttr(r.id)}','approve')">Approve</button><button class="danger" type="button" onclick="decideRequestAndClose('${escAttr(r.id)}','reject')">Reject</button>`:''}${managerMode&&r.shiftId?`<button type="button" onclick="closeModal();openWorkspaceSection('roster')">Open roster</button>`:''}<button type="button" onclick="closeModal()">Close</button></div></div>`);
    return false;
  };

  function v121EmployeeHub(){
    const u=v121User();
    if(!u||u.role!=='employee') return `<section class="apple-clean-page"><div class="apple-panel"><h2>Employee access required</h2><p>Sign in with an employee account to continue.</p></div></section>`;
    const mode=v121EmployeeRequestMode==='availability'?'availability':'requests';
    const body=mode==='availability'?`<section class="v121-availability-panel"><div class="panel-head"><div><h2>My availability</h2><p class="muted">You are available by default. Add only dates or times you cannot work.</p></div><button class="primary" type="button" onclick="openAvailabilityModal()">Add unavailable time</button></div>${v121AvailabilityList(v121AvailabilityRows(false),false)}</section>`:v121RequestQueue(false);
    return `<section class="apple-clean-page v121-hub"><div class="v121-hub-head"><div><span class="eyebrow">Employee workspace</span><h1>Requests & Availability</h1></div><div class="v121-segment"><button type="button" class="${mode==='requests'?'active':''}" onclick="return v121SwitchEmployeeHub('requests')">My requests</button><button type="button" class="${mode==='availability'?'active':''}" onclick="return v121SwitchEmployeeHub('availability')">Availability</button></div></div>${body}</section>`;
  }
  function v121ManagerHub(){
    const u=v121User();
    if(!v121IsManager(u)) return `<section class="apple-clean-page"><div class="apple-panel"><h2>Manager access required</h2></div></section>`;
    const queue=v121RequestRows(true).filter(r=>(r.status||'pending')==='pending').length;
    const availability=v121AvailabilityRows(true);
    const body=v121ManagerRequestMode==='availability'?`<section class="v121-availability-panel"><div class="panel-head"><div><h2>Team availability</h2><p class="muted">Review pending exceptions and see approved unavailable periods before building the roster.</p></div><button type="button" onclick="openWorkspaceSection('roster')">Open roster</button></div>${v121AvailabilityList(availability,true)}</section>`:v121RequestQueue(true);
    return `<section class="apple-clean-page v121-hub"><div class="v121-hub-head"><div><span class="eyebrow">${u.role==='owner'?'Owner':'Manager'} workspace</span><h1>Requests & Availability</h1><p class="muted">Review employee requests, approve availability changes, and keep roster decisions in one place.</p></div><div class="v121-segment"><button type="button" class="${v121ManagerRequestMode==='queue'?'active':''}" onclick="return v121SwitchManagerHub('queue')">Requests <b>${queue}</b></button><button type="button" class="${v121ManagerRequestMode==='availability'?'active':''}" onclick="return v121SwitchManagerHub('availability')">Availability <b>${availability.length}</b></button></div></div>${body}</section>`;
  }

  window.v121RenderCurrent=function(){
    const u=v121User();
    const view=el('view');
    if(!u||!view){ if(typeof render==='function') render(); return false; }
    try{
      if(u.role==='employee'){
        if(currentView==='availability'){v121EmployeeRequestMode='availability';requestHubMode='availability';currentView='requesthub';}
        if(currentView==='myrequests'){v121EmployeeRequestMode='requests';requestHubMode='requests';currentView='requesthub';}
        if(currentView==='requesthub') view.innerHTML=v121EmployeeHub();
        else if(currentView==='myshifts') view.innerHTML=employeeWorkView();
        else if(currentView==='teamschedule') view.innerHTML=v96TeamScheduleView();
        else if(currentView==='clock') view.innerHTML=clockView();
        else if(currentView==='notifications') view.innerHTML=notificationsView();
        else if(currentView==='profile') view.innerHTML=profileView();
        else {currentView='myshifts';view.innerHTML=employeeWorkView();}
      }else{
        if(currentView==='requests') view.innerHTML=v121ManagerHub();
        else if(currentView==='dashboard') view.innerHTML=managerDashboard();
        else if(currentView==='roster') view.innerHTML=rosterView();
        else if(currentView==='credentials'||currentView==='employees') {currentView='credentials';view.innerHTML=credentialsView();}
        else if(currentView==='timesheets') view.innerHTML=timesheetsView();
        else if(currentView==='reports') view.innerHTML=reportsView();
        else if(currentView==='settings'&&u.role==='owner') view.innerHTML=settingsView();
        else if(currentView==='notifications') view.innerHTML=notificationsView();
        else if(currentView==='profile') view.innerHTML=profileView();
        else {currentView='dashboard';view.innerHTML=managerDashboard();}
      }
      document.querySelectorAll('.nav button[data-view]').forEach(btn=>btn.classList.toggle('active',btn.dataset.view===currentView));
      return true;
    }catch(err){
      console.error('v121 render',currentView,err);
      // Never replace the whole screen with a dead fallback. Return to the role home.
      currentView=u.role==='employee'?'myshifts':'dashboard';
      view.innerHTML=u.role==='employee'?employeeWorkView():managerDashboard();
      toast('The page was refreshed safely. Please try the section again.');
      return false;
    }
  };

  employeeRequestsAvailabilityView=v121EmployeeHub;
  requestsView=function(managerMode){ return managerMode?v121ManagerHub():v121RequestQueue(false); };
  renderStableWorkspace=v121RenderCurrent;
  renderContent=v121RenderCurrent;

  const previousOpen=window.openWorkspaceSection;
  window.openWorkspaceSection=function(view,event){
    if(event){try{event.preventDefault();event.stopPropagation();}catch(e){}}
    const u=v121User();
    if(!u){toast('Please sign in to continue.');render();return false;}
    if(view==='availability'){v121EmployeeRequestMode='availability';requestHubMode='availability';view='requesthub';}
    if(view==='myrequests'||view==='requesthub'){if(view==='myrequests'){v121EmployeeRequestMode='requests';requestHubMode='requests';}view='requesthub';}
    if(view==='employees') view='credentials';
    currentView=view;
    try{sessionStorage.setItem(CURRENT_KEY,u.id);}catch(e){}
    if(!document.querySelector('.layout')) render();
    else v121RenderCurrent();
    requestAnimationFrame(()=>window.scrollTo({top:0,behavior:'auto'}));
    return false;
  };
  go=function(view){return window.openWorkspaceSection(view);};
  v96RequestHub=function(mode='requests'){return v121SwitchEmployeeHub(mode);};
})();


/* v122 — clean request status markup, plain email subjects, wider responsive roster email */
(function(){
  // Keep internal notification references in the record/body, but never place
  // technical reference codes in the visible email subject.
  brandedEmailSubject=function(subject){
    return String(subject||'Notification')
      .replace(/^My\s*Schedule\s*Alert\s*:?\s*/i,'')
      .replace(/^MySchedule\s*Alert\s*:?\s*/i,'')
      .replace(/\s*\[MS-[^\]]+\]\s*/gi,' ')
      .replace(/\s{2,}/g,' ')
      .trim() || 'MySchedule notification';
  };

  const v122PreviousBuildHtmlEmail=buildHtmlEmail;
  buildHtmlEmail=function(args){
    if(!args || args.type!=='roster') return v122PreviousBuildHtmlEmail(args||{});
    const shifts=Array.isArray(args.shifts)?args.shifts:[];
    const total=Number(args.totalHours||shifts.reduce((n,s)=>n+Number(s.hours||shiftHours(s)),0)).toFixed(1);
    const url=getScheduleEmailUrl(args.loginUrl);
    const rows=shifts.map((s,i)=>{
      const d=dateObj(s.date);
      const dateText=d.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'});
      const role=s.role&&s.role!=='Shift'?s.role:'Team Member';
      const loc=s.location&&s.location!=='Location TBA'?s.location:'Main Store';
      const time=`${formatEmailShiftTime(s.start)} – ${formatEmailShiftTime(s.end)}${emailShiftCrossesMidnight(s)?' next day':''}`;
      const hrs=Number(s.hours||shiftHours(s)).toFixed(1);
      return `<tr><td class="shift-date" width="34%" valign="top" style="padding:18px 20px;border-top:${i?'1px solid #dfe7f2':'0'};background:${i%2?'#f8fbff':'#ffffff'};"><div style="font-size:16px;line-height:22px;font-weight:800;color:#172033;">${esc(dateText)}</div></td><td class="shift-role" width="33%" valign="top" style="padding:18px 20px;border-top:${i?'1px solid #dfe7f2':'0'};background:${i%2?'#f8fbff':'#ffffff'};"><div style="font-size:14px;line-height:21px;font-weight:700;color:#344054;">${esc(role)}</div><div style="margin-top:3px;font-size:13px;line-height:19px;color:#667085;">${esc(loc)}</div></td><td class="shift-time" width="33%" valign="top" align="right" style="padding:18px 20px;border-top:${i?'1px solid #dfe7f2':'0'};background:${i%2?'#f8fbff':'#ffffff'};"><div style="font-size:15px;line-height:21px;font-weight:800;color:#0b5cff;white-space:nowrap;">${esc(time)}</div><div style="margin-top:3px;font-size:13px;line-height:19px;color:#667085;">${hrs} hrs</div></td></tr>`;
    }).join('');

    return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      @media only screen and (max-width:640px){
        .outer-pad{padding:10px 6px!important}.email-shell{width:100%!important;max-width:100%!important}.email-pad{padding-left:18px!important;padding-right:18px!important}.summary-right{display:block!important;text-align:left!important;padding-top:12px!important}.shift-head{display:none!important}.shift-date,.shift-role,.shift-time{display:block!important;width:auto!important;text-align:left!important;padding:14px 16px!important}.shift-role{padding-top:0!important}.shift-time{padding-top:0!important}.cta{display:block!important;width:auto!important;text-align:center!important}
      }
    </style></head><body style="margin:0;padding:0;background:#f3f6fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#172033;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f3f6fa;border-collapse:collapse;"><tr><td class="outer-pad" align="center" style="padding:34px 18px;"><!--[if mso]><table role="presentation" width="900" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]--><table class="email-shell" role="presentation" width="900" cellspacing="0" cellpadding="0" border="0" style="width:900px;max-width:900px;background:#ffffff;border:1px solid #dce4ef;border-radius:20px;overflow:hidden;border-collapse:separate;"><tr><td class="email-pad" style="padding:34px 42px;background:#0b2f6b;color:#ffffff;"><div style="font-size:20px;font-weight:800;">MySchedule</div><div style="margin-top:20px;font-size:32px;line-height:38px;font-weight:800;">Hi ${esc(args.toName)} 👋</div><div style="margin-top:9px;font-size:16px;line-height:24px;color:#eaf1ff;">Your upcoming shifts at <strong style="color:#ffffff;">${esc(args.businessName)}</strong> are ready.</div></td></tr><tr><td class="email-pad" style="padding:30px 42px 36px;"><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td valign="bottom"><div style="font-size:11px;letter-spacing:.5px;text-transform:uppercase;font-weight:800;color:#7a8494;">Schedule period</div><div style="margin-top:6px;font-size:18px;line-height:25px;font-weight:800;color:#172033;">${esc(args.weekStartText)} – ${esc(args.weekEndText)}</div></td><td class="summary-right" align="right" valign="bottom"><span style="display:inline-block;padding:8px 12px;border-radius:999px;background:#eef4ff;color:#0b5cff;font-size:12px;font-weight:800;">${shifts.length} shifts</span> <span style="display:inline-block;padding:8px 12px;border-radius:999px;background:#edf9f2;color:#157347;font-size:12px;font-weight:800;">${total} hrs</span></td></tr></table><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:20px;width:100%;border:1px solid #dfe7f2;border-radius:14px;overflow:hidden;border-collapse:separate;border-spacing:0;"><tr class="shift-head"><td width="34%" style="padding:12px 20px;background:#eef4ff;color:#49617f;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;">Day and date</td><td width="33%" style="padding:12px 20px;background:#eef4ff;color:#49617f;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;">Role and location</td><td width="33%" align="right" style="padding:12px 20px;background:#eef4ff;color:#49617f;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;">Shift time</td></tr>${rows}</table>${url?`<div style="padding-top:28px;text-align:center;"><a class="cta" href="${escAttr(url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 28px;border-radius:999px;background:#0b5cff;color:#ffffff;text-decoration:none;font-size:15px;font-weight:800;">View my schedule</a></div>`:''}<div style="margin-top:18px;text-align:center;font-size:13px;line-height:20px;color:#6b7280;">Open MySchedule to review shift notes and the latest schedule changes.</div></td></tr><tr><td align="center" style="padding:17px 24px;background:#f8fafc;border-top:1px solid #e5e7eb;color:#798292;font-size:12px;line-height:18px;">Sent by MySchedule for ${esc(args.businessName)}.<br>This is an automated notification. Replies are sent to your workplace owner.</td></tr></table><!--[if mso]></td></tr></table><![endif]--></td></tr></table></body></html>`;
  };
})();

/* v123 — balanced roster email width and MySchedule envelope name */
(function(){
  const previousBuildHtmlEmail = buildHtmlEmail;
  buildHtmlEmail = function(args){
    if(!args || args.type !== 'roster') return previousBuildHtmlEmail(args || {});

    const shifts = Array.isArray(args.shifts) ? args.shifts : [];
    const total = Number(args.totalHours || shifts.reduce((n,s)=>n + Number(s.hours || shiftHours(s)),0)).toFixed(1);
    const url = getScheduleEmailUrl(args.loginUrl);
    const rows = shifts.map((s,i)=>{
      const d = dateObj(s.date);
      const dateText = d.toLocaleDateString(undefined,{weekday:'long',month:'short',day:'numeric'});
      const role = s.role && s.role !== 'Shift' ? s.role : 'Team Member';
      const loc = s.location && s.location !== 'Location TBA' ? s.location : 'Main Store';
      const time = `${formatEmailShiftTime(s.start)} – ${formatEmailShiftTime(s.end)}${emailShiftCrossesMidnight(s) ? ' next day' : ''}`;
      const hrs = Number(s.hours || shiftHours(s)).toFixed(1);
      const bg = i % 2 ? '#f8fbff' : '#ffffff';
      return `<tr>
        <td class="shift-main" valign="top" style="padding:16px 18px;border-top:${i?'1px solid #dfe7f2':'0'};background:${bg};">
          <div style="font-size:15px;line-height:21px;font-weight:800;color:#172033;">${esc(dateText)}</div>
          <div style="margin-top:4px;font-size:13px;line-height:19px;color:#667085;">${esc(role)} · ${esc(loc)}</div>
        </td>
        <td class="shift-hours" valign="top" align="right" style="padding:16px 18px;border-top:${i?'1px solid #dfe7f2':'0'};background:${bg};white-space:nowrap;">
          <div style="font-size:15px;line-height:21px;font-weight:800;color:#0b5cff;">${esc(time)}</div>
          <div style="margin-top:4px;font-size:13px;line-height:19px;color:#667085;">${hrs} hrs</div>
        </td>
      </tr>`;
    }).join('');

    return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>
      @media only screen and (max-width:620px){
        .outer-pad{padding:12px 10px!important}
        .email-shell{width:100%!important;max-width:100%!important}
        .email-pad{padding-left:20px!important;padding-right:20px!important}
        .hero-title{font-size:27px!important;line-height:33px!important}
        .summary-right{display:block!important;text-align:left!important;padding-top:12px!important}
        .shift-main{width:58%!important;padding:14px 12px!important}
        .shift-hours{width:42%!important;padding:14px 12px!important}
        .cta{display:block!important;width:auto!important;text-align:center!important}
      }
    </style></head><body style="margin:0;padding:0;background:#f3f6fa;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:#172033;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#f3f6fa;border-collapse:collapse;"><tr><td class="outer-pad" align="center" style="padding:28px 16px;">
    <!--[if mso]><table role="presentation" width="720" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
    <table class="email-shell" role="presentation" width="720" cellspacing="0" cellpadding="0" border="0" style="width:720px;max-width:720px;background:#ffffff;border:1px solid #dce4ef;border-radius:20px;overflow:hidden;border-collapse:separate;">
      <tr><td class="email-pad" style="padding:30px 34px;background:#0b2f6b;color:#ffffff;">
        <div style="font-size:20px;font-weight:800;">MySchedule</div>
        <div class="hero-title" style="margin-top:18px;font-size:30px;line-height:36px;font-weight:800;">Hi ${esc(args.toName)} 👋</div>
        <div style="margin-top:8px;font-size:16px;line-height:24px;color:#eaf1ff;">Your upcoming shifts at <strong style="color:#ffffff;">${esc(args.businessName)}</strong> are ready.</div>
      </td></tr>
      <tr><td class="email-pad" style="padding:26px 34px 32px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0"><tr>
          <td valign="bottom"><div style="font-size:11px;letter-spacing:.5px;text-transform:uppercase;font-weight:800;color:#7a8494;">Schedule period</div><div style="margin-top:5px;font-size:17px;line-height:24px;font-weight:800;color:#172033;">${esc(args.weekStartText)} – ${esc(args.weekEndText)}</div></td>
          <td class="summary-right" align="right" valign="bottom"><span style="display:inline-block;padding:7px 10px;border-radius:999px;background:#eef4ff;color:#0b5cff;font-size:12px;font-weight:800;">${shifts.length} shifts</span> <span style="display:inline-block;padding:7px 10px;border-radius:999px;background:#edf9f2;color:#157347;font-size:12px;font-weight:800;">${total} hrs</span></td>
        </tr></table>
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin-top:18px;width:100%;border:1px solid #dfe7f2;border-radius:14px;overflow:hidden;border-collapse:separate;border-spacing:0;">
          <tr><td style="padding:11px 18px;background:#eef4ff;color:#49617f;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;">Shift</td><td align="right" style="padding:11px 18px;background:#eef4ff;color:#49617f;font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;">Time</td></tr>
          ${rows}
        </table>
        ${url?`<div style="padding-top:25px;text-align:center;"><a class="cta" href="${escAttr(url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;padding:14px 27px;border-radius:999px;background:#0b5cff;color:#ffffff;text-decoration:none;font-size:15px;font-weight:800;">View my schedule</a></div>`:''}
        <div style="margin-top:17px;text-align:center;font-size:13px;line-height:20px;color:#6b7280;">Open MySchedule to review shift notes and the latest schedule changes.</div>
      </td></tr>
      <tr><td align="center" style="padding:16px 22px;background:#f8fafc;border-top:1px solid #e5e7eb;color:#798292;font-size:12px;line-height:18px;">Sent by MySchedule for ${esc(args.businessName)}.<br>This is an automated notification. Replies are sent to your workplace owner.</td></tr>
    </table>
    <!--[if mso]></td></tr></table><![endif]-->
    </td></tr></table></body></html>`;
  };

  // Keep the envelope label branded while the actual employee name remains
  // inside the generated email greeting.
  const previousSendEmail = sendEmail;
  sendEmail = function(payload){
    return previousSendEmail({...payload, to_name:'MySchedule'});
  };
})();


/* v130 final Firebase authority: no device-only login, reliable cloud-first login */
(function(){
  login = async function(){
    const email = normalizeEmail(readCredentialFromInput("login-email", "email"));
    const password = cleanPassword(readCredentialFromInput("login-password", "password"));
    if(!isValidEmail(email) || !password) return toast("Enter your email and password.");
    try{
      const auth = requireAuth();
      await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION).catch(()=>{});
      if(auth.currentUser && normalizeEmail(auth.currentUser.email) !== email){
        await auth.signOut().catch(()=>{});
      }
      clearCurrentSession();
      const cred = await auth.signInWithEmailAndPassword(email, password);
      if(!cred.user.emailVerified){
        await cred.user.sendEmailVerification({url: window.location.href.split("#")[0]}).catch(()=>{});
        await auth.signOut().catch(()=>{});
        return toast("Please verify your email first.");
      }
      const cloudState = await loadFirebaseState();
      if(!cloudState){
        await auth.signOut().catch(()=>{});
        clearCurrentSession();
        return toast("Please try signing in again.");
      }
      state = migrateState(cloudState);
      startFirebaseLiveUpdates();
      await finishAuthLogin(cred.user);
    }catch(e){
      console.warn("Firebase login failed", e);
      toast(firebaseErrorMessage(e));
    }
  };
})();

/* v132: duplicate-safe team invitations and Apple-style dialogs */
(function(){
  const oldCloseModal = closeModal;
  modal = function(content){
    document.querySelectorAll('.modal-backdrop').forEach(node=>node.remove());
    document.body.insertAdjacentHTML('beforeend', `<div class="modal-backdrop apple-dialog-backdrop" role="presentation" onclick="if(event.target===this) closeModal()"><div class="modal apple-dialog" role="dialog" aria-modal="true" aria-label="MySchedule dialog" onclick="event.stopPropagation()"><button class="apple-dialog-close" type="button" aria-label="Close" onclick="closeModal()">×</button><div class="apple-dialog-content">${content}</div></div></div>`);
    const dialog = document.querySelector('.apple-dialog');
    const focusable = dialog?.querySelector('input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not(.apple-dialog-close)');
    setTimeout(()=>focusable?.focus({preventScroll:true}), 30);
  };
  closeModal = function(){ oldCloseModal(); };
  if(!window.__v132EscapeDialog){
    window.__v132EscapeDialog = true;
    document.addEventListener('keydown', e=>{ if(e.key==='Escape' && document.querySelector('.modal-backdrop')) closeModal(); });
  }

  openUserModal = function(){
    const owner = currentUser()?.role === 'owner';
    modal(`<div class="apple-team-dialog">
      <span class="eyebrow">Team access</span>
      <h2>Add team member</h2>
      <p class="muted">Enter the person once. MySchedule will recognise an existing team record and offer the correct action instead of creating a duplicate.</p>
      <div class="form-grid apple-team-form">
        <div><label for="u-name">Full name</label><input id="u-name" autocomplete="name" placeholder="Full name"></div>
        <div><label for="u-email">Email address</label><input id="u-email" type="email" autocomplete="email" inputmode="email" placeholder="employee@email.com"></div>
        <div><label for="u-role">Access level</label><select id="u-role">${owner?'<option value="manager">Manager</option>':''}<option value="employee">Employee</option></select></div>
        <div><label for="u-hire-date">Hire date</label><input id="u-hire-date" type="date" value="${isoDate(new Date())}"></div>
        <div><label for="u-type">Employment type</label><select id="u-type"><option value="casual">Casual</option><option value="part-time">Part-time</option><option value="full-time">Full-time</option></select></div>
        <div><label for="u-duty">Default duty</label><input id="u-duty" value="Team Member"></div>
        <div><label for="u-weekly">Weekly alert limit</label><input id="u-weekly" type="number" min="0" value="30"></div>
        <div><label for="u-fortnight">Fortnight alert limit</label><input id="u-fortnight" type="number" min="0" value="48"></div>
      </div>
      <div class="actions apple-dialog-actions"><button class="ghost" type="button" onclick="closeModal()">Cancel</button><button class="primary" type="button" onclick="saveUser()">Continue</button></div>
    </div>`);
  };

  function existingMemberDialog(existing){
    const pending = existing.status === 'invited' || existing.forcePasswordChange;
    modal(`<div class="apple-status-dialog">
      <div class="apple-status-icon">${pending?'✉':'✓'}</div>
      <span class="eyebrow">Already on this team</span>
      <h2>${esc(existing.name || existing.email)}</h2>
      <p><strong>${esc(existing.email)}</strong> is already linked to this workplace. No duplicate was created.</p>
      <div class="apple-person-summary"><span>${esc(existing.role || 'employee')}</span><span>${pending?'Setup pending':'Access active'}</span></div>
      <div class="actions apple-dialog-actions">
        <button class="ghost" type="button" onclick="closeModal()">Close</button>
        ${existing.role!=='owner'?`<button type="button" onclick="closeModal();setTimeout(()=>resendInvite('${escAttr(existing.id)}'),40)">Resend invite</button>`:''}
        <button class="primary" type="button" onclick="closeModal();setTimeout(()=>v97ManageUser('${escAttr(existing.id)}'),40)">Manage member</button>
      </div>
    </div>`);
  }

  saveUser = function(){
    const b = business();
    if(!b || !requireManagerForBusiness(b.id)) return;
    const name = String(val('u-name')||'').trim();
    const inviteEmail = normalizeEmail(val('u-email'));
    const role = val('u-role') || 'employee';
    const hireDate = val('u-hire-date') || isoDate(new Date());
    if(!name || !inviteEmail) return toast('Enter the member name and email.');
    if(!isValidEmail(inviteEmail)) return toast('Enter a valid email address.');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(hireDate)) return toast('Select a valid hire date.');

    const existing = state.users.find(u=>normalizeEmail(u.email)===inviteEmail);
    if(existing && existing.status !== 'removed'){
      if(existing.businessId === b.id) return existingMemberDialog(existing);
      return modal(`<div class="apple-status-dialog"><div class="apple-status-icon warning">!</div><span class="eyebrow">Email already linked</span><h2>Use a different email</h2><p>This email belongs to another MySchedule workplace. A team account can currently be linked to one workplace at a time.</p><div class="actions apple-dialog-actions"><button class="primary" onclick="closeModal()">OK</button></div></div>`);
    }

    if(existing && existing.status === 'removed' && existing.businessId === b.id){
      existing.name = name;
      existing.role = role;
      existing.hireDate = hireDate;
      existing.status = 'invited';
      existing.notifyEmail = true;
      existing.notifyInApp = true;
      existing.forcePasswordChange = true;
      existing.tempPassword = existing.tempPassword || v96GenerateTempPassword();
      existing.updatedAt = now();
      if(role === 'employee'){
        let profile = state.employees.find(e=>e.userId===existing.id);
        const values = {businessId:b.id,userId:existing.id,hireDate,employmentType:val('u-type')||'casual',visaTracking:true,fortnightLimit:Number(val('u-fortnight'))||48,weeklyLimit:Number(val('u-weekly'))||30,preferredHours:20,roleLabel:val('u-duty')||'Team Member',status:'active'};
        if(profile) Object.assign(profile,values); else state.employees.push({id:existing.id,...values});
      }
      saveState();
      closeModal();
      renderContent();
      setTimeout(()=>resendInvite(existing.id),50);
      return;
    }

    const id = uuid();
    const tempPassword = v96GenerateTempPassword();
    state.users.push({id,businessId:b.id,name,email:inviteEmail,role,status:'invited',hireDate,notifyEmail:true,notifyInApp:true,emailVerified:false,tempPassword,forcePasswordChange:true,createdAt:now()});
    if(role==='employee') state.employees.push({id,businessId:b.id,userId:id,hireDate,employmentType:val('u-type')||'casual',visaTracking:true,fortnightLimit:Number(val('u-fortnight'))||48,weeklyLimit:Number(val('u-weekly'))||30,preferredHours:20,roleLabel:val('u-duty')||'Team Member',status:'active'});
    saveState();
    const loginUrl=window.location.href.split('#')[0];
    notifyUser(id,'invite','Your MySchedule workplace access',`Hi ${name}, you have been invited to ${b.name}. Open ${loginUrl} and use ${inviteEmail} to join your workplace.`,{forceToEmail:inviteEmail,recipientSource:'invite_box',templateType:'invite',loginUrl,tempPassword});
    notifyRole(['owner','manager'],'invite','New team member',`${name} was added as ${role}.`);
    closeModal();
    renderContent();
    showCredentialModal({id,name,email:inviteEmail,role,businessName:b.name,tempPassword});
  };
})();

/* v133 secure access compliance: one-time invitations, join approvals, explicit action alerts */
(function(){
  const V133_REGION = 'us-central1';
  const V133_INVITE_KEY = 'myschedule_v133_invite_token';
  const V133_PENDING_ACCESS_KEY = 'myschedule_v133_pending_access';
  let v133BusinessId = '';
  let v133MembershipRole = '';
  let v133Functions = null;
  let v133InviteSummary = null;

  function v133InitFunctions(){
    initFirebase();
    if(!firebaseReady || typeof firebase === 'undefined' || !firebase.functions){
      throw new Error('Secure Firebase Functions are not available. Deploy the included functions folder and refresh.');
    }
    if(!v133Functions) v133Functions = firebase.app().functions(V133_REGION);
    return v133Functions;
  }
  async function v133Call(name, data={}){
    if(typeof window.__v135CompatCall === 'function') return window.__v135CompatCall(name, data);
    let lastError=null;
    for(let attempt=0;attempt<2;attempt++){
      try{
        if(attempt===1 && firebaseAuth?.currentUser?.getIdToken) await firebaseAuth.currentUser.getIdToken(true).catch(()=>{});
        const result = await v133InitFunctions().httpsCallable(name)(data);
        return result?.data || {};
      }catch(error){
        lastError=error;
        const code=String(error?.code||'').replace(/^functions\//,'');
        if(attempt===0 && ['internal','unavailable','deadline-exceeded','unknown'].includes(code)){
          await new Promise(r=>setTimeout(r,450));
          continue;
        }
        break;
      }
    }
    const error=lastError||{};
    const details=error?.details;
    const detailMessage=typeof details==='string'?details:(details&&typeof details.message==='string'?details.message:'');
    let raw=detailMessage||error?.message||String(error||'Secure service error.');
    raw=raw.replace(/^FirebaseError:\s*/i,'').replace(/^functions\/[a-z-]+:\s*/i,'').trim();
    const code=String(error?.code||'').replace(/^functions\//,'');
    if(['not-found','unimplemented'].includes(code)||/not found/i.test(raw)){
      raw='The MySchedule secure backend is not deployed to Firebase project myschedule-8f213. Deploy the included functions, rules and indexes, then refresh.';
    }else if(code==='internal' && (!raw || /^internal$/i.test(raw))){
      raw='The secure backend could not complete account linking. Deploy the v134 backend repair, then sign in again.';
    }else if(code==='unavailable'){
      raw='The secure backend is temporarily unavailable. Confirm the functions were deployed to myschedule-8f213 and try again.';
    }
    const wrapped=new Error(raw||'The secure MySchedule service could not complete this request.');
    wrapped.code=code;
    wrapped.details=details||null;
    throw wrapped;
  }
  function v133CaptureAccessLink(){
    try{
      const url = new URL(location.href);
      const token = url.searchParams.get('invite');
      if(token && token.length > 30){
        sessionStorage.setItem(V133_INVITE_KEY, token);
        localStorage.setItem(V133_INVITE_KEY, token);
        url.searchParams.delete('invite');
        history.replaceState(null,'',url.pathname + (url.search ? url.search : '') + (url.hash || ''));
      }
    }catch(e){}
  }
  function v133InviteToken(){
    try{return sessionStorage.getItem(V133_INVITE_KEY) || localStorage.getItem(V133_INVITE_KEY) || '';}catch(e){return '';}
  }
  function v133ClearInviteToken(){
    try{sessionStorage.removeItem(V133_INVITE_KEY);localStorage.removeItem(V133_INVITE_KEY);}catch(e){}
  }
  function v133PendingAccess(){
    try{return JSON.parse(localStorage.getItem(V133_PENDING_ACCESS_KEY)||'null');}catch(e){return null;}
  }
  function v133SetPendingAccess(value){
    try{if(value)localStorage.setItem(V133_PENDING_ACCESS_KEY,JSON.stringify(value));else localStorage.removeItem(V133_PENDING_ACCESS_KEY);}catch(e){}
  }
  function v133SecureLink(token){
    const url = new URL(window.location.href.split('#')[0]);
    url.searchParams.set('invite', token);
    return url.toString();
  }
  function v133StatusText(status){
    return ({pending:'Pending',accepted:'Accepted',expired:'Expired',revoked:'Revoked',approved:'Approved',rejected:'Rejected'}[status]||status||'Unknown');
  }
  v133CaptureAccessLink();

  const v133OldMigrate = migrateState;
  migrateState = function(data){
    const out = v133OldMigrate(data || defaultState());
    if(!Array.isArray(out.joinRequests)) out.joinRequests=[];
    if(!Array.isArray(out.accessInvitations)) out.accessInvitations=[];
    out.notifications.forEach(n=>{
      if(typeof n.requiresAction!=='boolean') n.requiresAction = !!(n.requestId && (out.requests||[]).some(r=>r.id===n.requestId&&r.status==='pending'));
      if(!n.actionStatus) n.actionStatus = n.requiresAction ? 'pending' : 'informational';
      if(!n.entityId) n.entityId = n.requestId || n.shiftId || '';
    });
    out.users.forEach(u=>{delete u.tempPassword;delete u.localPassword;delete u.password;delete u.forcePasswordChange;});
    return out;
  };

  loadFirebaseState = async function(){
    if(!initFirebase() || !firebaseAuth) return null;
    const user = firebaseAuth.currentUser || await waitForFirebaseAuthInitialState();
    if(!user || !user.emailVerified) return null;
    const payload = await v133Call('loadWorkspaceState');
    v133BusinessId = payload.businessId || '';
    v133MembershipRole = payload.role || '';
    cloudRevision = Number(payload.revision || 0);
    return payload.state ? migrateState(payload.state) : null;
  };
  loadState = async function(){
    try{
      const cloud = await loadFirebaseState();
      return cloud || migrateState(defaultState());
    }catch(error){
      console.warn('Secure workspace load unavailable',error);
      return migrateState(defaultState());
    }
  };
  saveFirebaseState = async function(snapshotOverride){
    if(!state || !firebaseAuth?.currentUser || !firebaseAuth.currentUser.emailVerified) return false;
    try{
      const payload = await v133Call('saveWorkspaceState',{state:snapshotOverride||state,expectedRevision:cloudRevision});
      cloudRevision = Number(payload.revision || cloudRevision);
      return !!payload.ok;
    }catch(error){
      console.warn('Secure save failed',error);
      toast(error.message || 'Secure cloud save failed.');
      return false;
    }
  };
  startFirebaseLiveUpdates = function(){
    if(!initFirebase() || !v133BusinessId || firebaseLiveUnsubscribe) return;
    if(v133MembershipRole==='employee'){
      const timer=setInterval(async()=>{
        if(!firebaseAuth?.currentUser?.emailVerified||!currentUser())return;
        try{
          const before=cloudRevision;const payload=await v133Call('loadWorkspaceState');
          if(Number(payload.revision||0)<=before)return;
          v133BusinessId=payload.businessId||v133BusinessId;v133MembershipRole=payload.role||v133MembershipRole;cloudRevision=Number(payload.revision||before);
          isApplyingCloudState=true;state=migrateState(payload.state);render();isApplyingCloudState=false;
        }catch(error){console.warn('Secure employee refresh paused',error);}
      },30000);
      firebaseLiveUnsubscribe=()=>clearInterval(timer);
      return;
    }
    if(!firebaseDb)return;
    firebaseLiveUnsubscribe = firebaseDb.collection('secureBusinesses').doc(v133BusinessId).onSnapshot(snap=>{
      if(!snap.exists || !snap.data()?.state) return;
      const remoteRevision = Number(snap.data().revision||0);
      if(remoteRevision <= cloudRevision || cloudSaveRunning || pendingCloudSnapshot) return;
      cloudRevision = remoteRevision;
      isApplyingCloudState = true;
      state = migrateState(snap.data().state);
      const u=currentUser();
      if(u) render();
      isApplyingCloudState = false;
    },err=>console.warn('Secure live update paused',err));
  };
  cloudStatusBadge = function(){return `<span class="badge good">Secure role-protected cloud</span>`;};

  const v133BaseLoginView = loginView;
  loginView = function(){
    let html = v133BaseLoginView();
    const joinFields = `<div id="signup-join-fields" class="hidden v133-join-fields">
      <div id="v133-invite-summary" class="notice hidden"></div>
      <div id="v133-business-code-wrap"><label>Workplace code</label><input id="signup-business-code" autocomplete="one-time-code" inputmode="text" placeholder="Example: CAFE92AB"><p class="small muted">Enter the code supplied by your workplace. Your request will still require owner or manager approval.</p></div>
    </div>`;
    html = html.replace('          <label>Full name</label>', `${joinFields}\n          <label>Full name</label>`);
    html = html.replace('Team members can join after their email is added by a manager.','Use a secure invitation link, or enter a workplace code to request approval.');
    html = html.replace('<option value="owner">Owner</option><option value="manager">Manager</option>','<option value="owner">Owner</option>');
    return html;
  };
  updateSignupFields = function(){
    const type = val('signup-type') || 'create-business';
    const isCreate = type === 'create-business';
    el('signup-business-fields')?.classList.toggle('hidden',!isCreate);
    el('signup-join-fields')?.classList.toggle('hidden',isCreate);
    const help=el('signup-help');
    if(help) help.textContent=isCreate?'Create a verified owner/manager workspace.':'Use the invitation email exactly, or enter your workplace code to send an approval request.';
    if(!isCreate) setTimeout(v133RefreshInviteSummary,0);
  };
  async function v133RefreshInviteSummary(){
    const host=el('v133-invite-summary');
    const codeWrap=el('v133-business-code-wrap');
    if(!host) return;
    const token=v133InviteToken();
    if(!token){host.classList.add('hidden');codeWrap?.classList.remove('hidden');return;}
    host.classList.remove('hidden'); host.className='notice'; host.textContent='Checking invitation…';
    try{
      const info=await v133Call('getInvitation',{token}); v133InviteSummary=info;
      if(info.status==='pending'){
        host.className='notice oknotice';
        host.innerHTML=`<strong>Workplace invitation found</strong><br>${esc(info.name||'Team member')} · ${esc(info.role||'employee')} · invited by ${esc(info.invitedByName||'your workplace')} · expires ${esc(info.expiresAt?dateTime(info.expiresAt):'soon')}.`;
        codeWrap?.classList.add('hidden');
      }else{
        host.className='notice warnnotice'; host.textContent=`This invitation is ${v133StatusText(info.status).toLowerCase()}. Ask the owner or manager for a new link.`; codeWrap?.classList.remove('hidden');
      }
    }catch(error){
      v133InviteSummary=null; host.className='notice warnnotice'; host.textContent=error.message||'Invitation could not be verified.'; codeWrap?.classList.remove('hidden');
    }
  }
  window.v133RefreshInviteSummary=v133RefreshInviteSummary;

  createAccount = async function(){
    const type=val('signup-type')||'create-business';
    const name=String(val('signup-name')||'').trim();
    const email=normalizeEmail(val('signup-email'));
    const password=cleanPassword(val('signup-password'));
    if(!name||!isValidEmail(email)||password.length<6) return toast('Enter your name, a valid email, and a password with at least 6 characters.');
    const businessName=String(val('signup-business-name')||'').trim();
    const code=String(val('signup-business-code')||'').trim();
    const token=v133InviteToken();
    if(type==='create-business'&&!businessName) return toast('Enter your business name.');
    let cred=null;
    try{
      const auth=requireAuth();
      await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION).catch(()=>{});
      cred=await auth.createUserWithEmailAndPassword(email,password);
      await cred.user.updateProfile({displayName:name}).catch(()=>{});
      if(type==='create-business'){
        await v133Call('createWorkspace',{businessName,industry:selectedSignupIndustry(),role:val('signup-role')||'owner',name,country:/^America\//.test(detectedDeviceTimezone())?'Canada':'Australia',timezone:detectedDeviceTimezone()});
      }else if(token){
        v133SetPendingAccess({type:'invite',token,name,email,createdAt:now()});
      }else if(code){
        v133SetPendingAccess({type:'join',businessCode:code,name,email,createdAt:now()});
      }else{
        v133SetPendingAccess({type:'email_invite',name,email,createdAt:now()});
      }
      await cred.user.sendEmailVerification({url:window.location.href.split('#')[0]});
      await auth.signOut(); clearCurrentSession(); setAuthMode('login');
      toast(type==='create-business'?'Workspace created. Verify your email, then sign in.':'Account created. Verify your email, then sign in to complete the secure access request.');
    }catch(error){
      console.warn('v133 account creation',error);
      if(cred?.user && type==='create-business') await cred.user.delete().catch(()=>{});
      toast(firebaseErrorMessage(error)||error.message||'Account could not be created.');
    }
  };

  finishAuthLogin = async function(authUser){
    const email=normalizeEmail(authUser?.email||'');
    if(!authUser?.emailVerified||!email){await firebaseAuth?.signOut().catch(()=>{});clearCurrentSession();return toast('Verify your email before signing in.');}
    let user=state.users.find(u=>u.authUid===authUser.uid&&u.status!=='removed');
    if(!user) user=state.users.find(u=>normalizeEmail(u.email)===email&&u.status!=='removed'&&!['join_rejected','invitation_revoked'].includes(u.status));
    if(!user){await firebaseAuth.signOut().catch(()=>{});clearCurrentSession();return toast('No approved MySchedule workplace is linked to this account.');}
    user.authUid=authUser.uid;user.emailVerified=true;user.status='active';user.lastLoginAt=now();
    delete user.tempPassword;delete user.localPassword;delete user.password;delete user.forcePasswordChange;
    setCurrentSession(user.id);currentView=isManagerial(user)?'dashboard':'myshifts';render();toast('Signed in successfully.');return true;
  };

  login = async function(){
    const email=normalizeEmail(readCredentialFromInput('login-email','email'));
    const password=cleanPassword(readCredentialFromInput('login-password','password'));
    if(!isValidEmail(email)||!password) return toast('Enter your email and password.');
    try{
      const auth=requireAuth();
      await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION).catch(()=>{});
      if(auth.currentUser&&normalizeEmail(auth.currentUser.email)!==email) await auth.signOut().catch(()=>{});
      clearCurrentSession();
      const cred=await auth.signInWithEmailAndPassword(email,password);
      if(!cred.user.emailVerified){
        await cred.user.sendEmailVerification({url:window.location.href.split('#')[0]}).catch(()=>{});
        await auth.signOut().catch(()=>{});
        return toast('Verify your email first. A new verification email was requested.');
      }
      await cred.user.getIdToken(true).catch(()=>{});
      const pending=v133PendingAccess();
      const directToken=v133InviteToken();
      if((pending?.type==='invite'&&pending.token)||directToken){
        await v133Call('acceptInvitation',{token:pending?.token||directToken});
        v133SetPendingAccess(null);v133ClearInviteToken();
      }else if(pending?.type==='join'){
        const result=await v133Call('submitJoinRequest',{businessCode:pending.businessCode,name:pending.name||cred.user.displayName||email});
        v133SetPendingAccess(null);
        await auth.signOut().catch(()=>{});clearCurrentSession();
        return toast(`Join request sent to ${result.businessName||'the workplace'}. Sign in after it is approved.`);
      }
      await v133Call('repairMyAccess');
      let cloud;
      try{cloud=await loadFirebaseState();}
      catch(loadError){
        const status=await v133Call('getAccessStatus').catch(()=>({status:'none',message:loadError.message}));
        await auth.signOut().catch(()=>{});clearCurrentSession();
        return toast(status.message||'No approved workplace access is linked to this account.');
      }
      if(!cloud) throw new Error('Secure workplace data could not be loaded.');
      state=migrateState(cloud);
      await v133Call('recordVerifiedLogin').catch(console.warn);
      const refreshed=await loadFirebaseState(); if(refreshed) state=migrateState(refreshed);
      startFirebaseLiveUpdates();
      await finishAuthLogin(cred.user);
    }catch(error){
      console.warn('v133 login failed',error);
      toast(firebaseErrorMessage(error)||error.message||'Sign in failed.');
    }
  };

  notifyUser = function(userId,type,subject,message,options={}){
    const user=state.users.find(u=>u.id===userId); if(!user) return null;
    const b=state.businesses.find(x=>x.id===user.businessId)||business(); if(!b) return null;
    const recipientEmail=String(options.forceToEmail||user.email||'').trim().toLowerCase();
    const recipientName=user.name||recipientEmail;
    if(!recipientEmail||!isValidEmail(recipientEmail)) return null;
    const refId=generateNotificationRef();
    const emailSubject=brandedEmailSubject(subject,refId);
    const emailMessage=appendReferenceToMessage(message,refId);
    const requiresAction=options.requiresAction===true;
    const note={id:uuid(),refId,businessId:b.id,userId:user.id,toUserId:user.id,to:recipientEmail,toName:recipientName,role:user.role,type,subject:emailSubject,originalSubject:subject,message:emailMessage,originalMessage:message,recipientSource:options.recipientSource||'user_profile_email',emailStatus:user.notifyEmail===false?'email_disabled':(state.emailConfig.enabled?'sending':'sent_demo'),read:false,createdAt:now(),requestId:options.requestId||'',shiftId:options.shiftId||'',targetView:options.targetView||'notifications',entityId:options.entityId||options.requestId||options.shiftId||'',requiresAction,actionStatus:requiresAction?'pending':'informational',actionKind:options.actionKind||'',templateType:options.templateType||type||'',templateData:{weekStartText:options.weekStartText||'',weekEndText:options.weekEndText||'',totalShifts:options.totalShifts||'',totalHours:options.totalHours||'',shifts:Array.isArray(options.shifts)?options.shifts.map(s=>({...s})):[]}};
    state.notifications.push(note);saveState();
    if(user.notifyEmail!==false&&state.emailConfig.enabled&&options.inAppOnly!==true){
      sendEmail({noteId:note.id,to_email:recipientEmail,to_name:recipientName,subject:emailSubject,message:emailMessage,notification_ref:refId,business_name:b.name,recipientSource:note.recipientSource,html_message:buildHtmlEmail({type:options.templateType||type,toName:recipientName,subject:emailSubject,message:emailMessage,businessName:b.name,loginUrl:options.loginUrl||getPublicAppUrl(),tempPassword:'',shifts:options.shifts||[],weekStartText:options.weekStartText||'',weekEndText:options.weekEndText||'',totalShifts:options.totalShifts||'',totalHours:options.totalHours||''})});
    }
    return note;
  };
  notifyRole = function(roles,type,subject,message,options={}){
    const b=business(); if(!b) return;
    state.users.filter(u=>u.businessId===b.id&&roles.includes(u.role)&&u.status==='active').forEach(u=>notifyUser(u.id,type,subject,message,options));
  };

  notificationNeedsAction = function(n){return n?.requiresAction===true && !['resolved','completed','cancelled'].includes(n.actionStatus);};
  notificationPriority = function(n){
    const parts=[];if(!n.read)parts.push('<span class="badge new">New</span>');if(notificationNeedsAction(n))parts.push('<span class="badge action-needed">Action needed</span>');return parts.join(' ')||'<span class="small muted">Read</span>';
  };
  notificationActionLabel = function(n){
    if(n.actionKind==='join_request') return 'Review access';
    if(n.actionKind==='invite_expired') return 'Review invitation';
    if(n.requestId) return 'Open request';
    if(n.targetView==='timesheets') return 'Review timesheet';
    if(n.targetView==='roster'||String(n.type||'').includes('schedule')) return 'Open schedule';
    return n.targetView&&n.targetView!=='notifications'?'Open section':'Open';
  };
  actionNeededCount = function(user){
    if(!user) return 0; const keys=new Set();
    state.notifications.filter(n=>n.userId===user.id&&notificationNeedsAction(n)).forEach(n=>{
      const prefix=n.actionKind==='join_request'?'j':(n.requestId?'r':'n');
      keys.add(`${prefix}:${n.entityId||n.requestId||n.id}`);
    });
    if(isManagerial(user)){
      (state.requests||[]).filter(r=>r.businessId===user.businessId&&r.status==='pending').forEach(r=>keys.add(`r:${r.id}`));
      (state.joinRequests||[]).filter(r=>r.businessId===user.businessId&&r.status==='pending').forEach(r=>keys.add(`j:${r.id}`));
    }else (state.requests||[]).filter(r=>r.employeeId===user.id&&r.status==='pending').forEach(r=>keys.add(`r:${r.id}`));
    return keys.size;
  };
  openNotification = function(id){
    const n=state.notifications.find(x=>x.id===id);if(!n)return toast('Notification not found.');
    n.read=true;saveState();
    if(n.actionKind==='join_request'&&n.entityId){v133OpenJoinRequest(n.entityId);return;}
    if(n.requestId&&(state.requests||[]).some(r=>r.id===n.requestId)){requestDetailModal(n.requestId);return;}
    const target=n.targetView||'';
    if(target&&target!=='notifications'){go(target);return;}
    modal(`<span class="eyebrow">${esc(n.type||'Notification')}</span><h2>${esc(n.originalSubject||n.subject||'Notification')}</h2><p>${esc(n.originalMessage||n.message||'')}</p><div class="actions"><button class="primary" onclick="closeModal()">Done</button></div>`);
  };

  const v133OldUpdateEmailStatus=updateEmailStatus;
  updateEmailStatus=function(noteId,status,errorMessage=''){
    v133OldUpdateEmailStatus(noteId,status,errorMessage);
    if(!['failed','invalid_recipient','missing_settings'].includes(status)) return;
    const failed=state.notifications.find(n=>n.id===noteId);if(!failed||failed.type==='email_failure')return;
    const b=state.businesses.find(x=>x.id===failed.businessId);if(!b)return;
    state.users.filter(u=>u.businessId===b.id&&['owner','manager'].includes(u.role)&&u.status==='active').forEach(u=>{
      if(state.notifications.some(n=>n.userId===u.id&&n.type==='email_failure'&&n.entityId===noteId&&notificationNeedsAction(n)))return;
      state.notifications.push({id:uuid(),refId:generateNotificationRef(),businessId:b.id,userId:u.id,toUserId:u.id,to:u.email,toName:u.name,role:u.role,type:'email_failure',subject:'Email delivery requires attention',originalSubject:'Email delivery requires attention',message:`Delivery to ${failed.to||'a user'} failed: ${errorMessage||status}`,originalMessage:`Delivery to ${failed.to||'a user'} failed: ${errorMessage||status}`,recipientSource:'delivery_monitor',emailStatus:'in_app',read:false,createdAt:now(),targetView:u.role==='owner'?'settings':'notifications',entityId:noteId,requiresAction:true,actionStatus:'pending',actionKind:'email_failure'});
    });saveState();
  };

  function v133InvitePayload(){
    return {name:String(val('u-name')||'').trim(),email:normalizeEmail(val('u-email')),role:val('u-role')||'employee',hireDate:val('u-hire-date')||isoDate(new Date()),employmentType:val('u-type')||'casual',roleLabel:val('u-duty')||'Team Member',weeklyLimit:Number(val('u-weekly'))||30,fortnightLimit:Number(val('u-fortnight'))||48};
  }
  function v133InviteResultModal(result,link){
    modal(`<div class="apple-status-dialog"><div class="apple-status-icon">✓</div><span class="eyebrow">Secure invitation created</span><h2>${esc(result.name||result.email)}</h2><p>This one-time link expires on <strong>${esc(dateTime(result.expiresAt))}</strong>. It can only be accepted by <strong>${esc(result.email)}</strong>.</p><div class="credential-card"><div class="cred-row"><span>Invited by</span><strong>${esc(result.invitedByName||currentUser()?.name||'Manager')}</strong></div><div class="cred-row"><span>Role</span><strong>${esc(result.role)}</strong></div><div class="cred-row"><span>Secure link</span><strong class="v133-break-link">${esc(link)}</strong></div></div><div class="actions apple-dialog-actions"><button type="button" onclick="v97CopyField('${escAttr(link)}','Secure invitation link copied')">Copy link</button><button class="primary" onclick="closeModal()">Done</button></div></div>`);
  }
  saveUser = async function(){
    const b=business();if(!b||!requireManagerForBusiness(b.id))return;
    const p=v133InvitePayload();
    if(!p.name||!isValidEmail(p.email))return toast('Enter the member name and a valid email address.');
    try{
      const result=await v133Call('createInvitation',p);
      const cloud=await loadFirebaseState();if(cloud)state=migrateState(cloud);
      const link=v133SecureLink(result.token);
      notifyUser(result.userId,'invite','MySchedule workplace invitation',`Hi ${result.name}, ${result.invitedByName||'your workplace'} invited you to ${b.name} as ${result.role}. Open the secure one-time link before ${dateTime(result.expiresAt)}: ${link}`,{forceToEmail:result.email,recipientSource:'secure_invitation',templateType:'invite',loginUrl:link,requiresAction:true,targetView:result.role==='employee'?'myshifts':'dashboard',entityId:result.userId,actionKind:'accept_invitation'});
      notifyRole(['owner','manager'],'invite_created','Team invitation created',`${result.name} was invited as ${result.role} by ${result.invitedByName||currentUser()?.name}.`,{targetView:'credentials',entityId:result.userId,inAppOnly:true});
      closeModal();renderContent();v133InviteResultModal(result,link);
    }catch(error){toast(error.message||'Invitation could not be created.');}
  };
  resendInvite = async function(userId){
    const u=state.users.find(x=>x.id===userId);if(!u)return toast('Team member not found.');
    try{
      const emp=state.employees.find(e=>e.userId===u.id)||{};
      const result=await v133Call('createInvitation',{name:u.name,email:u.email,role:u.role,hireDate:u.hireDate||emp.hireDate,employmentType:emp.employmentType,roleLabel:emp.roleLabel,weeklyLimit:emp.weeklyLimit,fortnightLimit:emp.fortnightLimit});
      const cloud=await loadFirebaseState();if(cloud)state=migrateState(cloud);
      const link=v133SecureLink(result.token);
      notifyUser(result.userId,'invite','New MySchedule workplace invitation',`A new one-time invitation link was created for ${business()?.name}. The previous pending link is no longer valid. Open before ${dateTime(result.expiresAt)}: ${link}`,{forceToEmail:result.email,recipientSource:'secure_invitation_resend',templateType:'invite',loginUrl:link,requiresAction:true,targetView:result.role==='employee'?'myshifts':'dashboard',entityId:result.userId,actionKind:'accept_invitation'});
      renderContent();v133InviteResultModal(result,link);
    }catch(error){toast(error.message||'Invitation could not be resent.');}
  };
  window.v133RevokeInvitation=async function(invitationId){
    if(!confirm('Revoke this pending invitation? The link will stop working immediately.'))return;
    try{
      const result=await v133Call('revokeInvitation',{invitationId});
      const cloud=await loadFirebaseState();if(cloud)state=migrateState(cloud);renderContent();
      if(result.email){
        const note=(state.notifications||[]).find(n=>n.userId===result.userId&&n.type==='invite_revoked'&&n.entityId===invitationId);
        const message=`Hi ${result.name||'team member'}, your invitation to ${result.businessName||'the workplace'} was revoked. Contact the owner or manager if you still require access.`;
        await sendEmail({noteId:note?.id||'',to_email:result.email,to_name:result.name||result.email,subject:'MySchedule invitation revoked',message,notification_ref:generateNotificationRef(),business_name:result.businessName||'Workplace',html_message:buildHtmlEmail({type:'invite',toName:result.name||result.email,subject:'MySchedule invitation revoked',message,businessName:result.businessName||'Workplace',loginUrl:getPublicAppUrl()})}).catch(console.warn);
      }
      toast('Invitation revoked.');
    }catch(error){toast(error.message||'Invitation could not be revoked.');}
  };

  function v133AccessPanel(){
    const user=currentUser();if(!isManagerial(user))return '';
    const joins=(state.joinRequests||[]).filter(r=>r.businessId===user.businessId).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
    const pendingJoins=joins.filter(r=>r.status==='pending');
    const invites=(state.accessInvitations||[]).filter(i=>i.businessId===user.businessId).sort((a,b)=>(b.createdAt||'').localeCompare(a.createdAt||''));
    return `<section class="apple-panel v133-access-panel"><div class="apple-panel-head"><div><h3>Access approvals</h3><p>Secure invitations and employee-created join requests.</p></div><span class="status-pill ${pendingJoins.length?'warning':''}">${pendingJoins.length} awaiting approval</span></div>
      <div class="v133-access-grid"><div><h4>Join requests</h4>${joins.length?joins.slice(0,12).map(r=>`<article class="v133-access-row"><div><strong>${esc(r.name)}</strong><span>${esc(r.email)} · ${esc(v133StatusText(r.status))}</span><small>Created ${esc(dateTime(r.createdAt))}</small></div><div>${r.status==='pending'?`<button class="tiny primary" onclick="v133OpenJoinRequest('${escAttr(r.id)}')">Review</button>`:`<span class="badge">${esc(v133StatusText(r.status))}</span>`}</div></article>`).join(''):`<div class="apple-empty-mini"><strong>No join requests</strong><span>Employee-created requests will appear here.</span></div>`}</div>
      <div><h4>Invitation history</h4>${invites.length?invites.slice(0,12).map(i=>`<article class="v133-access-row"><div><strong>${esc(i.name)}</strong><span>${esc(i.role)} · ${esc(v133StatusText(i.status))}</span><small>Invited by ${esc(i.invitedByName||'manager')} · ${esc(i.expiresAt?dateTime(i.expiresAt):'')}</small></div><div>${i.status==='pending'?`<button class="tiny" onclick="resendInvite('${escAttr(i.userId)}')">Resend</button><button class="tiny danger-text" onclick="v133RevokeInvitation('${escAttr(i.id)}')">Revoke</button>`:`<span class="badge">${esc(v133StatusText(i.status))}</span>`}</div></article>`).join(''):`<div class="apple-empty-mini"><strong>No invitations yet</strong><span>Use Add team member to create a secure link.</span></div>`}</div></div></section>`;
  }
  const v133OldCredentialsView=credentialsView;
  credentialsView=function(){return v133OldCredentialsView()+v133AccessPanel();};

  window.v133OpenJoinRequest=function(requestId){
    const r=(state.joinRequests||[]).find(x=>x.id===requestId);if(!r)return toast('Join request not found.');
    modal(`<div class="request-review-modal"><span class="eyebrow">Workplace access request</span><h2>${esc(r.name)}</h2><div class="v121-review-grid"><div><span>Email</span><strong>${esc(r.email)}</strong></div><div><span>Requested role</span><strong>Employee</strong></div><div><span>Created</span><strong>${esc(dateTime(r.createdAt))}</strong></div><div><span>Status</span><strong>${esc(v133StatusText(r.status))}</strong></div></div><label>Decision note (optional)</label><textarea id="v133-join-note" placeholder="Optional message"></textarea><div class="actions">${r.status==='pending'?`<button class="success" onclick="v133DecideJoin('${escAttr(r.id)}','approve')">Approve employee</button><button class="danger" onclick="v133DecideJoin('${escAttr(r.id)}','reject')">Reject</button>`:''}<button onclick="closeModal()">Close</button></div></div>`);
  };
  async function v133DirectDecisionEmail(result){
    if(!result?.email||!state.emailConfig?.enabled)return;
    const subject=`MySchedule access ${result.status}`;
    const message=result.status==='approved'?`Hi ${result.name}, your request to join ${result.businessName} was approved. Sign in with your verified email to continue.`:`Hi ${result.name}, your request to join ${result.businessName} was not approved. Contact the workplace owner if you need clarification.`;
    const note=(state.notifications||[]).filter(n=>n.userId===result.userId&&n.entityId===result.requestId).slice(-1)[0] || (state.notifications||[]).filter(n=>n.userId===result.userId&&['join_approved','join_rejected'].includes(n.type)).slice(-1)[0];
    await sendEmail({noteId:note?.id||'',to_email:result.email,to_name:result.name,subject,message,notification_ref:generateNotificationRef(),business_name:result.businessName,html_message:buildHtmlEmail({type:'approval',toName:result.name,subject,message,businessName:result.businessName,loginUrl:getPublicAppUrl()})});
  }
  window.v133DecideJoin=async function(requestId,decision){
    try{
      const result=await v133Call('decideJoinRequest',{requestId,decision,note:val('v133-join-note')||''});
      closeModal();const cloud=await loadFirebaseState();if(cloud)state=migrateState(cloud);renderContent();
      await v133DirectDecisionEmail(result).catch(console.warn);
      toast(`Join request ${result.status}.`);
    }catch(error){toast(error.message||'Join request could not be updated.');}
  };

  const v133OldSaveManaged=v97SaveManagedUser;
  v97SaveManagedUser=function(userId){
    const before=deepCloneForV133(state.users.find(u=>u.id===userId));
    const result=v133OldSaveManaged(userId);
    setTimeout(()=>{
      const after=state.users.find(u=>u.id===userId);if(!before||!after)return;
      const changes=[];if(before.role!==after.role)changes.push(`role changed from ${before.role} to ${after.role}`);if(before.status!==after.status)changes.push(`access status changed to ${after.status}`);
      if(changes.length)notifyUser(after.id,'access_change','Workplace access updated',`Your MySchedule ${changes.join(' and ')}.`,{targetView:after.role==='employee'?'profile':'dashboard'});
    },20);return result;
  };
  function deepCloneForV133(value){try{return JSON.parse(JSON.stringify(value));}catch(e){return null;}}

  const v133OldRender=render;
  render=function(){v133OldRender();setTimeout(()=>{if(!currentUser()&&val('signup-type')==='join-team')v133RefreshInviteSummary();},0);};

  v97TeamAccessStatus=function(u){
    if(u.status==='removed')return{label:'Removed',cls:'muted'};
    if(u.status==='inactive')return{label:'Paused',cls:'warn'};
    if(u.status==='join_pending')return{label:'Join approval pending',cls:'warn'};
    if(u.status==='join_rejected')return{label:'Join rejected',cls:'muted'};
    if(u.status==='invitation_expired')return{label:'Invite expired',cls:'warn'};
    if(u.status==='invitation_revoked')return{label:'Invite revoked',cls:'muted'};
    if(u.status==='invited')return{label:'Invite pending',cls:'warn'};
    if(u.emailVerified)return{label:'Active',cls:'good'};
    return{label:'Verification pending',cls:'warn'};
  };
  const v133OldTeamCard=v97TeamAccessCard;
  v97TeamAccessCard=function(u){
    let html=v133OldTeamCard(u);
    const source=u.accountSource==='self_join_request'||u.approvalSource==='self_join_request'?'Self-created join request':u.invitationSource==='manager_invite'?`Invited by ${u.invitedByName||'manager'}`:u.accountSource==='workspace_creator'?'Workspace creator':'Existing team account';
    const audit=`<div class="v133-access-audit"><span>Access source</span><strong>${esc(source)}</strong>${u.approvedByUserId?`<small>Approved by ${esc(userName(u.approvedByUserId))}</small>`:''}</div>`;
    return html.replace('<div class="v97-access-actions">',`${audit}<div class="v97-access-actions">`);
  };
  const v133OldManagerDashboard=managerDashboard;
  managerDashboard=function(){
    const html=v133OldManagerDashboard();
    const user=currentUser();const count=(state.joinRequests||[]).filter(r=>r.businessId===user?.businessId&&r.status==='pending').length;
    if(!count)return html;
    const banner=`<button class="v133-dashboard-access-alert" onclick="go('credentials')"><strong>${count} access request${count===1?'':'s'} need approval</strong><span>Review employee-created workplace join requests.</span><em>Review</em></button>`;
    return html.replace(/(<div class="qa-metric-strip[^>]*>)/,`${banner}$1`);
  };

  sendPasswordResetForUser=async function(userId){
    const u=state.users.find(x=>x.id===userId);if(!u||!isValidEmail(u.email))return toast('A valid team email is required.');
    try{await requireAuth().sendPasswordResetEmail(normalizeEmail(u.email),{url:window.location.href.split('#')[0]});notifyUser(u.id,'login','Password reset link sent','A secure Firebase password reset link was sent to your email.',{targetView:'profile',inAppOnly:true});toast(`Password reset link sent to ${u.email}.`);}catch(error){toast(firebaseErrorMessage(error)||error.message||'Password reset could not be sent.');}
  };
  forgotPassword=async function(){
    const email=normalizeEmail(val('reset-email')||val('login-email'));if(!isValidEmail(email))return toast('Enter a valid email address.');
    try{await requireAuth().sendPasswordResetEmail(email,{url:window.location.href.split('#')[0]});setAuthMode('login');toast('Password reset link sent. Check your inbox and spam folder.');}catch(error){toast(firebaseErrorMessage(error)||error.message||'Password reset could not be sent.');}
  };
  const v133OldConfirmRemove=v97ConfirmRemoveUser;
  v97ConfirmRemoveUser=function(userId){
    const before=deepCloneForV133(state.users.find(u=>u.id===userId));
    const result=v133OldConfirmRemove(userId);
    setTimeout(()=>{const after=state.users.find(u=>u.id===userId);if(before&&after?.status==='removed')notifyUser(after.id,'access_removed','Workplace access removed',`Your access to ${business()?.name||'this workplace'} was removed. Contact the owner if this was unexpected.`,{targetView:'notifications'});},20);
    return result;
  };

  window.v133Call=v133Call;
  window.resendInvite=resendInvite;
  window.saveUser=saveUser;
})();



/* v136: bounded state cloning prevents circular/deep legacy data from causing
   "Maximum call stack size exceeded" while adding a team member. */
function v136SafeStateClone(input, maxDepth=28){
  const path = new WeakSet();
  function clone(value, depth){
    if(value === null || value === undefined) return value;
    const type = typeof value;
    if(type === 'string' || type === 'number' || type === 'boolean') return value;
    if(type === 'bigint') return Number(value);
    if(type === 'function' || type === 'symbol') return undefined;
    if(value instanceof Date) return value.toISOString();
    if(depth > maxDepth) return undefined;
    if(type === 'object'){
      try{
        if(typeof value.toDate === 'function'){
          const date=value.toDate();
          if(date instanceof Date) return date.toISOString();
        }
      }catch(_e){}
      if(path.has(value)) return undefined;
      path.add(value);
      let output;
      if(Array.isArray(value)){
        output=[];
        for(const item of value){
          const next=clone(item,depth+1);
          if(next !== undefined) output.push(next);
        }
      }else{
        output={};
        for(const key of Object.keys(value)){
          const next=clone(value[key],depth+1);
          if(next !== undefined) output[key]=next;
        }
      }
      path.delete(value);
      return output;
    }
    return undefined;
  }
  return clone(input,0);
}

/* v135: working Firebase compatibility layer.
   Removes the Cloud Functions hard dependency while preserving verified Firebase login,
   existing workplace data, invitations, join approvals and action alerts. */
(function(){
  const V135_VERSION = '1.35.0';
  const V135_PENDING_KEY = 'myschedule_v133_pending_access';
  const V135_INVITE_KEY = 'myschedule_v133_invite_token';
  const V135_CACHE_KEY = APP_KEY;
  let v135LiveStop = null;

  function v135AuthUser(){ return firebaseAuth && firebaseAuth.currentUser ? firebaseAuth.currentUser : null; }
  function v135CacheRead(){
    try{
      const raw=localStorage.getItem(V135_CACHE_KEY);
      if(!raw) return null;
      const parsed=JSON.parse(raw);
      return parsed && Array.isArray(parsed.users) ? migrateState(parsed) : null;
    }catch(_e){ return null; }
  }
  function v135CacheWrite(value){
    try{ localStorage.setItem(V135_CACHE_KEY,JSON.stringify(value)); }catch(_e){}
  }
  function v135Pending(){
    try{return JSON.parse(localStorage.getItem(V135_PENDING_KEY)||'null');}catch(_e){return null;}
  }
  function v135SetPending(value){
    try{ if(value)localStorage.setItem(V135_PENDING_KEY,JSON.stringify(value)); else localStorage.removeItem(V135_PENDING_KEY); }catch(_e){}
  }
  function v135InviteToken(){
    try{return sessionStorage.getItem(V135_INVITE_KEY)||localStorage.getItem(V135_INVITE_KEY)||'';}catch(_e){return '';}
  }
  function v135ClearInvite(){
    try{sessionStorage.removeItem(V135_INVITE_KEY);localStorage.removeItem(V135_INVITE_KEY);}catch(_e){}
  }
  function v135Error(code,message){ const e=new Error(message);e.code=code;return e; }
  function v135RandomToken(){
    const bytes=new Uint8Array(32);
    if(window.crypto&&crypto.getRandomValues) crypto.getRandomValues(bytes); else for(let i=0;i<bytes.length;i++)bytes[i]=Math.floor(Math.random()*256);
    return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
  }
  async function v135Hash(value){
    if(window.crypto&&crypto.subtle&&window.TextEncoder){
      const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(value||'')));
      return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
    }
    let h=2166136261;for(const c of String(value||'')){h^=c.charCodeAt(0);h=Math.imul(h,16777619);}return `fallback-${(h>>>0).toString(16)}`;
  }
  function v135Ref(){
    if(!initFirebase()||!firebaseDb) throw v135Error('unavailable','Firebase cloud connection is unavailable.');
    return firebaseDb.collection('apps').doc(FIREBASE_DOC_PATH);
  }
  async function v135ReadCloud(){
    const auth=v135AuthUser();
    if(!auth) return v135CacheRead();
    let last=null;
    for(let attempt=0;attempt<3;attempt++){
      try{
        if(attempt===1&&auth.getIdToken) await auth.getIdToken(true).catch(()=>{});
        const snap=await v135Ref().get({source:attempt===0?'server':'default'});
        if(snap.exists&&snap.data()&&snap.data().state){
          cloudRevision=Number(snap.data().revision||0);
          lastCloudUpdatedAt=snap.data().updatedAt||null;
          const next=migrateState(snap.data().state);
          v135CacheWrite(next);
          return next;
        }
        return v135CacheRead();
      }catch(error){last=error;await new Promise(r=>setTimeout(r,220*(attempt+1)));}
    }
    console.warn('v135 cloud read fallback',last);
    return v135CacheRead();
  }
  async function v135WriteCloud(snapshot){
    if(!snapshot) return false;
    const clean=migrateState(v136SafeStateClone(snapshot) || defaultState());
    v135CacheWrite(clean);
    const auth=v135AuthUser();
    if(!auth) return true;
    let last=null;
    for(let attempt=0;attempt<4;attempt++){
      try{
        const updatedAt=new Date().toISOString();let revision=cloudRevision+1;
        await firebaseDb.runTransaction(async tx=>{
          const ref=v135Ref();const snap=await tx.get(ref);
          const remote=snap.exists?Number(snap.data().revision||0):0;
          revision=remote+1;
          tx.set(ref,{state:clean,updatedAt,updatedBy:auth.uid,revision,compatibilityVersion:V135_VERSION},{merge:true});
        });
        cloudRevision=revision;lastCloudUpdatedAt=updatedAt;return true;
      }catch(error){last=error;if(attempt===1&&auth.getIdToken)await auth.getIdToken(true).catch(()=>{});await new Promise(r=>setTimeout(r,180*(attempt+1)));}
    }
    console.warn('v135 cloud save fallback',last);
    return false;
  }
  function v135UserIn(data,auth=v135AuthUser()){
    if(!data||!auth)return null;const email=normalizeEmail(auth.email||'');
    return (data.users||[]).find(u=>u.authUid===auth.uid&&u.status!=='removed')||(data.users||[]).find(u=>normalizeEmail(u.email)===email&&u.status!=='removed');
  }
  function v135BusinessFor(data,user){return (data.businesses||[]).find(b=>b.id===user?.businessId)||null;}
  function v135Notification(args){
    return {id:uuid(),refId:generateNotificationRef(),businessId:args.businessId,userId:args.userId,toUserId:args.userId,type:args.type||'access',subject:args.subject||'MySchedule update',originalSubject:args.subject||'MySchedule update',message:args.message||'',originalMessage:args.message||'',read:false,createdAt:now(),targetView:args.targetView||'notifications',entityId:args.entityId||'',requiresAction:args.requiresAction===true,actionStatus:args.requiresAction===true?'pending':'informational',actionKind:args.actionKind||''};
  }
  function v135NotifyManagers(data,businessId,args){
    (data.users||[]).filter(u=>u.businessId===businessId&&['owner','manager'].includes(u.role)&&u.status==='active').forEach(u=>data.notifications.push(v135Notification({...args,businessId,userId:u.id})));
  }
  async function v135CreateWorkspace(data){
    const auth=v135AuthUser();if(!auth)throw v135Error('unauthenticated','Create the Firebase account first.');
    const current=(await v135ReadCloud())||migrateState(defaultState());
    const email=normalizeEmail(auth.email||data.email||'');
    const duplicate=(current.users||[]).find(u=>normalizeEmail(u.email)===email&&u.status!=='removed');
    if(duplicate)throw v135Error('already-exists','This email already belongs to a MySchedule workplace. Use Sign in or Forgot password.');
    const businessName=String(data.businessName||'').trim();const name=String(data.name||auth.displayName||email).trim();
    if(!businessName||!name)throw v135Error('invalid-argument','Business name and your name are required.');
    const businessId=uuid();const userId=uuid();const code=generateBusinessCode(businessName);
    current.businesses.push({id:businessId,businessCode:code,storeCode:generateStoreCode(businessName),name:businessName,industry:data.industry||'Other',country:data.country||'Australia',timezone:data.timezone||detectedDeviceTimezone(),subscription:'Free launch',createdAt:now(),createdByOwnerId:userId});
    current.users.push({id:userId,businessId,name,email,role:'owner',status:'pending_verification',authUid:auth.uid,notifyEmail:true,notifyInApp:true,emailVerified:false,createdAt:now(),accountSource:'workspace_creator'});
    if(!(await v135WriteCloud(current)))throw v135Error('unavailable','The workspace could not be saved to Firebase. Deploy the included Firestore rules once, then retry.');
    return {ok:true,businessId,businessCode:code};
  }
  async function v135RepairAccess(){
    const auth=v135AuthUser();if(!auth)throw v135Error('unauthenticated','Sign in to continue.');
    const data=await v135ReadCloud();if(!data)throw v135Error('not-found','Workplace data was not found.');
    let user=v135UserIn(data,auth);
    if(!user)throw v135Error('permission-denied','No approved workplace profile matches this email. Ask the owner or manager to add this exact email.');
    if(['removed','inactive','join_rejected','invitation_revoked'].includes(user.status))throw v135Error('permission-denied','This workplace access is not active. Contact the owner or manager.');
    if(user.status==='join_pending')throw v135Error('failed-precondition','Your workplace join request is still awaiting approval.');
    user.authUid=auth.uid;user.emailVerified=!!auth.emailVerified;user.status='active';user.linkedAt=user.linkedAt||now();user.lastLoginAt=now();
    delete user.tempPassword;delete user.localPassword;delete user.password;delete user.forcePasswordChange;
    await v135WriteCloud(data);
    return {ok:true,repaired:true,businessId:user.businessId,userId:user.id,role:user.role,version:V135_VERSION};
  }
  async function v135LoadWorkspace(){
    const auth=v135AuthUser();if(!auth)throw v135Error('unauthenticated','Sign in to continue.');
    const data=await v135ReadCloud();if(!data)throw v135Error('not-found','Workplace data was not found.');
    const user=v135UserIn(data,auth);if(!user)throw v135Error('permission-denied','No workplace is linked to this account.');
    if(user.status==='join_pending')throw v135Error('failed-precondition','Your workplace join request is awaiting approval.');
    if(!['active','pending_verification','invited'].includes(user.status))throw v135Error('permission-denied','This workplace access is not active.');
    return {ok:true,businessId:user.businessId,userId:user.id,role:user.role,revision:cloudRevision,state:data};
  }
  async function v135SaveWorkspace(data){
    const auth=v135AuthUser();if(!auth)throw v135Error('unauthenticated','Sign in to continue.');
    const incoming=migrateState(data.state||defaultState());const user=v135UserIn(incoming,auth);
    if(!user||user.status!=='active')throw v135Error('permission-denied','Active workplace access is required.');
    if(!(await v135WriteCloud(incoming)))throw v135Error('unavailable','Changes could not be saved to Firebase.');
    return {ok:true,revision:cloudRevision};
  }
  async function v135GetInvitation(data){
    const token=String(data.token||'');if(token.length<30)throw v135Error('invalid-argument','Invitation link is invalid.');
    const auth=v135AuthUser();
    if(!auth)return {ok:true,status:'pending',name:'Team member',role:'employee',emailMasked:'your invited email',expiresAt:'',invitedByName:'your workplace'};
    const current=await v135ReadCloud();const hash=await v135Hash(token);const row=(current?.accessInvitations||[]).find(i=>i.id===hash||i.tokenHash===hash);
    if(!row)return {ok:true,status:'pending',name:'Team member',role:'employee',emailMasked:'your invited email',expiresAt:'',invitedByName:'your workplace'};
    const expired=row.expiresAt&&new Date(row.expiresAt).getTime()<Date.now();
    return {ok:true,status:expired&&row.status==='pending'?'expired':row.status,name:row.name,role:row.role,emailMasked:String(row.email||'').replace(/^(.{1,2}).*(@.*)$/,'$1•••$2'),expiresAt:row.expiresAt||'',invitedByName:row.invitedByName||'your workplace',invitedByRole:row.invitedByRole||'manager'};
  }
  async function v135CreateInvitation(data){
    const auth=v135AuthUser();const current=await v135ReadCloud();const manager=v135UserIn(current,auth);
    if(!manager||!['owner','manager'].includes(manager.role)||manager.status!=='active')throw v135Error('permission-denied','Owner or manager access is required.');
    const email=normalizeEmail(data.email||'');const name=String(data.name||'').trim();const role=data.role==='manager'?'manager':'employee';
    if(!email||!name)throw v135Error('invalid-argument','Name and email are required.');
    if(role==='manager'&&manager.role!=='owner')throw v135Error('permission-denied','Only the owner can invite a manager.');
    const active=(current.users||[]).find(u=>u.businessId===manager.businessId&&normalizeEmail(u.email)===email&&u.status==='active');
    if(active)throw v135Error('already-exists','This email is already active in the workplace.');
    let profile=(current.users||[]).find(u=>u.businessId===manager.businessId&&normalizeEmail(u.email)===email&&u.status!=='removed');
    if(!profile){profile={id:uuid(),businessId:manager.businessId,name,email,role,status:'invited',notifyEmail:true,notifyInApp:true,emailVerified:false,createdAt:now()};current.users.push(profile);}
    const raw=v135RandomToken();const hash=await v135Hash(raw);const expiresAt=new Date(Date.now()+7*86400000).toISOString();
    (current.accessInvitations||[]).filter(i=>i.userId===profile.id&&i.status==='pending').forEach(i=>{i.status='revoked';i.revokedAt=now();});
    Object.assign(profile,{name,email,role,status:'invited',invitedAt:now(),invitedByUserId:manager.id,invitedByName:manager.name,invitedByRole:manager.role,invitationSource:'manager_invite',inviteExpiresAt:expiresAt,activeInvitationId:hash,updatedAt:now()});
    if(role==='employee'){
      let emp=(current.employees||[]).find(e=>e.userId===profile.id);
      const values={id:profile.id,businessId:manager.businessId,userId:profile.id,hireDate:data.hireDate||isoDate(new Date()),employmentType:data.employmentType||'casual',visaTracking:true,fortnightLimit:Number(data.fortnightLimit)||48,weeklyLimit:Number(data.weeklyLimit)||30,preferredHours:20,roleLabel:data.roleLabel||'Team Member',status:'active'};
      if(emp)Object.assign(emp,values);else current.employees.push(values);
    }
    current.accessInvitations.push({id:hash,tokenHash:hash,businessId:manager.businessId,userId:profile.id,email,name,role,status:'pending',createdAt:now(),expiresAt,invitedByUserId:manager.id,invitedByName:manager.name,invitedByRole:manager.role,source:'manager_invite'});
    const workplaceName=v135BusinessFor(current,manager)?.name||'Workplace';
    const inviteNote=v135Notification({businessId:manager.businessId,userId:profile.id,type:'invite',subject:'MySchedule workplace invitation',message:`${manager.name} invited you to ${workplaceName} as ${role}.`,targetView:role==='employee'?'myshifts':'dashboard',entityId:profile.id,requiresAction:true,actionKind:'accept_invitation'});
    inviteNote.to=email;inviteNote.toName=name;inviteNote.role=role;inviteNote.emailStatus='pending_delivery';
    current.notifications.push(inviteNote);
    v135NotifyManagers(current,manager.businessId,{type:'invite_created',subject:'Team invitation created',message:`${name} was invited as ${role} by ${manager.name}.`,targetView:'credentials',entityId:profile.id});
    if(!(await v135WriteCloud(current)))throw v135Error('unavailable','The invitation could not be saved to Firebase. Check the Firestore rules and retry.');
    return {ok:true,token:raw,userId:profile.id,email,name,role,expiresAt,invitedByName:manager.name,businessName:workplaceName,noteId:inviteNote.id};
  }
  async function v135AcceptInvitation(data){
    const auth=v135AuthUser();if(!auth||!auth.emailVerified)throw v135Error('failed-precondition','Verify your email before accepting the invitation.');
    const current=await v135ReadCloud();const token=String(data.token||'');const hash=await v135Hash(token);const email=normalizeEmail(auth.email||'');
    let invite=(current.accessInvitations||[]).find(i=>(i.id===hash||i.tokenHash===hash)&&i.status==='pending');
    let profile=invite?(current.users||[]).find(u=>u.id===invite.userId):null;
    if(!invite){profile=(current.users||[]).find(u=>normalizeEmail(u.email)===email&&u.status==='invited');}
    if(!profile)throw v135Error('not-found','No pending invitation matches this verified email.');
    if(normalizeEmail(profile.email)!==email)throw v135Error('permission-denied','Sign in with the same email address that received the invitation.');
    if(invite?.expiresAt&&new Date(invite.expiresAt).getTime()<Date.now()){invite.status='expired';profile.status='invitation_expired';await v135WriteCloud(current);throw v135Error('deadline-exceeded','This invitation has expired. Ask the owner or manager to resend it.');}
    Object.assign(profile,{authUid:auth.uid,emailVerified:true,status:'active',acceptedAt:now(),linkedAt:now(),accountSource:'manager_invite',activeInvitationId:''});
    if(invite){invite.status='accepted';invite.acceptedAt=now();}
    (current.notifications||[]).forEach(note=>{
      if(note.userId===profile.id&&note.actionKind==='accept_invitation'&&note.requiresAction===true){
        note.requiresAction=false;note.actionStatus='resolved';note.resolvedAt=now();note.read=true;
      }
    });
    current.notifications.push(v135Notification({businessId:profile.businessId,userId:profile.id,type:'verification',subject:'Account verified and linked',message:`Your verified account is now linked to ${v135BusinessFor(current,profile)?.name||'your workplace'}.`,targetView:profile.role==='employee'?'myshifts':'dashboard'}));
    v135NotifyManagers(current,profile.businessId,{type:'invite_accepted',subject:'Invitation accepted',message:`${profile.name} accepted the workplace invitation.`,targetView:'credentials',entityId:profile.id});
    await v135WriteCloud(current);return {ok:true,businessId:profile.businessId,userId:profile.id,role:profile.role};
  }
  async function v135SubmitJoin(data){
    const auth=v135AuthUser();if(!auth||!auth.emailVerified)throw v135Error('failed-precondition','Verify your email before sending a join request.');
    const current=await v135ReadCloud();if(!current)throw v135Error('not-found','Workplace data was not found.');
    const code=String(data.businessCode||'').trim().toUpperCase();const business=(current.businesses||[]).find(b=>String(b.businessCode||b.storeCode||'').toUpperCase()===code);
    if(!business)throw v135Error('not-found','No active workplace was found for that code.');
    const email=normalizeEmail(auth.email||'');let profile=(current.users||[]).find(u=>u.businessId===business.id&&normalizeEmail(u.email)===email&&u.status!=='removed');
    if(profile&&['active','invited','pending_verification'].includes(profile.status)){
      Object.assign(profile,{authUid:auth.uid,emailVerified:true,status:'active',linkedAt:now()});await v135WriteCloud(current);return {ok:true,businessName:business.name,status:'approved',alreadyApproved:true};
    }
    let request=(current.joinRequests||[]).find(r=>r.businessId===business.id&&normalizeEmail(r.email)===email&&r.status==='pending');
    if(!profile){profile={id:uuid(),businessId:business.id,name:String(data.name||auth.displayName||email),email,role:'employee',status:'join_pending',authUid:auth.uid,emailVerified:true,notifyEmail:true,notifyInApp:true,createdAt:now(),accountSource:'self_join_request'};current.users.push(profile);}
    else Object.assign(profile,{name:String(data.name||profile.name),authUid:auth.uid,emailVerified:true,status:'join_pending',accountSource:'self_join_request'});
    if(!request){request={id:uuid(),businessId:business.id,userId:profile.id,name:profile.name,email,role:'employee',status:'pending',createdAt:now(),source:'self_join_request'};current.joinRequests.push(request);v135NotifyManagers(current,business.id,{type:'join_request',subject:'Workplace access request',message:`${profile.name} requested to join ${business.name}.`,targetView:'credentials',entityId:request.id,requiresAction:true,actionKind:'decide_join_request'});}
    await v135WriteCloud(current);return {ok:true,businessName:business.name,requestId:request.id,status:'pending'};
  }
  async function v135DecideJoin(data){
    const auth=v135AuthUser();const current=await v135ReadCloud();const manager=v135UserIn(current,auth);
    if(!manager||!['owner','manager'].includes(manager.role)||manager.status!=='active')throw v135Error('permission-denied','Owner or manager access is required.');
    const request=(current.joinRequests||[]).find(r=>r.id===data.requestId&&r.businessId===manager.businessId);if(!request)throw v135Error('not-found','Join request was not found.');
    if(request.status!=='pending')throw v135Error('failed-precondition',`This request is already ${request.status}.`);
    const profile=(current.users||[]).find(u=>u.id===request.userId);if(!profile)throw v135Error('not-found','Pending user profile was not found.');
    const approved=data.decision==='approve';request.status=approved?'approved':'rejected';request.decidedAt=now();request.decidedByUserId=manager.id;request.decisionNote=String(data.note||'').trim();
    profile.status=approved?'active':'join_rejected';profile.approvedByUserId=manager.id;profile.approvedAt=approved?now():'';profile.approvalSource='self_join_request';
    if(approved&&!current.employees.some(e=>e.userId===profile.id))current.employees.push({id:profile.id,businessId:profile.businessId,userId:profile.id,hireDate:isoDate(new Date()),employmentType:'casual',visaTracking:true,fortnightLimit:48,weeklyLimit:30,preferredHours:20,roleLabel:'Team Member',status:'active'});
    current.notifications.forEach(n=>{if(n.entityId===request.id&&n.actionKind==='decide_join_request'){n.requiresAction=false;n.actionStatus='resolved';n.resolvedAt=now();}});
    current.notifications.push(v135Notification({businessId:profile.businessId,userId:profile.id,type:approved?'join_approved':'join_rejected',subject:approved?'Workplace access approved':'Workplace access request declined',message:approved?`Your request to join ${v135BusinessFor(current,profile)?.name||'the workplace'} was approved. Sign in to continue.`:`Your workplace access request was declined.${request.decisionNote?' '+request.decisionNote:''}`,targetView:approved?'myshifts':'notifications',entityId:request.id}));
    await v135WriteCloud(current);return {ok:true,status:request.status,requestId:request.id,userId:profile.id,email:profile.email,name:profile.name,businessName:v135BusinessFor(current,profile)?.name||'Workplace'};
  }
  async function v135Revoke(data){
    const auth=v135AuthUser();const current=await v135ReadCloud();const manager=v135UserIn(current,auth);
    if(!manager||!['owner','manager'].includes(manager.role))throw v135Error('permission-denied','Owner or manager access is required.');
    const invite=(current.accessInvitations||[]).find(i=>i.id===data.invitationId&&i.businessId===manager.businessId);if(!invite)throw v135Error('not-found','Invitation was not found.');
    if(invite.status!=='pending')throw v135Error('failed-precondition','Only a pending invitation can be revoked.');
    invite.status='revoked';invite.revokedAt=now();const profile=(current.users||[]).find(u=>u.id===invite.userId);if(profile&&profile.status==='invited'){profile.status='invitation_revoked';profile.activeInvitationId='';}
    await v135WriteCloud(current);return {ok:true,email:invite.email,name:invite.name,businessName:v135BusinessFor(current,manager)?.name||'Workplace'};
  }
  async function v135RecordLogin(){
    const auth=v135AuthUser();const current=await v135ReadCloud();const user=v135UserIn(current,auth);if(!user)return {ok:false};user.lastLoginAt=now();user.emailVerified=!!auth.emailVerified;await v135WriteCloud(current);return {ok:true};
  }

  window.__v135CompatCall=async function(name,data={}){
    switch(name){
      case 'healthCheck':return {ok:true,version:V135_VERSION,mode:'firebase-firestore',authenticated:!!v135AuthUser(),emailVerified:!!v135AuthUser()?.emailVerified};
      case 'createWorkspace':return v135CreateWorkspace(data);
      case 'repairMyAccess':return v135RepairAccess();
      case 'loadWorkspaceState':return v135LoadWorkspace();
      case 'saveWorkspaceState':return v135SaveWorkspace(data);
      case 'getInvitation':return v135GetInvitation(data);
      case 'createInvitation':return v135CreateInvitation(data);
      case 'acceptInvitation':return v135AcceptInvitation(data);
      case 'submitJoinRequest':return v135SubmitJoin(data);
      case 'decideJoinRequest':return v135DecideJoin(data);
      case 'revokeInvitation':return v135Revoke(data);
      case 'recordVerifiedLogin':return v135RecordLogin();
      case 'getAccessStatus':{
        const current=await v135ReadCloud();const user=v135UserIn(current,v135AuthUser());
        return user?{ok:true,status:user.status,businessId:user.businessId,message:user.status==='join_pending'?'Your workplace join request is awaiting approval.':'Workplace access is active.'}:{ok:true,status:'none',message:'No approved workplace is linked to this email.'};
      }
      default:throw v135Error('unimplemented',`MySchedule action ${name} is not available.`);
    }
  };

  loadFirebaseState=async function(){
    const auth=v135AuthUser();if(!auth||!auth.emailVerified)return null;
    const payload=await window.__v135CompatCall('loadWorkspaceState');
    cloudRevision=Number(payload.revision||0);return payload.state?migrateState(payload.state):null;
  };
  saveFirebaseState=async function(snapshotOverride){
    if(!state||!v135AuthUser())return false;
    try{const result=await window.__v135CompatCall('saveWorkspaceState',{state:snapshotOverride||state});return !!result.ok;}catch(error){console.warn('v135 save',error);return false;}
  };
  startFirebaseLiveUpdates=function(){
    if(!initFirebase()||!firebaseDb||v135LiveStop)return;
    const auth=v135AuthUser();if(!auth)return;
    v135LiveStop=v135Ref().onSnapshot(snap=>{
      if(!snap.exists||!snap.data()?.state)return;
      const revision=Number(snap.data().revision||0);if(revision<=cloudRevision||cloudSaveRunning||pendingCloudSnapshot)return;
      cloudRevision=revision;lastCloudUpdatedAt=snap.data().updatedAt||lastCloudUpdatedAt;isApplyingCloudState=true;state=migrateState(snap.data().state);v135CacheWrite(state);if(currentUser())render();isApplyingCloudState=false;
    },error=>console.warn('v135 live update paused',error));
    firebaseLiveUnsubscribe=()=>{try{v135LiveStop&&v135LiveStop();}catch(_e){}v135LiveStop=null;};
  };
  cloudStatusBadge=function(){return '<span class="badge good">Firebase cloud connected</span>';};

  const v135LoginView=loginView;
  loginView=function(){
    return v135LoginView()
      .replace(/Workplace invitation found/g,'Workplace invitation found')
      .replace(/Use a secure invitation link, or enter a workplace code to request approval\./g,'Use your invitation link or enter a workplace code to request approval.')
      .replace(/secure one-time link/gi,'invitation link')
      .replace(/Secure email login with Firebase Authentication\./g,'Email login and verification powered by Firebase Authentication.');
  };
  const v135UpdateSignup=updateSignupFields;
  updateSignupFields=function(){
    v135UpdateSignup();
    const type=val('signup-type')||'create-business';const help=el('signup-help');
    if(help&&type==='join-team')help.textContent='Use the exact email added by your manager. A workplace code is only needed when you are requesting access yourself.';
    const code=el('signup-business-code');if(code)code.required=false;
  };
})();


/* v136 final Add Team Member handler: one transaction, one reload, no stacked saves. */
(function(){
  let addingTeamMember=false;
  let v136SaveTimer=null;

  saveState=function(){
    if(!state||isApplyingCloudState) return Promise.resolve(false);
    const snapshot=v136SafeStateClone(state);
    clearTimeout(v136SaveTimer);
    return new Promise(resolve=>{
      v136SaveTimer=setTimeout(async()=>{
        try{ resolve(await saveFirebaseState(snapshot)); }
        catch(error){ console.warn('v136 safe save failed',error); resolve(false); }
      },140);
    });
  };

  function v136InvitationLink(token){
    const url=new URL(window.location.href.split('#')[0]);
    url.searchParams.set('invite',token);
    return url.toString();
  }
  function v136InvitePayload(){
    return {
      name:String(val('u-name')||'').trim(),
      email:normalizeEmail(val('u-email')),
      role:val('u-role')||'employee',
      hireDate:val('u-hire-date')||isoDate(new Date()),
      employmentType:val('u-type')||'casual',
      roleLabel:String(val('u-duty')||'Team Member').trim()||'Team Member',
      weeklyLimit:Math.max(0,Number(val('u-weekly'))||30),
      fortnightLimit:Math.max(0,Number(val('u-fortnight'))||48)
    };
  }
  function v136SetAddButtonBusy(busy){
    const button=document.querySelector('.apple-team-dialog .apple-dialog-actions .primary');
    if(!button)return;
    button.disabled=busy;
    button.textContent=busy?'Creating invitation…':'Continue';
  }

  saveUser=async function(){
    if(addingTeamMember)return;
    const b=business();
    if(!b||!requireManagerForBusiness(b.id))return;
    const payload=v136InvitePayload();
    if(!payload.name)return toast('Enter the team member name.');
    if(!isValidEmail(payload.email))return toast('Enter a valid email address.');
    addingTeamMember=true;v136SetAddButtonBusy(true);
    try{
      // Repair any circular/deep legacy values before creating the invitation.
      state=migrateState(v136SafeStateClone(state)||defaultState());
      const result=await window.__v135CompatCall('createInvitation',payload);
      const refreshed=await loadFirebaseState();
      if(refreshed)state=migrateState(refreshed);
      const link=v136InvitationLink(result.token);
      closeModal();renderContent();
      // Email delivery is deliberately outside the workspace transaction. A mail
      // provider failure must never undo the invitation or lock the manager UI.
      const emailMessage=`Hi ${result.name}, ${result.invitedByName||'your manager'} invited you to ${result.businessName||b.name} as ${result.role}. Open this invitation link before ${dateTime(result.expiresAt)}: ${link}`;
      Promise.resolve(sendEmail({
        noteId:result.noteId||'',
        to_email:result.email,
        to_name:result.name,
        subject:'MySchedule workplace invitation',
        message:emailMessage,
        notification_ref:generateNotificationRef(),
        business_name:result.businessName||b.name,
        html_message:buildHtmlEmail({type:'invite',toName:result.name,subject:'MySchedule workplace invitation',message:emailMessage,businessName:result.businessName||b.name,loginUrl:link})
      })).catch(error=>console.warn('Invitation email delivery failed',error));
      modal(`<div class="apple-status-dialog"><div class="apple-status-icon">✓</div><span class="eyebrow">Invitation created</span><h2>${esc(result.name||result.email)}</h2><p>The invitation is saved. This link expires on <strong>${esc(dateTime(result.expiresAt))}</strong> and is restricted to <strong>${esc(result.email)}</strong>.</p><div class="credential-card"><div class="cred-row"><span>Invited by</span><strong>${esc(result.invitedByName||currentUser()?.name||'Manager')}</strong></div><div class="cred-row"><span>Role</span><strong>${esc(result.role)}</strong></div><div class="cred-row"><span>Invitation link</span><strong class="v133-break-link">${esc(link)}</strong></div></div><div class="actions apple-dialog-actions"><button type="button" onclick="v97CopyField('${escAttr(link)}','Invitation link copied')">Copy link</button><button class="primary" onclick="closeModal()">Done</button></div></div>`);
    }catch(error){
      console.error('v136 add team member failed',error);
      const message=String(error?.message||'').trim();
      if(/maximum call stack|call stack size|too much recursion/i.test(message)){
        state=migrateState(v136SafeStateClone(state)||defaultState());
        toast('The old stacked team data was repaired. Please press Add team member once more.');
      }else{
        toast(message||'The invitation could not be created.');
      }
    }finally{
      addingTeamMember=false;v136SetAddButtonBusy(false);
    }
  };
  window.saveUser=saveUser;
})();

/* v139 — smooth workspace entry, accurate badges/counts, and verified profile sync. */
(function(){
  'use strict';
  const VERSION='1.39.0';
  let loginRunning=false;
  let profileSaving=false;

  function idle(fn){
    if(typeof requestIdleCallback==='function') requestIdleCallback(fn,{timeout:1200});
    else setTimeout(fn,60);
  }
  function nextPaint(){return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));}
  function approvedStatus(user){return !!user&&user.status==='active';}
  function friendlyAuthError(error){
    const code=String(error?.code||'').replace(/^auth\//,'');
    const map={
      'invalid-credential':'The email or password is incorrect.',
      'wrong-password':'The email or password is incorrect.',
      'user-not-found':'The email or password is incorrect.',
      'too-many-requests':'Too many attempts were made. Wait a few minutes or reset your password.',
      'network-request-failed':'The network connection was interrupted. Check your connection and try again.',
      'user-disabled':'This Firebase account has been disabled.',
      'requires-recent-login':'For security, sign out and sign in again before changing the login email.'
    };
    return map[code]||firebaseErrorMessage?.(error)||error?.message||'The request could not be completed.';
  }
  function loginProgress(show,title='Signing you in',message='Securely loading your workspace…'){
    let panel=document.getElementById('v139LoginProgress');
    if(show&&!panel){
      panel=document.createElement('div');
      panel.id='v139LoginProgress';
      panel.className='v139-login-progress';
      panel.setAttribute('role','status');panel.setAttribute('aria-live','polite');
      panel.innerHTML='<div class="v139-login-progress-card"><span class="v139-login-spinner" aria-hidden="true"></span><div><strong></strong><p></p></div></div>';
      document.body.appendChild(panel);
    }
    if(panel){
      panel.querySelector('strong').textContent=title;
      panel.querySelector('p').textContent=message;
      panel.classList.toggle('visible',!!show);
      panel.setAttribute('aria-hidden',show?'false':'true');
      if(!show)setTimeout(()=>panel?.remove(),240);
    }
    const button=document.querySelector('#login-box .auth-continue');
    if(button){
      if(show&&!button.dataset.originalText)button.dataset.originalText=button.textContent;
      button.disabled=!!show;button.textContent=show?'Signing in…':(button.dataset.originalText||'Sign in');
      if(!show)delete button.dataset.originalText;
    }
    document.body.classList.toggle('v139-auth-busy',!!show);
  }
  function findAuthProfile(authUser){
    const email=normalizeEmail(authUser?.email||'');
    return (state.users||[]).find(u=>u.authUid===authUser?.uid&&u.status!=='removed')||
      (state.users||[]).find(u=>normalizeEmail(u.email)===email&&u.status!=='removed');
  }
  function finalizeVerifiedEmail(user,authUser){
    if(!user||!authUser)return false;
    const authEmail=normalizeEmail(authUser.email||'');
    const pending=normalizeEmail(user.pendingEmail||'');
    if(pending&&authEmail===pending&&authUser.emailVerified){
      const previous=user.email;
      user.email=authEmail;user.pendingEmail='';user.pendingEmailRequestedAt='';
      user.emailVerified=true;user.emailVerifiedAt=now();user.updatedAt=now();
      v139AddAdminNotifications(user,`Verified login email changed from ${previous} to ${authEmail}.`,'profile_email_verified');
      return true;
    }
    return false;
  }
  function v139Enter(user,message='Signed in successfully.'){
    setCurrentSession(user.id);
    try{localStorage.setItem('myschedule_v103_active_user',user.id);}catch(_e){}
    currentView=requestedEmailViewForUser?.(user)||v99RoleHome(user);
    try{history.replaceState(null,'',`${location.pathname}${location.search}#${currentView}`);}catch(_e){}
    document.body.classList.add('v139-entering-workspace');
    render();
    updateTopbarAuthVisibility(user);
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      document.body.classList.remove('v139-entering-workspace');
      window.scrollTo({top:0,behavior:'auto'});
      loginProgress(false);
    }));
    if(message)toast(message);
    return true;
  }

  login=async function(){
    if(loginRunning)return;
    const email=normalizeEmail(readCredentialFromInput('login-email','email'));
    const password=cleanPassword(readCredentialFromInput('login-password','password'));
    if(!isValidEmail(email)||!password)return toast('Enter a valid email address and password.');
    if(email.length>254||password.length>128)return toast('The email or password is too long. Check what was pasted and try again.');
    loginRunning=true;loginProgress(true);
    try{
      const auth=requireAuth();
      await auth.setPersistence(firebase.auth.Auth.Persistence.SESSION).catch(()=>{});
      if(auth.currentUser&&normalizeEmail(auth.currentUser.email)!==email)await auth.signOut().catch(()=>{});
      clearCurrentSession();
      const credential=await auth.signInWithEmailAndPassword(email,password);
      if(!credential.user.emailVerified){
        const pending=typeof v133PendingAccess==='function'?v133PendingAccess():null;
        const token=(pending?.type==='invite'&&pending.token)||(typeof v133InviteToken==='function'?v133InviteToken():'');
        const verifyUrl=token&&typeof v133SecureLink==='function'?v133SecureLink(token):window.location.href.split('#')[0];
        await credential.user.sendEmailVerification({url:verifyUrl}).catch(()=>{});
        await auth.signOut().catch(()=>{});clearCurrentSession();
        throw Object.assign(new Error('Verify your email before signing in. A new verification link was requested.'),{code:'verification-required'});
      }
      loginProgress(true,'Loading your workspace','Getting the latest roster and notifications…');
      const cloudState=await loadFirebaseState();
      if(cloudState){state=migrateState(cloudState);try{localStorage.setItem(APP_KEY,JSON.stringify(state));}catch(_e){}}
      const user=findAuthProfile(credential.user);
      if(!user){await auth.signOut().catch(()=>{});clearCurrentSession();throw new Error('This verified login is not linked to a workplace. Ask the owner to invite this exact email.');}
      if(user.status==='join_pending')throw new Error('Your workplace access request is still waiting for owner or manager approval.');
      if(user.status==='invited'||user.status==='invitation_revoked'||user.status==='invitation_expired')throw new Error('Open your latest invitation email and finish account setup before signing in.');
      if(['removed','inactive','join_rejected'].includes(user.status))throw new Error('This workplace access is not active. Contact the owner or manager.');
      // A verified workspace creator may be activated here; invited/joining users may not.
      if(user.status==='pending_verification'&&['workspace_creator','owner_signup'].includes(user.accountSource||'workspace_creator'))user.status='active';
      if(!approvedStatus(user))throw new Error('This account has not been approved for workplace access.');
      user.authUid=credential.user.uid;user.emailVerified=true;user.lastLoginAt=now();
      delete user.tempPassword;delete user.localPassword;delete user.password;delete user.forcePasswordChange;
      const finalizedEmail=finalizeVerifiedEmail(user,credential.user);
      await nextPaint();
      v139Enter(user,finalizedEmail?'Email verified and profile updated.':'Signed in successfully.');
      idle(async()=>{
        try{
          startFirebaseLiveUpdates();
          await saveFirebaseState(v136SafeStateClone(state)||state);
        }catch(error){console.warn('v139 background login sync',error);}
      });
    }catch(error){
      console.warn('v139 login',error);
      loginProgress(false);
      toast(error?.code==='verification-required'?error.message:friendlyAuthError(error));
    }finally{loginRunning=false;}
  };
  window.login=login;
  v99EnterWorkspace=v139Enter;window.v99EnterWorkspace=v139Enter;

  const oldTopbarUpdate=updateTopbarAuthVisibility;
  updateTopbarAuthVisibility=function(user){
    oldTopbarUpdate(user);
    const button=el('topInboxBtn');const badge=el('topInboxCount');
    if(!button||!badge)return;
    const unread=user?(state.notifications||[]).filter(n=>n.userId===user.id&&!n.read).length:0;
    badge.textContent=unread>99?'99+':String(unread);
    badge.classList.toggle('hidden',unread===0);
    button.classList.toggle('has-unread',unread>0);
    button.setAttribute('aria-label',unread?`Open inbox, ${unread} unread notification${unread===1?'':'s'}`:'Open inbox, no unread notifications');
    button.title=unread?`Inbox — ${unread} unread`:'Inbox';
  };
  window.updateTopbarAuthVisibility=updateTopbarAuthVisibility;

  const oldManagerDashboard=managerDashboard;
  managerDashboard=function(){
    const html=oldManagerDashboard();const b=business();
    const approved=(state.users||[]).filter(u=>u.businessId===b?.id&&u.role==='employee'&&u.status==='active').length;
    return html.replace(/(<span>Team<\/span><strong>)[^<]*(<\/strong><em>)active employee/,`$1${approved}$2active employee`);
  };
  window.managerDashboard=managerDashboard;
  rosterEmployeeUsers=function(){
    try{return (state.users||[]).filter(u=>u.businessId===business().id&&u.role==='employee'&&u.status==='active');}
    catch(_e){return [];}
  };
  window.rosterEmployeeUsers=rosterEmployeeUsers;

  const oldCredentialsView=credentialsView;
  credentialsView=function(){
    const user=currentUser();const businessId=user?.businessId;
    const approved=(state.users||[]).filter(u=>u.businessId===businessId&&u.role!=='owner'&&u.status==='active').length;
    const pendingInvites=(state.accessInvitations||[]).filter(i=>i.businessId===businessId&&i.status==='pending').length;
    const pendingJoins=(state.joinRequests||[]).filter(r=>r.businessId===businessId&&r.status==='pending').length;
    const summary=`<div class="v139-team-summary" aria-label="Team access summary"><div><span>Approved team</span><strong>${approved}</strong></div><div><span>Pending invitations</span><strong>${pendingInvites}</strong></div><div><span>Join approvals</span><strong>${pendingJoins}</strong></div></div>`;
    return summary+oldCredentialsView();
  };
  window.credentialsView=credentialsView;

  function v139Notification(args){
    return {id:uuid(),refId:generateNotificationRef(),businessId:args.businessId,userId:args.userId,toUserId:args.userId,type:args.type||'profile',subject:args.subject||'Profile updated',originalSubject:args.subject||'Profile updated',message:args.message||'',originalMessage:args.message||'',read:false,createdAt:now(),targetView:args.targetView||'credentials',entityId:args.entityId||'',requiresAction:false,actionStatus:'informational',actionKind:''};
  }
  function v139AddAdminNotifications(updatedUser,details,type='profile'){
    const admins=(state.users||[]).filter(u=>u.businessId===updatedUser.businessId&&['owner','manager'].includes(u.role)&&u.status==='active'&&u.id!==updatedUser.id);
    for(const admin of admins){
      state.notifications.push(v139Notification({businessId:updatedUser.businessId,userId:admin.id,type,subject:'Team profile updated',message:`${updatedUser.name||updatedUser.email} updated their profile. ${details}`,targetView:'credentials',entityId:updatedUser.id}));
    }
    state.notifications.push(v139Notification({businessId:updatedUser.businessId,userId:updatedUser.id,type,subject:'Profile saved to Firebase',message:`Your profile changes were securely saved. ${details}`,targetView:'profile',entityId:updatedUser.id}));
  }
  window.v139AddAdminNotifications=v139AddAdminNotifications;

  function validPhone(value){
    if(!value)return true;
    if(value.length>30)return false;
    const digits=value.replace(/\D/g,'');
    return digits.length>=7&&digits.length<=18&&/^[+()\-\.\s\d]+$/.test(value);
  }
  function cleanProfileName(value){
    return cleanText(value).replace(/[\u0000-\u001F\u007F]/g,'').replace(/\s+/g,' ').trim().slice(0,80);
  }
  function validProfileName(value){
    try{return /^[\p{L}\p{M}][\p{L}\p{M}\s.'’\-]{1,79}$/u.test(value);}
    catch(_e){return /^[A-Za-z][A-Za-z\s.'\-]{1,79}$/.test(value);}
  }
  function cleanProfilePhone(value){return String(value||'').replace(/[\u0000-\u001F\u007F]/g,'').trim().replace(/\s+/g,' ').slice(0,30);}
  function validProfilePhoto(value){return !value||/^data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=\s]+$/i.test(value);}

  window.v139ResendPendingProfileEmail=async function(){
    const user=currentUser();const authUser=requireAuth()?.currentUser;
    if(!user?.pendingEmail)return toast('There is no pending email change.');
    if(!authUser||authUser.uid!==user.authUid)return toast('Sign in again before resending verification.');
    if(typeof authUser.verifyBeforeUpdateEmail!=='function')return toast('This browser cannot securely verify an email change. Update it and retry.');
    try{
      await authUser.verifyBeforeUpdateEmail(user.pendingEmail,{url:window.location.href.split('#')[0]});
      user.pendingEmailRequestedAt=now();delete user.pendingEmailDeliveryError;
      await saveFirebaseState(v136SafeStateClone(state)||state);
      render();toast(`Verification email resent to ${user.pendingEmail}.`);
    }catch(error){toast(friendlyAuthError(error));}
  };

  saveProfile=async function(){
    if(profileSaving)return;
    const user=currentUser();if(!user)return toast('Please sign in again.');
    const auth=requireAuth();const authUser=auth.currentUser;
    if(!authUser||authUser.uid!==user.authUid)return toast('For security, sign out and sign in again before changing profile details.');
    const newName=cleanProfileName(val('profile-name'));
    const newPhone=cleanProfilePhone(val('profile-phone'));
    const requestedEmail=normalizeEmail(val('profile-email'));
    const photoData=el('profile-photo-data')?.value||user.photoData||'';
    if(!validProfileName(newName))return toast('Enter a valid full name using letters, spaces, apostrophes or hyphens.');
    if(!validPhone(newPhone))return toast('Enter a valid phone number using 7–18 digits.');
    if(!isValidEmail(requestedEmail)||requestedEmail.length>254)return toast('Enter a valid email address.');
    if(photoData&&photoData.length>950000)return toast('Choose a smaller profile photo under 700 KB.');
    if(!validProfilePhoto(photoData))return toast('The selected profile image is invalid. Choose a PNG, JPG, WEBP or GIF image.');
    const original=v136SafeStateClone(state);const old={name:user.name||'',phone:user.phone||'',email:normalizeEmail(user.email),photo:user.photoData||''};
    const changes=[];
    if(newName!==old.name)changes.push(`Name changed from ${old.name||'blank'} to ${newName}`);
    if(newPhone!==old.phone)changes.push(`Phone changed from ${old.phone||'blank'} to ${newPhone||'blank'}`);
    if(photoData!==old.photo)changes.push(photoData?'Profile photo updated':'Profile photo removed');
    const emailChange=requestedEmail!==old.email;
    if(emailChange)changes.push(`Login email change requested from ${old.email} to ${requestedEmail}; verification required`);
    if(!changes.length)return toast('No profile changes to save.');
    if(emailChange){
      const duplicate=(state.users||[]).find(u=>u.id!==user.id&&normalizeEmail(u.email)===requestedEmail&&u.status!=='removed');
      if(duplicate)return toast('That email is already used by another MySchedule profile.');
      if(typeof authUser.verifyBeforeUpdateEmail!=='function')return toast('This browser cannot securely verify an email change. Update it and retry.');
    }
    profileSaving=true;
    const buttons=[...document.querySelectorAll('.profile-card button,.profile-grid button')];buttons.forEach(b=>b.disabled=true);
    let cloudSaved=false;
    try{
      // Firebase Authentication holds the verified display name. The photo remains in
      // Firestore because large data URLs are not valid Firebase Auth photo URLs.
      await authUser.updateProfile({displayName:newName});
      if(emailChange){user.pendingEmail=requestedEmail;user.pendingEmailRequestedAt=now();delete user.pendingEmailDeliveryError;}
      user.name=newName;user.phone=newPhone;user.photoData=photoData;user.updatedAt=now();
      user.profileRevision=`${Date.now()}-${uuid()}`;user.profileVerifiedByAuthUid=authUser.uid;
      v139AddAdminNotifications(user,changes.join('; '),emailChange?'profile_email_pending':'profile');
      const saved=await saveFirebaseState(v136SafeStateClone(state)||state);
      if(!saved)throw new Error('Firebase did not confirm the profile update. Your previous profile has been restored.');
      cloudSaved=true;
      const remote=await loadFirebaseState();
      const confirmed=(remote?.users||[]).find(u=>u.id===user.id);
      if(!confirmed||confirmed.profileRevision!==user.profileRevision)throw new Error('The cloud verification check did not confirm the update. Please retry.');
      state=migrateState(remote);try{localStorage.setItem(APP_KEY,JSON.stringify(state));}catch(_e){}
      let verificationError=null;
      if(emailChange){
        try{await authUser.verifyBeforeUpdateEmail(requestedEmail,{url:window.location.href.split('#')[0]});}
        catch(error){verificationError=error;const fresh=(state.users||[]).find(u=>u.id===user.id);if(fresh){fresh.pendingEmailDeliveryError=String(error?.code||error?.message||'delivery_failed');fresh.pendingEmailRequestedAt=now();await saveFirebaseState(v136SafeStateClone(state)||state).catch(()=>false);}}
      }
      render();updateTopbarAuthVisibility(currentUser());
      if(verificationError)toast('Profile saved, but the email-change message could not be delivered. Use Resend verification in Profile.');
      else toast(emailChange?'Profile saved. Open the verification email to activate the new login address.':'Profile verified and saved to Firebase.');
    }catch(error){
      if(!cloudSaved){
        state=migrateState(original||state);
        await authUser.updateProfile({displayName:old.name}).catch(()=>{});
      }
      render();console.warn('v139 profile save',error);toast(friendlyAuthError(error));
    }finally{profileSaving=false;buttons.forEach(b=>b.disabled=false);}
  };
  window.saveProfile=saveProfile;

  const oldProfileView=profileView;
  profileView=function(){
    const user=currentUser();let html=oldProfileView();
    if(user?.pendingEmail){
      const notice=`<div class="notice v139-profile-verification"><strong>Email verification pending</strong><span>Open the verification message sent to ${esc(user.pendingEmail)}. Your current login email remains ${esc(user.email)} until verification succeeds.</span><button type="button" class="tiny" onclick="v139ResendPendingProfileEmail()">Resend verification</button></div>`;
      html=html.replace(/(<div class="profile-grid">)/,`${notice}$1`);
    }
    return html;
  };
  window.profileView=profileView;

  window.__MYSCHEDULE_V139__={version:VERSION,approvedTeamCount(){const u=currentUser();return(state.users||[]).filter(x=>x.businessId===u?.businessId&&x.role!=='owner'&&x.status==='active').length;},unreadCount(){const u=currentUser();return(state.notifications||[]).filter(n=>n.userId===u?.id&&!n.read).length;},validPhone};
})();
