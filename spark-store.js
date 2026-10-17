/* Spark-compatible Firestore storage. Authorization lives in firestore.rules. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;if(root)root.MyScheduleSparkStore=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const TABLES=['employees','branches','availability','shifts','requests','timesheets','notifications','notificationHistory','notices','noticeReads'];
  const normalized=value=>value&&typeof value.toDate==='function'?value.toDate().toISOString():Array.isArray(value)?value.map(normalized):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,normalized(v)])):value;
  const copy=value=>JSON.parse(JSON.stringify(value));
  const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
  function error(message){throw new Error(message);}
  function create({db,user,FieldValue,Timestamp,crypto:secureCrypto=globalThis.crypto}){
    let selected='',baseline=null,revision=0;
    const auth=()=>{const u=user();if(!u)error('Sign in first.');return u;};
    const verified=()=>{const u=auth();if(!u.emailVerified)error('Verify your email first.');return u;};
    const uid=()=>{const bytes=new Uint8Array(16);secureCrypto.getRandomValues(bytes);return Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');};
    const hash=async value=>Array.from(new Uint8Array(await secureCrypto.subtle.digest('SHA-256',new TextEncoder().encode(value))),b=>b.toString(16).padStart(2,'0')).join('');
    const email=x=>String(x||'').trim().toLowerCase();
    const workplace=b=>db.collection('workplaces').doc(b||selected);
    const ref=(table,id,b)=>workplace(b).collection(table).doc(id);
    const index=(b,u=auth().uid)=>db.collection('accountWorkplaces').doc(u).collection('items').doc(b);
    const data=s=>s.exists?normalized(s.data()):null;
    const rows=async query=>(await query.get()).docs.map(s=>normalized(s.data()));
    function clean(row){const result=copy(row);for(const key of ['password','localPassword','tempPassword','forcePasswordChange'])delete result[key];return result;}
    function directory(p){return {id:p.id,businessId:p.businessId,name:p.name||'',role:p.role,status:p.status,branchIds:p.branchIds||[]};}
    function bump(writer,b=selected){writer.update(ref('sync','revision',b),{value:FieldValue.increment(1)});}
    async function membership(b=selected){verified();const m=data(await ref('members',auth().uid,b).get());if(!m||m.status!=='active')error('Your workplace access is not active. Use a new invitation.');return m;}
    async function listWorkspaces(){verified();const locators=await rows(db.collection('accountWorkplaces').doc(auth().uid).collection('items'));const result=[];for(const locator of locators){const m=data(await ref('members',auth().uid,locator.businessId).get());if(m?.status==='active')result.push({...locator,userId:m.profileId,role:m.role});}return {ok:true,workspaces:result};}
    async function createWorkspace(input,options={}){
      const u=auth();const businessId=options.businessId||uid(),profileId=options.profileId||uid();
      const name=String(input.name||u.displayName||'').trim().slice(0,80),businessName=String(input.businessName||'').trim().slice(0,100);
      if(name.length<2||!businessName)error('Enter your name and business name.');
      const business={...clean(options.business||{}),id:businessId,name:businessName,industry:input.industry||'Other',country:input.country||'Australia',timezone:input.timezone||'Australia/Perth',createdByOwnerId:profileId,businessCode:options.business?.businessCode||'BUS-'+uid().slice(0,10).toUpperCase(),storeCode:options.business?.storeCode||'STORE-'+uid().slice(0,10).toUpperCase()};
      const p={id:profileId,businessId,name,email:email(u.email),authUid:u.uid,role:'owner',status:'pending_verification',emailVerified:false,accountSource:'workspace_creator',notifyEmail:true,notifyInApp:true};
      const batch=db.batch();batch.set(workplace(businessId),{ownerUid:u.uid,ownerProfileId:profileId,business,migrationComplete:options.migration!==true});
      batch.set(ref('members',u.uid,businessId),{uid:u.uid,businessId,profileId,email:p.email,role:'owner',status:'active',inviteHash:''});
      batch.set(ref('profiles',profileId,businessId),p);batch.set(ref('directory',profileId,businessId),directory(p));batch.set(ref('sync','revision',businessId),{value:0});
      batch.set(index(businessId),{businessId,businessName,profileId,role:'owner'});await batch.commit();selected=businessId;return {ok:true,businessId,userId:profileId};
    }
    async function load(b=selected,attempt=0){
      selected=b;const u=verified(),m=await membership();const versionBefore=data(await ref('sync','revision').get()).value;const business=data(await workplace().get());
      if(!business.migrationComplete&&business.ownerUid!==u.uid)error('The workplace migration is not complete.');
      let own=data(await ref('profiles',m.profileId).get());if(!own)error('Your workplace profile is missing.');
      if(own.email!==email(u.email)||own.emailVerified!==true||own.status==='pending_verification'&&m.role==='owner'){
        const batch=db.batch();batch.update(ref('profiles',m.profileId),{email:email(u.email),emailVerified:true,status:'active'});
        if(m.email!==email(u.email))batch.update(ref('members',u.uid),{email:email(u.email)});
        if(own.status!=='active')batch.update(ref('directory',m.profileId),{status:'active'});bump(batch);await batch.commit();return load(b,attempt);
      }
      const managerial=m.role!=='employee';
      const snapshot={businesses:[business.business],users:managerial?await rows(workplace().collection('profiles')):(await rows(workplace().collection('directory'))).map(p=>p.id===own.id?own:{...p,email:''}),accessInvitations:[],joinRequests:[],emailConfig:{enabled:true,mode:'brevo',appUrl:'https://aadi4875.github.io/MySchedule/'}};
      if(!snapshot.users.some(p=>p.id===own.id))snapshot.users.push(own);
      for(const table of TABLES){let query=workplace().collection(table);
        if(!managerial){
          if(table==='employees')query=query.where('userId','==',m.profileId);
          if(['availability','requests','timesheets'].includes(table))query=query.where('employeeId','==',m.profileId);
          if(['notifications','notificationHistory','noticeReads'].includes(table))query=query.where('userId','==',m.profileId);
          if(table==='shifts')query=query.where('status','in',['published','confirmed']);
          if(table==='notices'){
            snapshot[table]=await rows(query.where('audience','in',['all','employee']));
            const targeted=await rows(workplace().collection(table).where('userIds','array-contains',m.profileId));
            snapshot[table]=Array.from(new Map(snapshot[table].concat(targeted).map(r=>[r.id,r])).values());continue;
          }
        }
        snapshot[table]=await rows(query);
      }
      if(managerial)snapshot.accessInvitations=await rows(workplace().collection('invitations'));
      revision=data(await ref('sync','revision').get()).value;if(revision!==versionBefore){if(attempt<2)return load(b,attempt+1);error('The workplace is changing. Try loading again.');}baseline=copy(snapshot);
      return {ok:true,businessId:selected,userId:m.profileId,role:m.role,revision,state:snapshot};
    }
    function changed(before,after){const delta={};for(const key of new Set([...Object.keys(before),...Object.keys(after)]))if(!same(before[key],after[key]))delta[key]=Object.hasOwn(after,key)?after[key]:FieldValue.delete();return delta;}
    async function save(input,expectedRevision){
      const m=await membership();if(!baseline)error('Reload your workplace before saving.');const state=clean(input),plans=[];
      if(!same(state.businesses?.[0],baseline.businesses[0])){
        if(m.role!=='owner')error('Only the owner can change business settings.');plans.push({ref:workplace(),delta:{business:state.businesses[0]}});
      }
      for(const p of state.users||[]){if(m.role==='employee'&&p.id!==m.profileId)continue;const old=baseline.users.find(u=>u.id===p.id);if(!old)error('Use an invitation to add a team member.');
        const d=changed(old,clean(p));if(Object.keys(d).length){plans.push({ref:ref('profiles',p.id),delta:d});const dir=changed(directory(old),directory(p));if(Object.keys(dir).length)plans.push({ref:ref('directory',p.id),delta:dir});}
      }
      for(const table of TABLES){if(m.role==='employee'&&['branches','employees','notices'].includes(table))continue;
        const before=new Map((baseline[table]||[]).map(r=>[r.id,r]));const incoming=new Map((state[table]||[]).map(raw=>{const r=clean(raw);r.businessId=r.businessId||selected;r.id=r.id||r.noticeId+':'+r.userId;
          if(table==='notifications'&&m.role==='employee'&&!before.has(r.id)){r.createdByUserId=m.profileId;r.type='employee_update';r.subject='Employee update';r.requiresAction=false;r.actionStatus='informational';}return [r.id,r];}));
        for(const [id,r]of incoming){const old=before.get(id);if(old){const d=changed(old,r);if(Object.keys(d).length)plans.push({ref:ref(table,id),delta:d});}else plans.push({ref:ref(table,id),create:r});}
        if(m.role!=='employee')for(const [id]of before)if(!incoming.has(id))plans.push({ref:ref(table,id),remove:true});
      }
      if(!plans.length)return {ok:true,businessId:selected,revision};
      if(plans.length>150)error('Too many changes at once. Save a smaller group.');
      await db.runTransaction(async tx=>{const sync=await tx.get(ref('sync','revision'));if(sync.data().value!==expectedRevision)error('The workplace changed. Reload before saving again.');for(const p of plans){if(p.remove)tx.delete(p.ref);else if(p.create)tx.set(p.ref,p.create);else tx.update(p.ref,p.delta);}bump(tx);});
      revision=expectedRevision+1;baseline=copy(state);return {ok:true,businessId:selected,revision};
    }
    async function createInvitation(input){
      const m=await membership();if(m.role==='employee'||input.role==='manager'&&m.role!=='owner')error('You do not have permission to invite this role.');
      const target=email(input.email),name=String(input.name||'').trim().slice(0,80);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(target)||name.length<2||target===email(auth().email))error('Enter a team member’s name and valid email.');
      const matches=await rows(workplace().collection('profiles').where('email','==',target));if(matches.length>1)error('Duplicate profiles need owner review.');const existing=matches[0];if(existing&&['active','pending_verification'].includes(existing.status))error('This person already has active workplace access.');
      const profileId=existing?.id||uid(),token=uid()+uid(),h=await hash(token),role=input.role==='manager'?'manager':'employee';
      const expires=Timestamp.fromMillis(Date.now()+7*86400000-60000),business=data(await workplace().get()),inviter=data(await ref('profiles',m.profileId).get());
      const proof=await hash(token+'|'+target);const profileRef=ref('profiles',profileId);
      await db.runTransaction(async tx=>{
        const profileSnap=await tx.get(profileRef),sync=await tx.get(ref('sync','revision'));const old=data(profileSnap);
        if(old&&['active','pending_verification'].includes(old.status))error('This member is already active.');
        let oldInvitation=null;if(old?.activeInvitationId)oldInvitation=await tx.get(ref('invitations',old.activeInvitationId));
        const employeeRef=ref('employees',profileId),employee=await tx.get(employeeRef);
        const p={...(old||{}),id:profileId,businessId:selected,name,email:target,role,status:'invited',activeInvitationId:h,inviteExpiresAt:expires.toDate().toISOString(),invitedByUserId:m.profileId,emailVerified:false,notifyEmail:true,notifyInApp:true};
        if(oldInvitation?.exists&&oldInvitation.data().status==='pending')tx.update(oldInvitation.ref,{status:'revoked',revokedAt:FieldValue.serverTimestamp(),replacedBy:h});
        if(old)tx.update(profileRef,changed(old,p));else tx.set(profileRef,p);tx.set(ref('directory',profileId),directory(p));
        tx.set(ref('invitations',h),{id:h,tokenHash:h,businessId:selected,profileId,userId:profileId,name,email:target,role,status:'pending',createdAt:FieldValue.serverTimestamp(),expiresAt:expires,inviterUid:auth().uid,invitedByUserId:m.profileId,invitedByName:inviter.name});
        tx.set(db.collection('invitePreviews').doc(h),{businessId:selected,businessName:business.business.name,name,role,emailMasked:target.slice(0,2)+'•••'+target.slice(target.indexOf('@')),expiresAt:expires,invitedByName:inviter.name,recipientProof:proof,status:'pending'});
        if(role==='employee'&&!employee.exists)tx.set(employeeRef,{id:profileId,userId:profileId,businessId:selected,hireDate:input.hireDate||new Date().toISOString().slice(0,10),employmentType:input.employmentType||'casual',roleLabel:input.roleLabel||'Team Member',weeklyLimit:Number(input.weeklyLimit)||30,fortnightLimit:Number(input.fortnightLimit)||48,status:'active'});
        if(role==='manager'&&employee.exists)tx.delete(employeeRef);tx.update(sync.ref,{value:sync.data().value+1});
      });
      return {...await load(),token,tokenHash:h,recipientProof:proof,email:target,name,role,userId:profileId,businessName:business.business.name,invitedByName:inviter.name,expiresAt:expires.toDate().toISOString()};
    }
    async function getInvitation({token}){if(!/^[a-f0-9]{64}$/i.test(token||''))error('Invalid invitation link.');const h=await hash(token),p=data(await db.collection('invitePreviews').doc(h).get());if(!p)error('Invitation not found. Ask your manager for a new link.');return {ok:true,...p,status:p.status==='pending'&&Date.parse(p.expiresAt)<Date.now()?'expired':p.status||'pending'};}
    async function acceptInvitation({token}){
      const u=verified(),preview=await getInvitation({token}),b=preview.businessId,h=await hash(token);const iRef=ref('invitations',h,b);
      await db.runTransaction(async tx=>{
        const invitationSnap=await tx.get(iRef);if(!invitationSnap.exists)error('Invitation not found.');const i=invitationSnap.data();
        if(i.status!=='pending'||i.expiresAt.toMillis()<=Date.now())error('This invitation expired, was revoked or has already been used.');if(i.email!==email(u.email))error('Use the email that received this invitation.');
        const pRef=ref('profiles',i.profileId,b),pSnap=await tx.get(pRef),p=pSnap.data();
        if(!p||p.status!=='invited'||p.activeInvitationId!==h||p.authUid&&p.authUid!==u.uid)error('This invitation no longer matches your account.');
        tx.set(ref('members',u.uid,b),{uid:u.uid,businessId:b,profileId:i.profileId,email:email(u.email),role:i.role,status:'active',inviteHash:h});
        tx.update(pRef,{authUid:u.uid,status:'active',emailVerified:true,activeInvitationId:'',acceptedAt:FieldValue.serverTimestamp(),linkedAt:FieldValue.serverTimestamp(),accountSource:'manager_invite'});
        tx.update(iRef,{status:'accepted',acceptedByUid:u.uid,acceptedAt:FieldValue.serverTimestamp()});tx.update(db.collection('invitePreviews').doc(h),{status:'accepted'});tx.set(ref('directory',i.profileId,b),directory({...normalized(p),status:'active'}));
        tx.set(index(b),{businessId:b,businessName:preview.businessName,profileId:i.profileId,role:i.role});bump(tx,b);
      });selected=b;return load();
    }
    async function revoke({invitationId}){await membership();const batch=db.batch();batch.update(ref('invitations',invitationId),{status:'revoked',revokedAt:FieldValue.serverTimestamp()});batch.update(db.collection('invitePreviews').doc(invitationId),{status:'revoked'});bump(batch);await batch.commit();return load();}
    async function removeMember({userId}){const m=await membership(),p=data(await ref('profiles',userId).get());if(!p||p.role==='owner'||p.id===m.profileId)error('The owner and your own account cannot be removed.');const batch=db.batch();if(p.authUid)batch.update(ref('members',p.authUid),{status:'removed'});batch.update(ref('profiles',userId),{status:'removed',activeInvitationId:''});batch.update(ref('directory',userId),{status:'removed'});for(const i of await rows(workplace().collection('invitations')))if(i.userId===userId&&i.status==='pending')batch.update(ref('invitations',i.id),{status:'revoked',revokedAt:FieldValue.serverTimestamp()});bump(batch);await batch.commit();return load();}
    async function inspectLegacyWorkspaces(){const old=data(await db.collection('apps').doc('myschedule_public_launch').get());const legacy=old?.state||{};return {ok:true,workspaces:(legacy.businesses||[]).filter(b=>(legacy.users||[]).some(p=>p.businessId===b.id&&p.role==='owner'&&email(p.email)===email(verified().email)&&(!p.authUid||p.authUid===auth().uid))).map(b=>({businessId:b.id,name:b.name}))};}
    async function migrateLegacy({businessIds}){
      const u=verified(),legacyRef=db.collection('apps').doc('myschedule_public_launch'),legacy=data(await legacyRef.get())?.state;if(!legacy)error('The frozen legacy snapshot is missing.');
      for(const oldId of businessIds){const oldBusiness=legacy.businesses.find(b=>b.id===oldId),owners=legacy.users.filter(p=>p.businessId===oldId&&p.role==='owner'&&email(p.email)===email(u.email)&&(!p.authUid||p.authUid===u.uid));if(!oldBusiness||owners.length!==1)error('This business needs a manual owner review.');
        const marker=db.collection('sparkMigrations').doc(oldId);let record=data(await marker.get());if(record?.complete)continue;
        if(!record){const bid=uid();await createWorkspace({name:owners[0].name,businessName:oldBusiness.name,country:oldBusiness.country,timezone:oldBusiness.timezone},{businessId:bid,profileId:owners[0].id,business:oldBusiness,migration:true});record={businessId:bid,ownerUid:u.uid,complete:false};await marker.set(record);}selected=record.businessId;
        const entries=[];for(const p0 of legacy.users.filter(p=>p.businessId===oldId&&p.id!==owners[0].id)){const p={...clean(p0),email:email(p0.email),businessId:selected,status:'inactive',emailVerified:false,activeInvitationId:'',role:p0.role==='manager'?'manager':'employee'};delete p.authUid;entries.push({ref:ref('profiles',p.id),value:p},{ref:ref('directory',p.id),value:directory(p)});}
        for(const table of TABLES)for(const r0 of legacy[table]||[]){let sourceBusiness=r0.businessId;if(!sourceBusiness&&r0.userId)sourceBusiness=legacy.users.find(p=>p.id===r0.userId)?.businessId;if(sourceBusiness!==oldId)continue;const r={...clean(r0),businessId:selected};r.id=r.id||r.noticeId+':'+r.userId;entries.push({ref:ref(table,r.id),value:r});}
        for(let offset=0;offset<entries.length;offset+=100){const batch=db.batch();for(const e of entries.slice(offset,offset+100))batch.set(e.ref,e.value);await batch.commit();}
        const batch=db.batch();batch.update(workplace(),{migrationComplete:true});batch.update(marker,{complete:true});bump(batch);await batch.commit();
      }return {ok:true,membersRequireReinvitation:true};
    }
    async function call(action,input={}){if(input.businessId)selected=input.businessId;
      if(action==='listWorkspaces')return listWorkspaces();if(action==='createWorkspace')return createWorkspace(input);if(action==='getInvitation')return getInvitation(input);if(action==='acceptInvitation')return acceptInvitation(input);
      if(['loadWorkspaceState','repairMyAccess','recordVerifiedLogin','getAccessStatus'].includes(action))return load();if(action==='saveWorkspaceState')return save(input.state,input.expectedRevision);
      if(action==='createInvitation')return createInvitation(input);if(action==='revokeInvitation')return revoke(input);if(action==='removeMember')return removeMember(input);if(action==='inspectLegacyWorkspaces')return inspectLegacyWorkspaces();if(action==='initializeBackend')return migrateLegacy(input);
      error('Use a workplace invitation. This operation is unavailable.');
    }
    return {call,select:b=>{selected=b;},listen:(callback,onError)=>ref('sync','revision').onSnapshot(s=>{if(s.exists)callback(s.data().value);},onError)};
  }
  return {create,normalized,TABLES};
});
