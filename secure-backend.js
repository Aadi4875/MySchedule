/* Free Spark storage adapter. Firestore rules enforce authorization; no Functions. */
(function(){
  'use strict';
  let activeBusiness='';
  let loading=false;
  let saving=false;
  let saveChain=Promise.resolve();
  let queuedSaves=0;
  let stopRefresh=null;
  let displayedRevision=0;
  try{localStorage.removeItem(APP_KEY);}catch(_e){}
  const setup=new URL(location.href).searchParams.get('spark-setup')==='1';
  let store=null;
  try{activeBusiness=sessionStorage.getItem('myschedule_secure_business')||'';}catch(_e){}
  function storage(){
    if(store)return store;
    if(!initFirebase()||!firebaseDb||!window.MyScheduleSparkStore)throw new Error('Firebase sign-in and Spark storage files must be configured.');
    store=window.MyScheduleSparkStore.create({db:firebaseDb,user:()=>firebaseAuth?.currentUser,FieldValue:firebase.firestore.FieldValue,Timestamp:firebase.firestore.Timestamp});
    if(activeBusiness)store.select(activeBusiness);return store;
  }
  function select(id){if(!id)return;activeBusiness=id;try{sessionStorage.setItem('myschedule_secure_business',id);}catch(_e){}}
  async function call(action,payload={}){
    const result=await storage().call(action,{businessId:activeBusiness||undefined,...payload});
    if(!result?.ok)throw new Error('The Spark storage did not complete this operation.');
    if(result.businessId)select(result.businessId);
    if(result.revision!==undefined)cloudRevision=Number(result.revision);
    return result;
  }
  async function chooseBusiness(){
    if(!firebaseAuth?.currentUser?.emailVerified)return '';
    const result=await call('listWorkspaces');
    if(activeBusiness&&result.workspaces.some(w=>w.businessId===activeBusiness))return activeBusiness;
    if(result.workspaces.length===1){select(result.workspaces[0].businessId);return activeBusiness;}
    if(!result.workspaces.length)return '';
    // Multi-business users explicitly choose their membership, never an arbitrary match.
    return new Promise(resolve=>{
      const dialog=document.createElement('dialog');dialog.className='auth-action-dialog';
      const title=document.createElement('h2');title.textContent='Choose your workplace';dialog.appendChild(title);
      for(const workplace of result.workspaces){const button=document.createElement('button');button.textContent=workplace.businessName;button.type='button';button.onclick=()=>{select(workplace.businessId);dialog.remove();resolve(workplace.businessId);};dialog.appendChild(button);}
      dialog.addEventListener('cancel',event=>{event.preventDefault();dialog.remove();resolve('');});document.body.appendChild(dialog);if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');
    });
  }
  function incoming(snapshot){
    const result=JSON.parse(JSON.stringify(snapshot));
    for(const row of result.noticeReads||[]){row.businessId=row.businessId||activeBusiness;row.id=row.id||row.noticeId+':'+row.userId;}
    return result;
  }
  function apply(result){if(result.state){state=migrateState(result.state);cloudRevision=Number(result.revision||0);displayedRevision=cloudRevision;}return result;}
  window.MyScheduleSecureBackend={call,apply,select,enabled:true};
  window.__v135CompatCall=async function(action,payload={}){return call(action,payload);};
  loadFirebaseState=async function(){
    if(!firebaseAuth?.currentUser?.emailVerified)return null;
    if(!await chooseBusiness())throw new Error('No workplace is linked to this login. Open your workplace invitation, or create your business account.');
    return (await call('loadWorkspaceState')).state;
  };
  loadState=async function(){
    // Invitations take priority over any remembered owner session on this device.
    try{if(sessionStorage.getItem('myschedule_v133_invite_token')||localStorage.getItem('myschedule_v133_invite_token')){clearCurrentSession();return migrateState(defaultState());}}catch(_e){}
    // Restore only this tab's existing session from the server, never old browser data.
    if(firebaseAuth?.currentUser?.emailVerified&&currentUserId){
      try{return migrateState(await loadFirebaseState());}catch(error){clearCurrentSession();toast(error.message);}
    }
    return migrateState(defaultState());
  };
  saveFirebaseState=function(snapshot){
    if(!firebaseAuth?.currentUser?.emailVerified||!activeBusiness)return Promise.resolve(false);
    const toSave=incoming(snapshot||state);const businessAtSave=activeBusiness;
    queuedSaves++;saving=true;
    saveChain=saveChain.then(async()=>{
      try{
        if(activeBusiness!==businessAtSave)throw new Error('Workplace changed before saving. Reload and retry.');
        const result=await call('saveWorkspaceState',{businessId:businessAtSave,state:toSave,expectedRevision:cloudRevision});
        cloudRevision=Number(result.revision);displayedRevision=cloudRevision;return true;
      }catch(error){toast(error.message||'Changes were not saved. Reload the workplace and retry.');return false;}
      finally{queuedSaves--;saving=queuedSaves>0;}
    });
    return saveChain;
  };
  startFirebaseLiveUpdates=function(){
    if(stopRefresh||!activeBusiness)return;
    stopRefresh=storage().listen(async value=>{
      if(loading||saving||!currentUser()||document.hidden||value<=cloudRevision)return;
      loading=true;try{apply(await call('loadWorkspaceState'));render();}catch(error){console.warn('Workplace update paused',error.code||'unavailable');}finally{loading=false;}
    },error=>{if(error.code==='permission-denied'){clearCurrentSession();state=migrateState(defaultState());render();toast('Your workplace access has ended. Contact the owner.');}});firebaseLiveUnsubscribe=()=>{stopRefresh?.();stopRefresh=null;};
  };
  const previousNotify=notifyUser;
  notifyUser=function(userId,type,subject,message,options={}){
    const from=currentUser();
    if(from?.role==='employee'){
      const target=state.users.find(p=>p.id===userId&&p.businessId===from.businessId&&['owner','manager'].includes(p.role)&&p.status==='active');
      if(!target)return;
      state.notifications.push({id:uuid(),businessId:from.businessId,userId:target.id,toUserId:target.id,type:'employee_update',subject:'Employee update',message:String(message||''),createdByUserId:from.id,read:false,createdAt:now(),requiresAction:false,actionStatus:'informational',targetView:'requests'});
      saveState();return;
    }
    return previousNotify(userId,type,subject,message,options);
  };
  window.removeUser=removeUser=async function(userId){
    if(!confirm('Remove this member’s workplace access?'))return;
    try{apply(await call('removeMember',{userId}));renderContent();toast('Workplace access removed.');}catch(error){toast(error.message);}
  };
  cloudStatusBadge=function(){return '<span class="badge good">Business-protected Spark storage</span>';};
  // Bootstrap is an administrator-only maintenance action, outside ordinary signup.
  if(setup){
    window.initializeSecureBackend=async function(){
      try{
        const auth=requireAuth();
        if(!auth.currentUser){await auth.signInWithEmailAndPassword(normalizeEmail(el('login-email')?.value),String(el('login-password')?.value||''));}
        await auth.currentUser.reload();await auth.currentUser.getIdToken(true);
        const preview=await call('inspectLegacyWorkspaces');
        if(preview.initialized)return toast('The Spark storage is already initialized. Sign in normally.');
        const names=preview.workspaces.map(w=>w.name).join(', ');
        if(!preview.workspaces.length)return toast('No owned legacy workplace was found. Use Business signup for a new workplace.');
        if(!confirm('Migrate your existing workplace to Spark storage: '+(names||'a new empty project')+'? The old snapshot will remain read-only. Other existing members will need a new invitation.'))return;
        await call('initializeBackend',{businessIds:preview.workspaces.map(w=>w.businessId)});
        history.replaceState(null,'',location.pathname);toast('Spark migration finished. Send new invitations to existing employees, then sign in.');
      }catch(error){toast(error.message||'Initialization failed.');}
    };
    const observer=new MutationObserver(()=>{
      const panel=document.querySelector('.landing-auth-card');
      if(!panel||panel.querySelector('#secure-setup-button'))return;
      const button=document.createElement('button');button.id='secure-setup-button';button.type='button';button.textContent='Owner: migrate existing workplace';button.onclick=window.initializeSecureBackend;panel.appendChild(button);
    });observer.observe(document.documentElement,{childList:true,subtree:true});
  }
  window.__MYSCHEDULE_RESOLVE_SECURE?.();
})();
