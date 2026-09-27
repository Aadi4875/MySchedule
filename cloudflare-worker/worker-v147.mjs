/**
 * MySchedule Email Gateway v147
 * Cloudflare Worker for GitHub Pages + Firebase Authentication + Brevo.
 * Required secret: BREVO_API_KEY
 * Required variable: FROM_EMAIL (a verified Brevo sender)
 * Required secret: MYSCHEDULE_SERVICE_KEY (shared only with Firebase Functions)
 * Optional variables: FROM_NAME, ALLOWED_ORIGINS, FIREBASE_PROJECT_ID
 * Optional KV binding: EMAIL_REQUESTS (idempotency + short duplicate protection)
 */
const DEFAULT_PROJECT_ID = 'myschedule-8f213';
const DEFAULT_ALLOWED_ORIGINS = ['https://aadi4875.github.io'];
const FIRESTORE_DOCUMENT = 'apps/myschedule_public_launch';
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

function json(data, status = 200, origin = '') {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'vary': 'Origin'
  };
  if (origin) {
    headers['access-control-allow-origin'] = origin;
    headers['access-control-allow-methods'] = 'POST, OPTIONS';
    headers['access-control-allow-headers'] = 'Authorization, Content-Type, X-MySchedule-Version, X-Request-ID, X-MySchedule-Service-Key';
    headers['access-control-max-age'] = '86400';
  }
  return new Response(JSON.stringify(data), {status, headers});
}
function clean(value, max = 180) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}
function normaliseEmail(value) { return String(value || '').trim().toLowerCase(); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normaliseEmail(value)); }
function configuredSenderEmail(env) {
  let raw = String(env.FROM_EMAIL || env.BREVO_FROM_EMAIL || env.SENDER_EMAIL || '').trim();
  if (!raw) return '';
  raw = raw.replace(/^['"`]|['"`]$/g, '').trim();
  const assignment = raw.match(/^(?:FROM_EMAIL|BREVO_FROM_EMAIL|SENDER_EMAIL)\s*=\s*(.+)$/i);
  if (assignment) raw = assignment[1].trim().replace(/^['"`]|['"`]$/g, '').trim();
  const angle = raw.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  if (angle) raw = angle[1];
  const embedded = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return normaliseEmail(embedded ? embedded[0] : raw);
}
function maskedEmail(value) {
  const email = configuredSenderEmail({FROM_EMAIL:value});
  if (!validEmail(email)) return '';
  const [local, domain] = email.split('@');
  return `${local.slice(0,2)}***@${domain}`;
}
function allowedOrigins(env) {
  const configured = String(env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
  return new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured]);
}
function corsOrigin(request, env) {
  const origin = request.headers.get('origin') || '';
  return allowedOrigins(env).has(origin) ? origin : '';
}

function safeEqual(left, right) {
  const a = String(left || ''), b = String(right || '');
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function serviceAuthorized(request, env) {
  return safeEqual(request.headers.get('x-myschedule-service-key') || '', env.MYSCHEDULE_SERVICE_KEY || '');
}

function base64UrlBytes(input) {
  const value = input.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(input.length / 4) * 4, '=');
  const binary = atob(value); const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function decodeJwtPart(input) { return JSON.parse(new TextDecoder().decode(base64UrlBytes(input))); }
async function verifyFirebaseToken(token, projectId, fetchImpl = fetch) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Invalid Firebase token.');
  const header = decodeJwtPart(parts[0]); const payload = decodeJwtPart(parts[1]);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('Unsupported Firebase token.');
  const jwksResponse = await fetchImpl(JWKS_URL, {headers:{accept:'application/json'}, cf:{cacheTtl:3600, cacheEverything:true}});
  if (!jwksResponse.ok) throw new Error('Firebase signing keys are unavailable.');
  const jwks = await jwksResponse.json(); const jwk = (jwks.keys || []).find(key => key.kid === header.kid);
  if (!jwk) throw new Error('Firebase signing key was not found.');
  const key = await crypto.subtle.importKey('jwk', jwk, {name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, false, ['verify']);
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error('Firebase token signature is invalid.');
  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId || payload.iss !== `https://securetoken.google.com/${projectId}`) throw new Error('Firebase token belongs to another project.');
  if (!payload.sub || String(payload.sub).length > 128) throw new Error('Firebase token user is invalid.');
  if (Number(payload.exp || 0) <= now || Number(payload.iat || 0) > now + 60) throw new Error('Firebase token has expired.');
  if (payload.email_verified !== true || !validEmail(payload.email)) throw new Error('A verified Firebase email is required.');
  return payload;
}
function decodeFirestoreValue(value) {
  if (!value || typeof value !== 'object') return null;
  if ('nullValue' in value) return null;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return Number(value.doubleValue);
  if ('timestampValue' in value) return value.timestampValue;
  if ('stringValue' in value) return value.stringValue;
  if ('referenceValue' in value) return value.referenceValue;
  if ('geoPointValue' in value) return value.geoPointValue;
  if ('bytesValue' in value) return value.bytesValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decodeFirestoreValue);
  if ('mapValue' in value) return decodeFirestoreFields(value.mapValue.fields || {});
  return null;
}
function decodeFirestoreFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields || {})) out[key] = decodeFirestoreValue(value);
  return out;
}
async function loadWorkspace(token, projectId, fetchImpl = fetch) {
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents/${FIRESTORE_DOCUMENT}`;
  const response = await fetchImpl(url, {headers:{authorization:`Bearer ${token}`, accept:'application/json'}});
  if (!response.ok) throw new Error(response.status === 403 ? 'Workspace access was denied.' : `Workspace could not be loaded (${response.status}).`);
  const document = await response.json(); return decodeFirestoreFields(document.fields || {}).state || {};
}
function activeMembership(state, auth, businessId) {
  const email = normaliseEmail(auth.email);
  return (state.users || []).find(user => user.businessId === businessId && user.status === 'active' && (user.authUid === auth.sub || normaliseEmail(user.email) === email));
}
function recipientAllowed(state, businessId, email) {
  const target = normaliseEmail(email);
  return (state.users || []).some(user => user.businessId === businessId && user.status !== 'removed' && normaliseEmail(user.email) === target) ||
    (state.accessInvitations || []).some(invite => invite.businessId === businessId && invite.status === 'pending' && normaliseEmail(invite.email) === target);
}
function permissionCheck(state, auth, body) {
  const membership = activeMembership(state, auth, body.businessId);
  if (!membership) throw Object.assign(new Error('Active access to this business is required.'), {status:403});
  const type = clean(body.templateType || '', 80).toLowerCase();
  const privileged = type.includes('report') || type.includes('invite') || type.includes('approval') || type.includes('admin') || type.includes('business');
  if (privileged && !['owner','manager'].includes(membership.role)) throw Object.assign(new Error('Owner or manager access is required for this email.'), {status:403});
  if (!recipientAllowed(state, body.businessId, body.to)) throw Object.assign(new Error('The recipient is not linked to the selected business.'), {status:403});
  if (membership.role === 'employee' && normaliseEmail(body.to) !== normaliseEmail(auth.email)) throw Object.assign(new Error('Employees can send only their own reminder email.'), {status:403});
  return membership;
}
async function idempotentResult(env, requestId) {
  if (!env.EMAIL_REQUESTS || !requestId) return null;
  const value = await env.EMAIL_REQUESTS.get(`mail:${requestId}`, 'json');
  return value && value.success ? value : null;
}
async function rememberResult(env, requestId, result) {
  if (!env.EMAIL_REQUESTS || !requestId) return;
  await env.EMAIL_REQUESTS.put(`mail:${requestId}`, JSON.stringify(result), {expirationTtl:86400});
}
async function sendBrevo(env, body, membership, fetchImpl = fetch) {
  if (!env.BREVO_API_KEY) throw Object.assign(new Error('BREVO_API_KEY is missing from the Cloudflare Worker.'), {status:503});
  const senderEmail = configuredSenderEmail(env);
  if (!senderEmail) throw Object.assign(new Error('Cloudflare FROM_EMAIL is missing. Set the variable name to FROM_EMAIL and its value to the exact Brevo sender email only.'), {status:503});
  if (!validEmail(senderEmail)) throw Object.assign(new Error('Cloudflare FROM_EMAIL is not a valid email address. Remove quotes, labels, angle brackets, or “FROM_EMAIL =” from the saved value.'), {status:503});
  const businessName = clean(body.businessName || body.businessId || 'MySchedule', 120);
  const payload = {
    sender:{name:clean(env.FROM_NAME || 'MySchedule', 70), email:senderEmail},
    to:[{email:normaliseEmail(body.to), name:clean(body.toName || body.to, 120)}],
    subject:clean(body.subject || 'MySchedule notification', 180),
    htmlContent:String(body.html || '').slice(0,50000),
    textContent:String(body.text || '').slice(0,22000),
    headers:{'X-MySchedule-Business':clean(body.businessId,100),'X-MySchedule-Role':clean(membership.role,20),'X-MySchedule-Request':clean(body.requestId,100)}
  };
  if (validEmail(body.replyTo)) payload.replyTo = {email:normaliseEmail(body.replyTo), name:businessName};
  const response = await fetchImpl(BREVO_URL, {method:'POST', headers:{'content-type':'application/json','api-key':env.BREVO_API_KEY,accept:'application/json'}, body:JSON.stringify(payload)});
  let result = {}; const raw = await response.text();
  try { result = raw ? JSON.parse(raw) : {}; } catch (_) { result = {message:raw.slice(0,300)}; }
  if (!response.ok) throw Object.assign(new Error(clean(result.message || result.error || `Brevo returned HTTP ${response.status}.`, 300)), {status:502});
  return {success:true, ok:true, messageId:clean(result.messageId || '',200), provider:'brevo', requestId:clean(body.requestId,100)};
}
async function handleRequest(request, env, fetchImpl = fetch) {
  const origin = corsOrigin(request, env);
  if (request.method === 'GET') {
    const senderEmail = configuredSenderEmail(env);
    return json({
      success:true,
      service:'MySchedule Email Gateway',
      version:'147.3.0',
      configuration:{
        brevoKeyConfigured:Boolean(env.BREVO_API_KEY),
        fromEmailConfigured:Boolean(senderEmail),
        fromEmailValid:validEmail(senderEmail),
        fromEmailMasked:maskedEmail(senderEmail),
        serviceKeyConfigured:Boolean(env.MYSCHEDULE_SERVICE_KEY)
      }
    }, 200, origin);
  }
  if (request.method === 'OPTIONS') {
    if (!origin) return json({success:false,error:'Origin is not allowed.'}, 403, '');
    return json({success:true,version:'147.3.0'}, 200, origin);
  }
  if (request.method !== 'POST') return json({success:false,error:'Use POST.'}, 405, origin);

  const trustedService = serviceAuthorized(request, env);
  if (!trustedService && !origin) return json({success:false,error:'This website origin is not allowed.'}, 403, '');

  let body;
  try { body = await request.json(); } catch (_) { return json({success:false,error:'Invalid JSON request.'}, 400, origin); }
  const authHeader = request.headers.get('authorization') || '';
  const browserAuth = authHeader.startsWith('Bearer ');
  if (!trustedService && !browserAuth) return json({success:false,error:'Firebase authentication is required. Refresh the signed-in MySchedule page and retry.'}, 401, origin);
  if (trustedService && body.action !== 'send-email-service') return json({success:false,error:'Trusted service action is invalid.'}, 400, origin);
  if (!trustedService && body.action !== 'send-email') return json({success:false,error:'Unsupported browser action.'}, 400, origin);

  body.businessId = clean(body.businessId,100);
  body.to = normaliseEmail(body.to);
  body.requestId = clean(body.requestId || request.headers.get('x-request-id'),100);
  if (!body.businessId || !validEmail(body.to) || !body.requestId) return json({success:false,error:'Business, recipient and request ID are required.'}, 400, origin);
  if (String(body.html || '').length > 50000 || String(body.text || '').length > 22000) return json({success:false,error:'Email content is too large.'}, 413, origin);
  const duplicate = await idempotentResult(env, body.requestId); if (duplicate) return json(duplicate, 200, origin);

  try {
    let membership, auth = null;
    if (trustedService) {
      membership = {role:'system', id:'firebase-functions'};
    } else {
      const projectId = clean(env.FIREBASE_PROJECT_ID || DEFAULT_PROJECT_ID,100);
      const token = authHeader.slice(7).trim();
      auth = await verifyFirebaseToken(token, projectId, fetchImpl);
      const state = await loadWorkspace(token, projectId, fetchImpl);
      membership = permissionCheck(state, auth, body);
    }
    const result = await sendBrevo(env, body, membership, fetchImpl);
    await rememberResult(env, body.requestId, result);
    console.log(JSON.stringify({event:'email_sent',requestId:body.requestId,businessId:body.businessId,to:body.to,authMode:trustedService?'firebase_service':'firebase_user',uid:auth?.sub||'',role:membership.role,messageId:result.messageId}));
    return json(result, 200, origin);
  } catch (error) {
    const status = Number(error?.status || 0) || (/token|authentication|verified/i.test(error?.message || '') ? 401 : 500);
    console.error(JSON.stringify({event:'email_failed',requestId:body.requestId,businessId:body.businessId,error:clean(error?.message || error,300)}));
    return json({success:false,error:clean(error?.message || 'Email delivery failed.',300),requestId:body.requestId}, status, origin);
  }
}
export default { fetch(request, env) { return handleRequest(request, env); } };
export {handleRequest, verifyFirebaseToken, decodeFirestoreFields, permissionCheck, sendBrevo, corsOrigin, configuredSenderEmail, serviceAuthorized, safeEqual};
