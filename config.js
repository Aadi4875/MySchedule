// Optional public browser configuration. Never put server secrets here.
// window.MYSCHEDULE_FIREBASE_CONFIG = {apiKey: "", authDomain: "", projectId: "", appId: ""};
// window.MYSCHEDULE_EMAIL_WORKER_URL = "https://your-worker.workers.dev";
// window.MYSCHEDULE_GOOGLE_MAPS_API_KEY = "";

// Requires the backend and rules in this branch to be deployed before release.
window.MYSCHEDULE_REQUIRE_SECURE_BACKEND = true;

window.MYSCHEDULE_SECURE_READY = new Promise(resolve => { window.__MYSCHEDULE_RESOLVE_SECURE = resolve; });
