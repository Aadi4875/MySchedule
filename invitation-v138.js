/* MySchedule v138 - reliable invitation workflow
   Atomic latest-state writes, hardened input validation, email-independent success,
   public invitation summaries, and safe mobile dialogs. */
(function(){
  'use strict';
  const Core=window.MyScheduleInviteCore;
  if(!Core){console.error('MySchedule invitation core is missing.');return;}
  const VERSION='1.38.0';
  const PUBLIC_INVITES='publicInvitations';
  const MAX_CLOUD_BYTES=930000;
  const originalCompat=typeof window.__v135CompatCall==='function'?window.__v135CompatCall:null;
  let creating=false;
  let lastPublicInviteError='';

  function appError(code,message,cause){const e=new Error(message);e.code=code;if(cause)e.cause=cause;return e;}
  function authUser(){return firebaseAuth&&firebaseAuth.currentUser?firebaseAuth.currentUser:null;}
  function isoNow(){return new Date().toISOString();}
  function randomHex(bytes=24){
    const out=new Uint8Array(bytes);
    if(window.crypto&&crypto.getRandomValues)crypto.getRandomValues(out);else for(let i=0;i<bytes;i++)out[i]=Math.floor(Math.random()*256);
    return Array.from(out,b=>b.toString(16).padStart(2,'0')).join('');
  }
  function uid(){return typeof uuid==='function'?uuid():randomHex(16);}
  function refId(){return typeof generateNotificationRef==='function'?generateNotificationRef():`MS-${Date.now()}-${randomHex(3).toUpperCase()}`;}
  function sha256Fallback(value){
    // Deterministic SHA-256 for older/non-secure browser contexts where SubtleCrypto is unavailable.
    const text=unescape(encodeURIComponent(String(value||'')));
    const rightRotate=(n,x)=>(x>>>n)|(x<<(32-n));
    const maxWord=Math.pow(2,32);let result='';const words=[];
    const asciiBitLength=text.length*8;let hash=sha256Fallback.h=sha256Fallback.h||[];let k=sha256Fallback.k=sha256Fallback.k||[];
    let primeCounter=k.length;const isComposite={};
    for(let candidate=2;primeCounter<64;candidate++){
      if(!isComposite[candidate]){
        for(let i=0;i<313;i+=candidate)isComposite[i]=candidate;
        hash[primeCounter]=(Math.pow(candidate,.5)*maxWord)|0;
        k[primeCounter++]=(Math.pow(candidate,1/3)*maxWord)|0;
      }
    }
    let ascii=text+'\x80';while(ascii.length%64-56)ascii+='\x00';
    for(let i=0;i<ascii.length;i++){const j=ascii.charCodeAt(i);if(j>>8)throw appError('hash-error','The invitation token could not be secured.');words[i>>2]|=j<<((3-i)%4)*8;}
    words[words.length]=(asciiBitLength/maxWord)|0;words[words.length]=asciiBitLength;
    for(let j=0;j<words.length;){const w=words.slice(j,j+=16);const oldHash=hash.slice(0);hash=hash.slice(0,8);
      for(let i=0;i<64;i++){
        const w15=w[i-15],w2=w[i-2];
        const a=hash[0],e=hash[4];
        const temp1=(hash[7]+(rightRotate(6,e)^rightRotate(11,e)^rightRotate(25,e))+((e&hash[5])^((~e)&hash[6]))+k[i]+(w[i]=(i<16)?w[i]:((w[i-16]+(rightRotate(7,w15)^rightRotate(18,w15)^(w15>>>3))+w[i-7]+(rightRotate(17,w2)^rightRotate(19,w2)^(w2>>>10)))|0)))|0;
        const temp2=((rightRotate(2,a)^rightRotate(13,a)^rightRotate(22,a))+((a&hash[1])^(a&hash[2])^(hash[1]&hash[2])))|0;
        hash=[(temp1+temp2)|0].concat(hash);hash[4]=(hash[4]+temp1)|0;hash.pop();
      }
      for(let i=0;i<8;i++)hash[i]=(hash[i]+oldHash[i])|0;
    }
    for(let i=0;i<8;i++)for(let j=3;j+1;j--){const b=(hash[i]>>(j*8))&255;result+=(b<16?'0':'')+b.toString(16);}
    return result;
  }
  async function sha256(value){
    if(window.crypto&&crypto.subtle&&window.TextEncoder){
      try{const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(String(value||'')));return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');}catch(_e){}
    }
    return sha256Fallback(value);
  }
  function baseUrl(){
    const configured=String(state?.emailConfig?.appUrl||'').trim();
    const candidates=[];
    // On a published HTTPS site, always prefer the page the owner is actually using.
    // This prevents stale localhost/old-domain settings from producing dead links.
    try{const live=new URL(window.location.href);if(live.protocol==='https:')candidates.push(live);}catch(_e){}
    try{if(configured)candidates.push(new URL(configured));}catch(_e){}
    try{const live=new URL(window.location.href);candidates.push(live);}catch(_e){}
    const u=candidates.find(x=>/^https?:$/.test(x.protocol));
    if(!u)return '';
    u.search='';u.hash='';return u.toString();
  }
  function invitationLink(token,recipientProof=''){
    const base=baseUrl();
    if(!base)throw appError('public-url-missing','Open MySchedule from its published HTTPS website before creating an invitation.');
    const u=new URL(base);u.searchParams.set('invite',token);if(recipientProof)u.searchParams.set('recipient',recipientProof);u.searchParams.set('setup','1');return u.toString();
  }
  function activeManager(remote,auth){
    const email=Core.normalizeEmail(auth?.email||'');
    const matches=(remote.users||[]).filter(u=>u&&u.status!=='removed'&&(u.authUid===auth?.uid||Core.normalizeEmail(u.email)===email));
    const local=typeof currentUser==='function'?currentUser():null;
    // With multi-business accounts, the active membership must win. Never invite from
    // whichever business happens to be first in the shared account list.
    return matches.find(u=>local&&u.id===local.id&&['owner','manager'].includes(u.role))
      ||matches.find(u=>u.authUid===auth?.uid&&['owner','manager'].includes(u.role))
      ||matches.find(u=>['owner','manager'].includes(u.role));
  }
  function mapError(error){
    const code=String(error?.code||'').replace(/^firestore\//,'').replace(/^functions\//,'');
    const raw=String(error?.message||'').replace(/^FirebaseError:\s*/i,'').trim();
    if(error?.details?.userId&&['already-active','join-pending'].includes(code))return error;
    if(code==='permission-denied')return appError(code,raw||'Your account does not have permission to invite team members.',error);
    if(code==='unauthenticated')return appError(code,'Your sign-in session expired. Sign in again and retry.',error);
    if(code==='resource-exhausted'||/document.*too large|workspace.*too large|1\s*MiB/i.test(raw))return appError('workspace-size','The workspace cloud file is full. Old resolved notification logs must be archived before another team member can be added.',error);
    if(code==='unavailable'||code==='deadline-exceeded'||/network|offline|failed to fetch/i.test(raw))return appError('network','MySchedule could not reach Firebase. Check the internet connection and retry; no duplicate was created.',error);
    if(code==='aborted')return appError(code,'The workspace changed at the same time. Please retry once.',error);
    return appError(code||'invite-failed',raw||'The invitation could not be created.',error);
  }
  function payloadFromForm(){
    return {
      name:String(val('u-name')||''),email:String(val('u-email')||''),role:val('u-role')||'employee',
      hireDate:val('u-hire-date')||isoDate(new Date()),employmentType:val('u-type')||'casual',
      roleLabel:String(val('u-duty')||'Team Member'),weeklyLimit:val('u-weekly'),fortnightLimit:val('u-fortnight')
    };
  }
  function setBusy(busy){
    const button=document.querySelector('.apple-team-dialog [data-v137-add]')||document.querySelector('.apple-team-dialog .apple-dialog-actions .primary');
    if(button){button.disabled=busy;button.setAttribute('aria-busy',busy?'true':'false');button.textContent=busy?'Creating invitation…':'Create invitation';}
    document.querySelectorAll('.apple-team-dialog input,.apple-team-dialog select').forEach(x=>x.disabled=busy);
  }
  function showExisting(error){
    const id=error?.details?.userId;
    const user=(state?.users||[]).find(u=>u.id===id);
    if(!user)return toast(error.message);
    const pending=error.code==='join-pending';
    modal(`<div class="apple-status-dialog"><div class="apple-status-icon warning">!</div><span class="eyebrow">Already connected</span><h2>${esc(user.name||user.email)}</h2><p>${pending?'This person already requested access. Review the request instead of creating another invitation.':'This person already has active workplace access.'}</p><div class="actions apple-dialog-actions"><button type="button" onclick="closeModal()">Close</button><button class="primary" type="button" onclick="closeModal();go('credentials')">Open Team Access</button></div></div>`);
  }
  function ensureLatestShape(remote){
    const cloned=Core.safeClone(remote)||{};
    return typeof migrateState==='function'?migrateState(cloned):cloned;
  }

  async function createInvitationAtomic(raw){
    if(!initFirebase()||!firebaseDb)throw appError('firebase-unavailable','Firebase is not connected. Refresh the published website and retry.');
    const auth=authUser();
    if(!auth)throw appError('unauthenticated','Sign in again before adding a team member.');
    if(auth.emailVerified===false)throw appError('email-unverified','Verify the owner or manager email before inviting team members.');
    const token=randomHex(32);const hash=await sha256(token);const createdAt=isoNow();const expiresAt=new Date(Date.now()+7*86400000).toISOString();
    const ref=firebaseDb.collection('apps').doc(FIREBASE_DOC_PATH);
    let committed=null,last=null;
    for(let outer=0;outer<4;outer++){
      try{
        if(outer===1&&auth.getIdToken)await auth.getIdToken(true).catch(()=>{});
        committed=await firebaseDb.runTransaction(async tx=>{
          const snap=await tx.get(ref);
          if(!snap.exists||!snap.data()?.state)throw appError('workspace-not-found','The workplace cloud record was not found. Refresh and sign in again.');
          const remote=ensureLatestShape(snap.data().state);
          const manager=activeManager(remote,auth);
          if(!manager||!['owner','manager'].includes(manager.role))throw appError('permission-denied','Owner or manager access is required.');
          if(!['active','pending_verification'].includes(manager.status))throw appError('permission-denied','This owner or manager account is paused.');
          const business=(remote.businesses||[]).find(b=>b.id===manager.businessId);
          if(!business)throw appError('business-not-found','The signed-in workplace could not be found.');
          const applied=Core.applyInvitation(remote,raw,{
            businessId:manager.businessId,inviterId:manager.id,inviterName:manager.name,inviterEmail:auth.email,
            inviterRole:manager.role,tokenHash:hash,now:createdAt,expiresAt,today:isoDate(new Date()),id:uid,ref:refId,targetBytes:880000
          });
          const bytes=Core.byteSize(applied.state);
          if(bytes>MAX_CLOUD_BYTES)throw appError('workspace-size','The workspace cloud file is too large after safe log cleanup.');
          const revision=Number(snap.data().revision||0)+1;
          tx.set(ref,{state:applied.state,updatedAt:createdAt,updatedBy:auth.uid,revision,compatibilityVersion:VERSION},{merge:true});
          return {...applied,result:{...applied.result,token,tokenHash:hash,businessId:manager.businessId,createdAt},revision};
        });
        break;
      }catch(error){last=error;if(['invalid-name','invalid-email','invalid-date','self-invite','manager-role-denied','already-active','join-pending','duplicate-status','permission-denied','workspace-size','public-url-missing'].includes(String(error?.code||'')))throw error;await new Promise(r=>setTimeout(r,220*(outer+1)));}
    }
    if(!committed)throw mapError(last);
    committed.result.recipientProof=await sha256(`${committed.result.token}|${Core.normalizeEmail(committed.result.email)}`);
    cloudRevision=committed.revision||cloudRevision;
    state=ensureLatestShape(committed.state);
    try{localStorage.setItem(APP_KEY,JSON.stringify(state));}catch(_e){}
    await savePublicSummary(committed.result).catch(error=>{lastPublicInviteError=String(error?.message||error);console.warn('Public invitation summary was not saved',error);});
    const replaced=Array.isArray(committed.result.revokedTokenHashes)?committed.result.revokedTokenHashes:[];
    await Promise.all(replaced.map(oldHash=>updatePublicStatus(oldHash,'revoked',{updatedAt:createdAt,replacedBy:hash}).catch(error=>console.warn('Old invitation preview was not revoked',error))));
    return committed.result;
  }

  async function savePublicSummary(result){
    if(!firebaseDb)return false;
    const summary=Core.publicSummary(result);
    summary.businessId=result.businessId;summary.createdAt=result.createdAt;summary.tokenHash=result.tokenHash;summary.inviterUid=authUser()?.uid||'';
    await firebaseDb.collection(PUBLIC_INVITES).doc(result.tokenHash).set(summary,{merge:false});
    return true;
  }
  async function updatePublicStatus(hash,status,extra={}){
    if(!firebaseDb||!hash)return;
    await firebaseDb.collection(PUBLIC_INVITES).doc(hash).set({status,...extra},{merge:true});
  }
  async function getInvitation(raw){
    const token=String(raw?.token||'');if(token.length<40)throw appError('invalid-argument','Invitation link is invalid.');
    const hash=await sha256(token);
    try{
      if(initFirebase()&&firebaseDb){
        const snap=await firebaseDb.collection(PUBLIC_INVITES).doc(hash).get();
        if(snap.exists){const d=snap.data()||{};const expired=d.expiresAt&&new Date(d.expiresAt).getTime()<Date.now();return {...d,ok:true,status:expired&&d.status==='pending'?'expired':d.status};}
      }
    }catch(error){console.warn('Public invitation lookup fallback',error);}
    if(originalCompat)return originalCompat('getInvitation',{token});
    return {ok:true,status:'pending',name:'Team member',role:'employee',emailMasked:'your invited email',invitedByName:'your workplace'};
  }
  async function acceptInvitationAtomic(raw){
    const token=String(raw?.token||'');if(token.length<40)throw appError('invalid-argument','Invitation link is invalid.');
    if(!initFirebase()||!firebaseDb)throw appError('firebase-unavailable','Firebase is not connected.');
    const auth=authUser();if(!auth||!auth.emailVerified)throw appError('failed-precondition','Verify your email before accepting the invitation.');
    const hash=await sha256(token);const ref=firebaseDb.collection('apps').doc(FIREBASE_DOC_PATH);const acceptedAt=isoNow();let result;
    try{
      result=await firebaseDb.runTransaction(async tx=>{
        const snap=await tx.get(ref);if(!snap.exists||!snap.data()?.state)throw appError('workspace-not-found','The workplace record was not found.');
        const remote=ensureLatestShape(snap.data().state);const email=Core.normalizeEmail(auth.email||'');
        const invite=(remote.accessInvitations||[]).find(i=>(i.id===hash||i.tokenHash===hash)&&i.status==='pending');
        if(!invite)throw appError('not-found','This invitation is no longer pending. Ask the owner or manager to resend it.');
        if(invite.expiresAt&&new Date(invite.expiresAt).getTime()<Date.now())throw appError('invitation-expired','This invitation has expired. Ask the owner or manager to resend it.');
        if(Core.normalizeEmail(invite.email)!==email)throw appError('permission-denied','Sign in with the same email address that received the invitation.');
        // The same verified identity may accept memberships in multiple businesses.
        // Access remains isolated by businessId and the active membership switcher.
        const profile=(remote.users||[]).find(u=>u.id===invite.userId);if(!profile)throw appError('not-found','The invited team profile was not found.');
        Object.assign(profile,{authUid:auth.uid,emailVerified:true,status:'active',acceptedAt,linkedAt:acceptedAt,accountSource:'manager_invite',activeInvitationId:'',updatedAt:acceptedAt});
        invite.status='accepted';invite.acceptedAt=acceptedAt;invite.acceptedByUid=auth.uid;
        (remote.notifications||[]).forEach(n=>{if(n.userId===profile.id&&n.actionKind==='accept_invitation'){n.requiresAction=false;n.actionStatus='resolved';n.resolvedAt=acceptedAt;n.read=true;}});
        (remote.users||[]).filter(u=>u.businessId===profile.businessId&&['owner','manager'].includes(u.role)&&u.status==='active').forEach(m=>remote.notifications.push({id:uid(),refId:refId(),businessId:profile.businessId,userId:m.id,toUserId:m.id,type:'invite_accepted',subject:'Invitation accepted',originalSubject:'Invitation accepted',message:`${profile.name} accepted the workplace invitation.`,originalMessage:`${profile.name} accepted the workplace invitation.`,read:false,createdAt:acceptedAt,targetView:'credentials',entityId:profile.id,requiresAction:false,actionStatus:'informational',actionKind:''}));
        const clean=Core.compactState(remote,880000);const revision=Number(snap.data().revision||0)+1;
        tx.set(ref,{state:clean,updatedAt:acceptedAt,updatedBy:auth.uid,revision,compatibilityVersion:VERSION},{merge:true});
        return {ok:true,businessId:profile.businessId,userId:profile.id,role:profile.role,state:clean,revision};
      });
    }catch(error){throw mapError(error);}
    state=ensureLatestShape(result.state);cloudRevision=result.revision||cloudRevision;
    updatePublicStatus(hash,'accepted',{acceptedAt}).catch(console.warn);
    return result;
  }

  async function sendInvitationEmail(result,link){
    const cfg={...(state?.emailConfig||{})};
    if(cfg.enabled===false)return {status:'paused',message:'Email notifications are paused. Share the link manually.'};
    if(typeof window.sendEmail!=='function')return {status:'not_configured',message:'Invitation saved, but the email gateway is not loaded. Upload every v145 website file.'};
    const message=`Hi ${result.name}, ${result.invitedByName||'your manager'} invited you to ${result.businessName} as ${result.role}. Use this invited email: ${result.email}. Open the link before ${dateTime(result.expiresAt)}. New users will create a strong private password; existing users will sign in with their current password. No temporary password is required: ${link}`;
    const html=buildHtmlEmail({type:'invite',toName:result.name,subject:'MySchedule workplace invitation',message,businessName:result.businessName,loginUrl:link});
    try{
      const response=await window.sendEmail({
        noteId:result.noteId||'',businessId:result.businessId,to_email:result.email,to_name:result.name,
        subject:'MySchedule workplace invitation',message,business_name:result.businessName,
        recipientSource:'invitation',templateType:'invitation',html_message:compactEmailHtml(html)
      });
      if(response?.ok)return {status:'sent',message:`Invitation email sent to ${result.email}.`,messageId:response.messageId||''};
      return {status:'failed',message:`Invitation was created, but email delivery failed: ${response?.error||'Email gateway rejected the request.'}`};
    }catch(error){return {status:'failed',message:`Invitation was created, but email delivery failed: ${String(error?.message||error)}`};}
  }
  async function updateDelivery(noteId,delivery){
    if(!noteId||!firebaseDb||!authUser())return;
    const ref=firebaseDb.collection('apps').doc(FIREBASE_DOC_PATH);const stamp=isoNow();
    try{await firebaseDb.runTransaction(async tx=>{const snap=await tx.get(ref);if(!snap.exists||!snap.data()?.state)return;const remote=ensureLatestShape(snap.data().state);const note=(remote.notifications||[]).find(n=>n.id===noteId);if(!note)return;note.emailStatus=delivery.status;note.emailDetail=Core.cleanText(delivery.message,300);note.emailUpdatedAt=stamp;const revision=Number(snap.data().revision||0)+1;tx.set(ref,{state:Core.compactState(remote),updatedAt:stamp,updatedBy:authUser().uid,revision},{merge:true});});}catch(error){console.warn('Invitation delivery status was not synced',error);}
  }
  function deliveryBadge(delivery){
    if(delivery.status==='sent')return '<span class="v137-delivery good">Email sent</span>';
    if(delivery.status==='paused'||delivery.status==='not_configured')return '<span class="v137-delivery warn">Share link manually</span>';
    return '<span class="v137-delivery bad">Email not delivered</span>';
  }
  function successDialog(result,link,delivery){
    const publicWarning=lastPublicInviteError?'<p class="v137-small-warning">The link remains valid after sign-in, but its preview may be limited until the included Firestore rules are deployed.</p>':'';
    modal(`<div class="apple-status-dialog v137-invite-result"><div class="apple-status-icon">✓</div><span class="eyebrow">Invitation created</span><h2>${esc(result.name)}</h2>${deliveryBadge(delivery)}<p>${esc(delivery.message)}</p><p class="v138-setup-note">The recipient will create a private password or sign in with an existing account. No temporary password is issued.</p><div class="credential-card"><div class="cred-row"><span>Email</span><strong>${esc(result.email)}</strong></div><div class="cred-row"><span>Role</span><strong>${esc(result.role)}</strong></div><div class="cred-row"><span>Expires</span><strong>${esc(dateTime(result.expiresAt))}</strong></div><div class="cred-row v137-link-row"><span>Invitation link</span><strong class="v133-break-link">${esc(link)}</strong></div></div>${publicWarning}<div class="actions apple-dialog-actions v137-result-actions"><button type="button" onclick="v137CopyInvite('${escAttr(link)}')">Copy link</button><button type="button" onclick="v137ShareInvite('${escAttr(link)}','${escAttr(result.name)}')">Share</button><button class="primary" type="button" onclick="closeModal()">Done</button></div></div>`);
  }

  async function saveUserV137(){
    if(creating)return;
    const b=typeof business==='function'?business():null;
    if(!b||!requireManagerForBusiness(b.id))return;
    let raw=payloadFromForm();
    try{
      const local=currentUser();Core.validateInput(raw,{today:isoDate(new Date()),inviterEmail:authUser()?.email||local?.email,inviterRole:local?.role});
      invitationLink('preview-token','preview-proof');
    }catch(error){return toast(error.message);}
    creating=true;setBusy(true);lastPublicInviteError='';
    try{
      const result=await createInvitationAtomic(raw);const link=invitationLink(result.token,result.recipientProof);
      closeModal();if(typeof renderContent==='function')renderContent();
      const delivery=await sendInvitationEmail(result,link);await updateDelivery(result.noteId,delivery);
      successDialog(result,link,delivery);
    }catch(error){
      const mapped=mapError(error);window.__v137LastError={code:mapped.code,message:mapped.message,stack:String(error?.stack||mapped?.stack||'')};console.error('v137 create invitation failed',mapped);
      if(['already-active','join-pending'].includes(mapped.code))showExisting(mapped);else toast(mapped.message);
    }finally{creating=false;setBusy(false);}
  }

  // Replace only the add-member modal; all other device layouts remain untouched.
  window.openUserModal=function(){
    const u=currentUser();const owner=u?.role==='owner';
    if(!u||!['owner','manager'].includes(u.role))return toast('Owner or manager access is required.');
    modal(`<div class="apple-team-dialog v137-team-dialog"><span class="eyebrow">Team access</span><h2>Add team member</h2><p class="muted">Create one expiring invitation for the exact email address. Email delivery cannot undo the saved invitation.</p><div class="form-grid apple-team-form"><div><label for="u-name">Full name</label><input id="u-name" maxlength="80" autocomplete="name" placeholder="Full name"></div><div><label for="u-email">Email address</label><input id="u-email" maxlength="254" type="email" autocomplete="email" inputmode="email" autocapitalize="none" spellcheck="false" placeholder="employee@email.com"></div><div><label for="u-role">Access level</label><select id="u-role">${owner?'<option value="manager">Manager</option>':''}<option value="employee" selected>Employee</option></select></div><div><label for="u-hire-date">Hire date</label><input id="u-hire-date" type="date" value="${isoDate(new Date())}"></div><div><label for="u-type">Employment type</label><select id="u-type"><option value="casual">Casual</option><option value="part-time">Part-time</option><option value="full-time">Full-time</option></select></div><div><label for="u-duty">Default duty</label><input id="u-duty" maxlength="80" value="Team Member"></div><div><label for="u-weekly">Weekly alert limit</label><input id="u-weekly" type="number" inputmode="numeric" min="0" max="168" value="30"></div><div><label for="u-fortnight">Fortnight alert limit</label><input id="u-fortnight" type="number" inputmode="numeric" min="0" max="336" value="48"></div></div><div class="actions apple-dialog-actions"><button class="ghost" type="button" onclick="closeModal()">Cancel</button><button class="primary" data-v137-add type="button" onclick="saveUser()">Create invitation</button></div></div>`);
  };
  window.saveUser=saveUserV137;
  window.v137CopyInvite=async function(link){try{await navigator.clipboard.writeText(link);toast('Invitation link copied.');}catch(_e){v97CopyField(link,'Invitation link copied.');}};
  window.v137ShareInvite=async function(link,name){try{if(navigator.share){await navigator.share({title:'MySchedule invitation',text:`MySchedule invitation for ${name}`,url:link});}else await window.v137CopyInvite(link);}catch(error){if(error?.name!=='AbortError')await window.v137CopyInvite(link);}};

  // Resend creates a new token and revokes all previous pending links.
  window.resendInvite=async function(userId){
    const user=(state?.users||[]).find(u=>u.id===userId);if(!user)return toast('Team member was not found.');
    const emp=(state.employees||[]).find(e=>e.userId===user.id)||{};
    if(creating)return;creating=true;
    try{
      const result=await createInvitationAtomic({name:user.name,email:user.email,role:user.role,hireDate:user.hireDate||emp.hireDate||isoDate(new Date()),employmentType:emp.employmentType||'casual',roleLabel:emp.roleLabel||'Team Member',weeklyLimit:emp.weeklyLimit??30,fortnightLimit:emp.fortnightLimit??48});
      const link=invitationLink(result.token,result.recipientProof);const delivery=await sendInvitationEmail(result,link);await updateDelivery(result.noteId,delivery);closeModal();renderContent();successDialog(result,link,delivery);
    }catch(error){const mapped=mapError(error);toast(mapped.message);}finally{creating=false;}
  };

  const compat=async function(name,data={}){
    if(name==='createInvitation')return createInvitationAtomic(data);
    if(name==='getInvitation')return getInvitation(data);
    if(name==='acceptInvitation')return acceptInvitationAtomic(data);
    if(originalCompat)return originalCompat(name,data);
    throw appError('unimplemented',`MySchedule action ${name} is unavailable.`);
  };
  window.__v135CompatCall=compat;
  window.MyScheduleInvitationV138={version:VERSION,createInvitationAtomic,getInvitation,acceptInvitationAtomic,sendInvitationEmail,hashToken:sha256,resolveBaseUrl:baseUrl};
  window.MyScheduleInvitationV137=window.MyScheduleInvitationV138;
})();
