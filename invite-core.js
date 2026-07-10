/* MySchedule Invitation Core v137
   Pure, testable invitation validation and state mutation logic. */
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  if(root)root.MyScheduleInviteCore=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';

  const ROLES=new Set(['employee','manager']);
  const EMPLOYMENT_TYPES=new Set(['casual','part-time','full-time']);
  const ACTIVE_STATUSES=new Set(['active','pending_verification']);
  const REUSABLE_STATUSES=new Set(['invited','invitation_expired','invitation_revoked','removed','inactive']);

  function err(code,message,details){
    const e=new Error(message);e.code=code;if(details)e.details=details;return e;
  }
  function normalizeEmail(value){return String(value||'').trim().toLowerCase();}
  function cleanText(value,max=120){
    return String(value||'')
      .replace(/[\u0000-\u001F\u007F]/g,' ')
      .replace(/\s+/g,' ')
      .trim()
      .slice(0,max);
  }
  function validEmail(value){
    const email=normalizeEmail(value);
    if(!email||email.length>254||email.includes('..'))return false;
    return /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email);
  }
  function toBoundedNumber(value,fallback,min,max){
    const n=Number(value);
    return Number.isFinite(n)?Math.min(max,Math.max(min,n)):fallback;
  }
  function validIsoDate(value){
    const text=String(value||'');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(text))return false;
    const d=new Date(`${text}T00:00:00Z`);
    return Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===text;
  }
  function ensureArrays(input){
    const state=(input&&typeof input==='object')?input:{};
    ['businesses','users','employees','notifications','notificationHistory','accessInvitations','joinRequests','availability','shifts','requests','timesheets'].forEach(k=>{if(!Array.isArray(state[k]))state[k]=[];});
    return state;
  }
  function safeClone(input,maxDepth=40){
    const seen=new WeakSet();
    function walk(value,depth){
      if(value===null||value===undefined)return value;
      const t=typeof value;
      if(t==='string'||t==='number'||t==='boolean')return value;
      if(t==='bigint')return Number(value);
      if(t==='function'||t==='symbol')return undefined;
      if(value instanceof Date)return value.toISOString();
      if(depth>maxDepth)return undefined;
      if(t==='object'){
        if(seen.has(value))return undefined;
        seen.add(value);
        const out=Array.isArray(value)?[]:{};
        if(Array.isArray(value)){
          for(const item of value){const v=walk(item,depth+1);if(v!==undefined)out.push(v);}
        }else{
          for(const key of Object.keys(value)){
            if(['password','localPassword','tempPassword','forcePasswordChange'].includes(key))continue;
            const v=walk(value[key],depth+1);if(v!==undefined)out[key]=v;
          }
        }
        seen.delete(value);return out;
      }
      return undefined;
    }
    return walk(input,0);
  }
  function byteSize(value){
    const text=JSON.stringify(value);
    if(typeof TextEncoder!=='undefined')return new TextEncoder().encode(text).length;
    if(typeof Buffer!=='undefined')return Buffer.byteLength(text,'utf8');
    return unescape(encodeURIComponent(text)).length;
  }
  function compactState(input,targetBytes=880000){
    const state=ensureArrays(safeClone(input)||{});
    const sortNewest=(a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||''));
    // Never remove a notification that is unread or still requires action.
    const protectedNotes=state.notifications.filter(n=>n&&((n.requiresAction===true&&n.actionStatus!=='resolved')||n.read===false));
    const protectedIds=new Set(protectedNotes.map(n=>n.id));
    const optionalNotes=state.notifications.filter(n=>n&&!protectedIds.has(n.id)).sort(sortNewest).slice(0,350);
    state.notifications=protectedNotes.concat(optionalNotes).sort((a,b)=>String(a.createdAt||'').localeCompare(String(b.createdAt||'')));
    state.notificationHistory=state.notificationHistory.sort(sortNewest).slice(0,250);
    // Debug payloads are operational logs, not workforce records.
    delete state.emailDebug;
    delete state.debug;
    delete state.diagnostics;
    if(byteSize(state)<=targetBytes)return state;
    // Second pass only removes resolved/read notification history.
    state.notificationHistory=state.notificationHistory.slice(0,80);
    state.notifications=protectedNotes.concat(optionalNotes.slice(0,80));
    return state;
  }
  function validateInput(raw,ctx){
    const name=cleanText(raw&&raw.name,80);
    const email=normalizeEmail(raw&&raw.email);
    const role=ROLES.has(raw&&raw.role)?raw.role:'employee';
    const hireDate=String(raw&&raw.hireDate||ctx.today||'');
    const employmentType=EMPLOYMENT_TYPES.has(raw&&raw.employmentType)?raw.employmentType:'casual';
    const roleLabel=cleanText(raw&&raw.roleLabel||'Team Member',80)||'Team Member';
    if(name.length<2)throw err('invalid-name','Enter the team member’s full name.');
    if(!validEmail(email))throw err('invalid-email','Enter a valid email address.');
    if(email===normalizeEmail(ctx.inviterEmail))throw err('self-invite','You are already signed in with this email. Use another team member’s email.');
    if(!validIsoDate(hireDate))throw err('invalid-date','Select a valid hire date.');
    if(role==='manager'&&ctx.inviterRole!=='owner')throw err('manager-role-denied','Only the owner can invite a manager.');
    return {
      name,email,role,hireDate,employmentType,roleLabel,
      weeklyLimit:Math.round(toBoundedNumber(raw&&raw.weeklyLimit,30,0,168)),
      fortnightLimit:Math.round(toBoundedNumber(raw&&raw.fortnightLimit,48,0,336))
    };
  }
  function notification(args,ctx){
    return {
      id:ctx.id(),refId:ctx.ref(),businessId:args.businessId,userId:args.userId,toUserId:args.userId,
      type:args.type,subject:args.subject,originalSubject:args.subject,message:args.message,originalMessage:args.message,
      read:false,createdAt:ctx.now,requiresAction:args.requiresAction===true,
      actionStatus:args.requiresAction===true?'pending':'informational',actionKind:args.actionKind||'',
      targetView:args.targetView||'notifications',entityId:args.entityId||'',emailStatus:args.emailStatus||'in_app'
    };
  }
  function applyInvitation(inputState,raw,context){
    const ctx={...context};
    if(!ctx||!ctx.businessId||!ctx.inviterId||!ctx.inviterRole)throw err('invalid-context','The signed-in workplace could not be verified.');
    if(!['owner','manager'].includes(ctx.inviterRole))throw err('permission-denied','Owner or manager access is required.');
    if(!ctx.tokenHash||String(ctx.tokenHash).length<32)throw err('token-error','A secure invitation token could not be created.');
    if(typeof ctx.id!=='function'||typeof ctx.ref!=='function')throw err('invalid-context','Invitation identifiers are unavailable.');
    const state=ensureArrays(safeClone(inputState)||{});
    const data=validateInput(raw,ctx);
    const business=state.businesses.find(b=>b.id===ctx.businessId);
    if(!business)throw err('business-not-found','The active workplace could not be found. Refresh and sign in again.');

    // One verified Firebase identity may have independent memberships in multiple businesses.
    // Duplicate protection is scoped to the active business only.
    let profile=state.users.find(u=>u.businessId===ctx.businessId&&normalizeEmail(u.email)===data.email);
    const existedBefore=!!profile;
    if(profile&&ACTIVE_STATUSES.has(profile.status))throw err('already-active','This person already has active access to this workplace.',{userId:profile.id});
    if(profile&&profile.status==='join_pending')throw err('join-pending','This person already sent a join request. Review it in Team Access.',{userId:profile.id});
    if(profile&&!REUSABLE_STATUSES.has(profile.status))throw err('duplicate-status',`This email already has ${cleanText(profile.status,40)||'an existing'} access record.`,{userId:profile.id});

    const userId=profile?profile.id:ctx.id();
    // Revoke every old pending invitation for the same profile/email.
    const revokedTokenHashes=[];
    state.accessInvitations.forEach(i=>{
      if(i.status==='pending'&&(i.userId===userId||normalizeEmail(i.email)===data.email)){
        if(i.tokenHash||i.id)revokedTokenHashes.push(i.tokenHash||i.id);
        i.status='revoked';i.revokedAt=ctx.now;i.replacedBy=ctx.tokenHash;
      }
    });
    state.notifications.forEach(n=>{
      if(n.userId===userId&&n.actionKind==='accept_invitation'&&n.requiresAction===true){
        n.requiresAction=false;n.actionStatus='resolved';n.resolvedAt=ctx.now;n.read=true;
      }
    });

    const defaultBranchId=business.defaultBranchId||((state.branches||[]).find(br=>br.businessId===ctx.businessId&&br.status!=='removed')||{}).id||'';
    const profileValues={
      id:userId,businessId:ctx.businessId,name:data.name,email:data.email,role:data.role,status:'invited',
      notifyEmail:true,notifyInApp:true,emailVerified:false,hireDate:data.hireDate,
      branchIds:defaultBranchId?[defaultBranchId]:[],primaryBranchId:defaultBranchId,
      invitedAt:ctx.now,invitedByUserId:ctx.inviterId,invitedByName:cleanText(ctx.inviterName||ctx.inviterEmail,80),
      invitedByRole:ctx.inviterRole,invitationSource:'manager_invite',inviteExpiresAt:ctx.expiresAt,
      activeInvitationId:ctx.tokenHash,updatedAt:ctx.now
    };
    if(profile)Object.assign(profile,profileValues);
    else{profile={...profileValues,createdAt:ctx.now};state.users.push(profile);}
    delete profile.password;delete profile.localPassword;delete profile.tempPassword;delete profile.forcePasswordChange;

    if(data.role==='employee'){
      let emp=state.employees.find(e=>e.userId===userId||e.id===userId);
      const employeeValues={id:emp&&emp.id||userId,businessId:ctx.businessId,userId,hireDate:data.hireDate,
        employmentType:data.employmentType,visaTracking:true,fortnightLimit:data.fortnightLimit,
        weeklyLimit:data.weeklyLimit,preferredHours:20,roleLabel:data.roleLabel,status:'active'};
      if(emp)Object.assign(emp,employeeValues);else state.employees.push(employeeValues);
    }else{
      // A manager must not retain a stale employee profile from an earlier invitation.
      state.employees=state.employees.filter(e=>e.userId!==userId);
    }

    const invite={
      id:ctx.tokenHash,tokenHash:ctx.tokenHash,businessId:ctx.businessId,userId,email:data.email,name:data.name,
      role:data.role,status:'pending',createdAt:ctx.now,expiresAt:ctx.expiresAt,
      invitedByUserId:ctx.inviterId,invitedByName:cleanText(ctx.inviterName||ctx.inviterEmail,80),
      invitedByRole:ctx.inviterRole,source:'manager_invite'
    };
    state.accessInvitations.push(invite);

    const inviteNote=notification({businessId:ctx.businessId,userId,type:'invite',subject:'MySchedule workplace invitation',
      message:`${invite.invitedByName||'Your manager'} invited you to ${cleanText(business.name,100)||'the workplace'} as ${data.role}.`,
      targetView:data.role==='employee'?'myshifts':'dashboard',entityId:userId,requiresAction:true,
      actionKind:'accept_invitation',emailStatus:'pending_delivery'},ctx);
    inviteNote.to=data.email;inviteNote.toName=data.name;inviteNote.role=data.role;
    state.notifications.push(inviteNote);
    state.users.filter(u=>u.businessId===ctx.businessId&&['owner','manager'].includes(u.role)&&u.status==='active').forEach(manager=>{
      state.notifications.push(notification({businessId:ctx.businessId,userId:manager.id,type:'invite_created',
        subject:'Team invitation created',message:`${data.name} was invited as ${data.role} by ${invite.invitedByName||'a manager'}.`,
        targetView:'credentials',entityId:userId},ctx));
    });

    const compacted=compactState(state,ctx.targetBytes||880000);
    return {state:compacted,result:{userId,email:data.email,name:data.name,role:data.role,expiresAt:ctx.expiresAt,
      invitedByName:invite.invitedByName,businessName:cleanText(business.name,100)||'Workplace',noteId:inviteNote.id,
      tokenHash:ctx.tokenHash,reinvited:existedBefore,revokedTokenHashes}};
  }
  function publicSummary(result){
    const email=normalizeEmail(result.email);
    const at=email.indexOf('@');
    const local=at>0?email.slice(0,at):email;const domain=at>0?email.slice(at):'';
    const masked=(local.slice(0,Math.min(2,local.length))||'•')+'•••'+domain;
    return {businessId:result.businessId||'',businessName:cleanText(result.businessName,100),name:cleanText(result.name,80),
      role:ROLES.has(result.role)?result.role:'employee',emailMasked:masked,status:'pending',expiresAt:result.expiresAt,
      invitedByName:cleanText(result.invitedByName,80),createdAt:result.createdAt||''};
  }

  return {normalizeEmail,cleanText,validEmail,validIsoDate,safeClone,byteSize,compactState,validateInput,applyInvitation,publicSummary,err};
});
