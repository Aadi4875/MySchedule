'use strict';
const {randomBytes,randomUUID,createHash}=require('node:crypto');
const {isDeepStrictEqual:equal}=require('node:util');
const TABLES=['businesses','users','employees','branches','availability','shifts','requests','timesheets','notifications','notificationHistory','accessInvitations','joinRequests','notices','noticeReads'];
const hash=x=>createHash('sha256').update(String(x)).digest('hex');
const email=x=>String(x||'').trim().toLowerCase();
const text=(x,max=100)=>String(x||'').replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,max);
function fail(code,message){const e=new Error(message);e.code=code;throw e;}
function need(condition,message,code='permission-denied'){if(!condition)fail(code,message);}
function identity(auth,verified=true){need(auth?.uid&&email(auth.email),'Sign in to continue.','unauthenticated');need(!verified||auth.verified,'Verify your email to continue.','failed-precondition');return auth;}
function clone(x){return JSON.parse(JSON.stringify(x));}
function shape(state={}){for(const key of TABLES)if(!Array.isArray(state[key]))state[key]=[];for(const b of state.businesses){b.businessCode=b.businessCode||'BUS-'+hash(b.id).slice(0,10).toUpperCase();b.storeCode=b.storeCode||'STORE-'+hash(b.id).slice(0,10).toUpperCase();}return state;}
function ready(doc){need(doc.securityVersion===150,'Backend initialization is required. Follow FIREBASE_DEPLOYMENT.md.','failed-precondition');shape(doc.state);if(!Array.isArray(doc.bindings))doc.bindings=[];}
function member(doc,auth,businessId,roles=['owner','manager','employee']){
 identity(auth);const candidates=doc.bindings.filter(b=>b.uid===auth.uid&&b.status==='active'&&roles.includes(b.role)&&email(b.email)===email(auth.email));
 const b=businessId?candidates.find(b=>b.businessId===businessId):candidates.length===1?candidates[0]:null;
 need(b,'Select a workplace with active access.');return b;
}
function profile(doc,b){const p=doc.state.users.find(p=>p.id===b.userId&&p.businessId===b.businessId);need(p,'Workplace profile is unavailable.');return p;}
function checkRows(rows,businessId){need(Array.isArray(rows)&&rows.length<=10000,'Invalid workplace rows.','invalid-argument');const ids=new Set();for(const row of rows){need(row&&typeof row==='object'&&!Array.isArray(row)&&typeof row.id==='string'&&row.id.length<=150&&!ids.has(row.id),'Rows need unique IDs.','invalid-argument');ids.add(row.id);need(row.businessId===businessId,'Rows must belong to the selected business.');}return rows;}
function clean(value,depth=0){
 need(depth<35,'Data nesting is too deep.','invalid-argument');
 if(value===null||['string','boolean','number'].includes(typeof value))return value;
 if(Array.isArray(value))return value.map(v=>clean(v,depth+1));
 need(value&&typeof value==='object','Invalid data.','invalid-argument');const out={};
 for(const [k,v]of Object.entries(value)){need(!['__proto__','constructor','prototype','password','localPassword','tempPassword'].includes(k),'Passwords and unsafe fields cannot be stored.','invalid-argument');if(v!==undefined)out[k]=clean(v,depth+1);}return out;
}
function scoped(doc,b){
 const result={};const s=doc.state;const managerial=b.role!=='employee';
 for(const key of TABLES)result[key]=clone(s[key].filter(r=>key==='businesses'?r.id===b.businessId:r.businessId===b.businessId));
 if(!managerial){
  result.users=result.users.filter(u=>u.status==='active'||u.id===b.userId).map(u=>u.id===b.userId?u:{id:u.id,businessId:u.businessId,name:u.name,email:'',role:u.role,status:u.status,branchIds:u.branchIds||[]});
  result.employees=result.employees.filter(e=>e.userId===b.userId||e.id===b.userId);
  for(const key of ['availability','requests','timesheets'])result[key]=result[key].filter(r=>r.employeeId===b.userId||r.userId===b.userId);
  for(const key of ['notifications','notificationHistory'])result[key]=result[key].filter(r=>r.userId===b.userId||r.toUserId===b.userId);
  result.shifts=result.shifts.filter(s=>['published','confirmed'].includes(s.status));
  result.accessInvitations=[];result.joinRequests=[];
  result.notices=result.notices.filter(n=>n.audience==='all'||n.audience==='employee'||n.userIds?.includes(b.userId));
  result.noticeReads=result.noticeReads.filter(r=>r.userId===b.userId);
 }
 // Delivery credentials and old global configuration never leave the server.
 result.emailConfig={enabled:true,mode:'secure_backend',appUrl:'https://aadi4875.github.io/MySchedule/'};
 return result;
}
function response(doc,b,extra={}){return {ok:true,businessId:b.businessId,userId:b.userId,role:b.role,revision:doc.revision||0,state:scoped(doc,b),...extra};}
function change(doc){doc.revision=Number(doc.revision||0)+1;doc.updatedAt=new Date().toISOString();}
function tokenRow(doc,token){need(typeof token==='string'&&/^[a-f0-9]{64}$/i.test(token),'Invalid invitation link.','invalid-argument');const h=hash(token);const invite=doc.state.accessInvitations.find(i=>(i.id===h||i.tokenHash===h));need(invite,'Invitation not found. Ask your manager for a new link.','not-found');return invite;}
function invitationStatus(i,now){return i.status==='pending'&&Date.parse(i.expiresAt)<=now?'expired':i.status;}
function validInvite(i,now){need(i.status==='pending','Invitation is no longer pending.','failed-precondition');need(Number.isFinite(Date.parse(i.expiresAt))&&Date.parse(i.expiresAt)>now,'Invitation expired. Ask your manager to resend.','deadline-exceeded');}
function own(r,b){return (r.userId===b.userId||r.employeeId===b.userId)&&(!r.userId||r.userId===b.userId)&&(!r.employeeId||r.employeeId===b.userId);}
const SELF_FIELDS=['name','phone','photoData','notifyEmail','notifyInApp','pendingEmail','pendingEmailRequestedAt','pendingEmailDeliveryError','updatedAt','profileRevision','profileVerifiedByAuthUid'];
function onlyChanges(before,after,fields){return Object.keys({...before,...after}).every(k=>equal(before[k],after[k])||fields.includes(k));}
function mergeTable(s,key,businessId,rows){s[key]=s[key].filter(r=>r.businessId!==businessId).concat(rows);}
function save(doc,auth,data){
 const b=member(doc,auth,data.businessId);const incoming=clean(data.state);const s=doc.state;
 need(Number(data.expectedRevision)===Number(doc.revision||0),'The workplace changed. Reload before saving again.','aborted');
 const visible=scoped(doc,b);
 for(const key of Object.keys(incoming))need(TABLES.includes(key)||key==='emailConfig','Unsupported workplace field: '+key,'invalid-argument');
 for(const key of TABLES){if(!Object.hasOwn(incoming,key))continue;
  const rows=incoming[key];
  if(key==='businesses'){
   need(Array.isArray(rows)&&rows.length===1&&rows[0].id===b.businessId,'Invalid business.');
   if(b.role==='owner'){const old=s.businesses.find(r=>r.id===b.businessId);need(['id','createdByOwnerId','createdAt','businessCode','storeCode'].every(k=>equal(old[k],rows[0][k])),'Protected business fields cannot be changed.');Object.assign(old,rows[0]);}
   else need(equal(rows,visible[key]),'Only the owner can change business settings.');continue;
  }
  checkRows(rows,b.businessId);
  if(['accessInvitations','joinRequests'].includes(key)){need(equal(rows,visible[key]),'Use the authorized invitation operation.');continue;}
  if(key==='users'){
   need(rows.length===visible.users.length,'Use Team Access to remove accounts.');
   for(const row of rows){const old=s.users.find(u=>u.id===row.id&&u.businessId===b.businessId);need(old,'Account creation requires an invitation.');
    const view=visible.users.find(u=>u.id===row.id);need(view,'Account is not visible.');
    const fields=row.id===b.userId?SELF_FIELDS:b.role==='owner'||b.role==='manager'&&old.role==='employee'?['name','phone','notifyEmail','notifyInApp','hireDate','branchIds','primaryBranchId','updatedAt']:[];
    need(['id','businessId','authUid','email','role','status','accountSource','activeInvitationId'].every(k=>equal(view[k],row[k])),'Account identity, role and access state are protected.');for(const field of fields)if(Object.hasOwn(row,field)){if(field==='photoData')need(!row[field]||/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/.test(row[field]),'Choose a PNG, JPEG, WebP or GIF profile photo.','invalid-argument');if(field==='name')need(typeof row[field]==='string'&&row[field].length>=2&&row[field].length<=80,'Enter a name of 2–80 characters.','invalid-argument');old[field]=row[field];}
   }continue;
  }
  if(b.role!=='employee'){mergeTable(s,key,b.businessId,rows);continue;}
  if(key==='shifts'){
   need(rows.length===visible.shifts.length,'Employees cannot add or delete shifts.');
   for(const row of rows){const old=s.shifts.find(r=>r.id===row.id&&r.businessId===b.businessId);need(old&&own(old,b)&&onlyChanges(old,row,['status','acknowledgedAt','acknowledgedBy','confirmedAt','updatedAt'])&&['published','confirmed'].includes(row.status)||old&&equal(old,row),'Employees can only acknowledge their own published shifts.');if(own(old,b))Object.assign(old,row);}continue;
  }
  if(key==='notices'){need(equal(rows,visible[key]),'Only management can publish notices.');continue;}
  if(key==='noticeReads'){for(const row of rows){need(row.userId===b.userId&&visible.notices.some(n=>n.id===row.noticeId),'You can mark only your visible notices as read.');if(!s.noticeReads.some(r=>r.noticeId===row.noticeId&&r.userId===b.userId))s.noticeReads.push({id:row.id,businessId:b.businessId,noticeId:row.noticeId,userId:b.userId,readAt:new Date().toISOString()});}continue;}
  if(['branches','employees'].includes(key)){need(equal(rows,visible[key]),'Only management can change team records.');continue;}
  if(['notifications','notificationHistory'].includes(key)){
   for(const row of rows){const old=s[key].find(r=>r.id===row.id&&r.businessId===b.businessId);
    if(!old){need(key==='notifications'&&doc.bindings.some(m=>m.businessId===b.businessId&&m.userId===row.userId&&m.status==='active'&&['owner','manager'].includes(m.role)),'Notification recipient must be your workplace manager.');s.notifications.push({id:row.id,businessId:b.businessId,userId:row.userId,type:'employee_update',subject:'Employee update',message:text(profile(doc,b).name,80)+': '+text(row.message,2000),createdByUserId:b.userId,read:false,createdAt:new Date().toISOString(),requiresAction:false,actionStatus:'informational',targetView:'requests'});continue;}
    need(old.userId===b.userId&&onlyChanges(old,row,['read','readAt']),'Employees can only mark their own notifications as read.');old.read=row.read===true;if(row.readAt)old.readAt=row.readAt;}continue;
  }
  if(['availability','requests','timesheets'].includes(key)){
   for(const row of rows){need(own(row,b),'Employees can edit only their own records.');const old=s[key].find(r=>r.id===row.id);
    if(old)need(old.businessId===b.businessId&&own(old,b),'Record belongs to another workplace or employee.');
    if(old&&equal(old,row))continue;
    need(!row.approvedBy&&!row.approvedAt&&!row.decidedBy&&!row.decisionByUserId&&!row.reviewedBy,'Only management can approve records.');
    if(key==='requests')need(['pending','cancelled'].includes(row.status)&&(!old||old.status==='pending'),'Only pending requests can be submitted or cancelled.');
    if(key==='timesheets'){const fields=['id','businessId','employeeId','userId','shiftId','scheduledStart','scheduledEnd','role','clockIn','clockOut','breaks','status','isException','exceptionReason','exceptionNote','exceptionCreatedAt','createdAt','clockOutNote','updatedAt','workedHours','breakMinutes','clockOutSource','autoClockOutAt','clockOutReason'];need(Object.keys(row).every(k=>fields.includes(k)||old&&equal(old[k],row[k])||k==='managerNote'&&!row[k]),'Manager timesheet fields are protected.');}
    if(key==='timesheets')need(!row.status||['pending','submitted','open','clocked_in','clocked_out'].includes(row.status),'Only management can approve timesheets.');
    if(key==='timesheets'&&old)need(!['approved','rejected'].includes(old.status),'Approved timesheets are locked.');
    if(old)Object.assign(old,row);else s[key].push(row);
   }continue;
  }
  need(equal(rows,visible[key]),'Unsupported employee change.');
 }
 change(doc);return response(doc,b);
}
function run(input,auth,action,data={},options={}){
 const doc=clone(input);ready(doc);const s=doc.state;const now=options.now||Date.now();const stamp=new Date(now).toISOString();
 if(action==='getInvitation'){
  const i=tokenRow(doc,data.token);const b=s.businesses.find(b=>b.id===i.businessId);const e=email(i.email);const at=e.indexOf('@');
  return {doc,result:{ok:true,status:invitationStatus(i,now),businessName:b?.name||'Workplace',role:i.role,name:i.name,emailMasked:e.slice(0,2)+'•••'+e.slice(at),expiresAt:i.expiresAt,invitedByName:i.invitedByName,recipientProof:hash(data.token+'|'+e)}};
 }
 identity(auth,action!=='createWorkspace');
 if(action==='createWorkspace'){
  need(!doc.bindings.some(b=>b.uid===auth.uid&&b.role==='owner'),'An owner workspace already exists. Sign in.','already-exists');
  const name=text(data.name,80),businessName=text(data.businessName);need(name.length>1&&businessName,'Enter your name and business name.','invalid-argument');
  const businessId=randomUUID(),userId=randomUUID();const b={uid:auth.uid,email:email(auth.email),businessId,userId,role:'owner',status:'pending_verification',source:'workspace_creator'};
  doc.bindings.push(b);s.businesses.push({id:businessId,name:businessName,businessCode:randomBytes(5).toString('hex').toUpperCase(),country:text(data.country)||'Australia',timezone:text(data.timezone)||'Australia/Perth',industry:'Other',createdAt:stamp,createdByOwnerId:userId});
  s.users.push({id:userId,businessId,name,email:b.email,authUid:auth.uid,role:'owner',status:b.status,accountSource:'workspace_creator',notifyEmail:true,notifyInApp:true,createdAt:stamp});change(doc);return {doc,result:{ok:true,businessId,userId}};
 }
 if(action==='acceptInvitation'){
  const i=tokenRow(doc,data.token);validInvite(i,now);need(email(i.email)===email(auth.email),'Use the verified email that received this invitation.');
  const p=s.users.find(u=>u.id===i.userId&&u.businessId===i.businessId);need(p&&p.status==='invited'&&p.activeInvitationId===i.tokenHash&&p.role===i.role&&email(p.email)===email(auth.email),'This invitation was replaced or no longer matches its membership.');
  need(['employee','manager'].includes(i.role),'Invalid invitation role.');need(!p.authUid||p.authUid===auth.uid,'This profile is bound to a different identity.');
  const inviter=doc.bindings.find(b=>b.businessId===i.businessId&&b.userId===i.invitedByUserId&&b.status==='active'&&(i.role==='manager'?b.role==='owner':['owner','manager'].includes(b.role)));need(inviter,'The inviter no longer has permission. Ask the owner for a new link.');
  need(!doc.bindings.some(b=>b.businessId===i.businessId&&(b.uid===auth.uid||b.userId===p.id)&&b.status==='active'),'This workplace membership is already active.','already-exists');
  doc.bindings=doc.bindings.filter(b=>!(b.businessId===i.businessId&&(b.userId===p.id||b.uid===auth.uid)));
  const b={businessId:i.businessId,userId:p.id,uid:auth.uid,email:email(auth.email),role:i.role,status:'active',source:'manager_invite'};doc.bindings.push(b);
  Object.assign(p,{authUid:auth.uid,status:'active',emailVerified:true,accountSource:'manager_invite',activeInvitationId:'',acceptedAt:stamp});Object.assign(i,{status:'accepted',acceptedAt:stamp,acceptedByUid:auth.uid});
  for(const n of s.notifications)if(n.userId===p.id&&n.actionKind==='accept_invitation'){n.requiresAction=false;n.actionStatus='resolved';n.read=true;}
  change(doc);return {doc,result:response(doc,b)};
 }
 // Only a pending owner created by this server can self-activate after verification.
 for(const b of doc.bindings)if(b.uid===auth.uid&&b.email===email(auth.email)&&b.role==='owner'&&b.status==='pending_verification'&&b.source==='workspace_creator'){
  b.status='active';const p=profile(doc,b);p.status='active';p.emailVerified=true;change(doc);
 }
 // Firebase verifies the new email before a pending self-service email change is committed.
 for(const b of doc.bindings.filter(b=>b.uid===auth.uid&&b.status==='active')){
  if(b.email!==email(auth.email)){const p=profile(doc,b);b.email=email(auth.email);p.email=b.email;p.pendingEmail='';p.emailVerified=true;change(doc);}
 }
 if(action==='listWorkspaces')return {doc,result:{ok:true,workspaces:doc.bindings.filter(b=>b.uid===auth.uid&&b.status==='active').map(b=>({businessId:b.businessId,userId:b.userId,role:b.role,businessName:s.businesses.find(x=>x.id===b.businessId)?.name||'Workplace'}))}};
 const b=member(doc,auth,data.businessId);
 if(action==='loadWorkspaceState'||action==='repairMyAccess'||action==='recordVerifiedLogin'||action==='getAccessStatus')return {doc,result:response(doc,b)};
 if(action==='saveWorkspaceState')return {doc,result:save(doc,auth,data)};
 if(action==='createInvitation'){
  need(['owner','manager'].includes(b.role),'Management access is required.');need(data.role!=='manager'||b.role==='owner','Only owners can invite managers.');
  const e=email(data.email),name=text(data.name,80),role=data.role==='manager'?'manager':'employee';need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)&&e.length<=254&&name.length>1,'Enter a valid name and email.','invalid-argument');need(e!==email(auth.email),'Use your team member’s email.','invalid-argument');
  let p=s.users.find(u=>u.businessId===b.businessId&&email(u.email)===e);need(!p||!['active','pending_verification'].includes(p.status),'This member is already active.','already-exists');
  const raw=randomBytes(32).toString('hex'),tokenHash=hash(raw),expiresAt=new Date(now+7*86400000).toISOString();const inviter=profile(doc,b);const business=s.businesses.find(x=>x.id===b.businessId);
  for(const old of s.accessInvitations)if(old.businessId===b.businessId&&email(old.email)===e&&old.status==='pending'){old.status='revoked';old.replacedBy=tokenHash;old.revokedAt=stamp;}
  if(!p){p={id:randomUUID(),businessId:b.businessId};s.users.push(p);}
  Object.assign(p,{name,email:e,role,status:'invited',activeInvitationId:tokenHash,inviteExpiresAt:expiresAt,invitedByUserId:b.userId,notifyEmail:true,notifyInApp:true});
  // Reinvitation never authorizes a new Firebase identity until verified acceptance.
  const i={id:tokenHash,tokenHash,businessId:b.businessId,userId:p.id,name,email:e,role,status:'pending',createdAt:stamp,expiresAt,invitedByUserId:b.userId,invitedByName:inviter.name};s.accessInvitations.push(i);
  if(role==='employee'&&!s.employees.some(x=>x.userId===p.id))s.employees.push({id:p.id,userId:p.id,businessId:b.businessId,employmentType:['casual','part-time','full-time'].includes(data.employmentType)?data.employmentType:'casual',hireDate:/^\d{4}-\d{2}-\d{2}$/.test(data.hireDate||'')?data.hireDate:stamp.slice(0,10),roleLabel:text(data.roleLabel,80)||'Team Member',weeklyLimit:Math.min(168,Math.max(0,Number(data.weeklyLimit)||30)),fortnightLimit:Math.min(336,Math.max(0,Number(data.fortnightLimit)||48)),status:'active'});
  if(role==='manager')s.employees=s.employees.filter(x=>!(x.businessId===b.businessId&&x.userId===p.id));
  change(doc);return {doc,result:response(doc,b,{token:raw,tokenHash,recipientProof:hash(raw+'|'+e),email:e,name,role,expiresAt,invitedByName:inviter.name,businessName:business.name,userId:p.id})};
 }
 if(action==='revokeInvitation'){
  need(['owner','manager'].includes(b.role),'Management access is required.');const i=s.accessInvitations.find(i=>i.businessId===b.businessId&&(i.id===data.invitationId||i.tokenHash===data.invitationId));need(i,'Invitation not found.','not-found');need(i.role!=='manager'||b.role==='owner','Only owners can revoke manager invitations.');need(i.status==='pending','Invitation is not pending.','failed-precondition');i.status='revoked';i.revokedAt=stamp;const p=s.users.find(u=>u.id===i.userId&&u.businessId===b.businessId);if(p?.activeInvitationId===i.tokenHash){p.status='invitation_revoked';p.activeInvitationId='';}change(doc);return {doc,result:response(doc,b)};
 }
 if(action==='removeMember'){
  need(['owner','manager'].includes(b.role),'Management access is required.');const p=s.users.find(u=>u.id===data.userId&&u.businessId===b.businessId);need(p&&p.role!=='owner'&&p.id!==b.userId,'You cannot remove the owner or yourself.');need(p.role!=='manager'||b.role==='owner','Only owners can remove managers.');p.status='removed';for(const binding of doc.bindings)if(binding.businessId===b.businessId&&binding.userId===p.id)binding.status='removed';for(const i of s.accessInvitations)if(i.businessId===b.businessId&&i.userId===p.id&&i.status==='pending')i.status='revoked';change(doc);return {doc,result:response(doc,b)};
 }
 if(action==='sendWorkplaceEmail'){
  const to=email(data.to_email);need(doc.bindings.some(m=>m.businessId===b.businessId&&m.status==='active'&&email(m.email)===to)||s.accessInvitations.some(i=>i.businessId===b.businessId&&email(i.email)===to&&i.status==='pending'&&Date.parse(i.expiresAt)>now),'Recipient must have approved access or a current invitation to this workplace.');need(b.role!=='employee','Employee email is not enabled; use in-app requests.');return {doc,result:{ok:true,authorized:true,businessId:b.businessId,to,businessName:s.businesses.find(x=>x.id===b.businessId).name,replyTo:doc.bindings.find(m=>m.businessId===b.businessId&&m.role==='owner'&&m.status==='active')?.email||''}};
 }
 fail('unimplemented','This action is unavailable. Employees must use a workplace invitation.');
}
module.exports={run,scoped,member,hash,shape,clean,identity};
