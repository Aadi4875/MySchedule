/* MySchedule v138 — end-to-end invitation account setup.
   Invitation link -> exact-email proof -> create strong private password OR sign in
   -> email verification -> one-time invitation acceptance -> workplace entry. */
(function(){
  'use strict';

  const TOKEN_KEY='myschedule_v133_invite_token';
  const PROOF_KEY='myschedule_v138_recipient_proof';
  const EMAIL_KEY='myschedule_v138_invited_email';
  const PENDING_KEY='myschedule_v133_pending_access';
  const COMMON_PASSWORDS=new Set([
    'password','password1','password123','qwerty123','letmein123','welcome123',
    'admin123','myschedule','myschedule123','123456789012','iloveyou123'
  ]);
  const flow={token:'',proof:'',summary:null,email:'',busy:false,initialized:false,lastVerificationSentAt:0};

  const originalLoginView=typeof window.loginView==='function'?window.loginView:null;
  const originalLogout=typeof window.logout==='function'?window.logout:null;

  function storageGet(key){
    try{return sessionStorage.getItem(key)||localStorage.getItem(key)||'';}catch(_e){return '';}
  }
  function storageSet(key,value){
    try{if(value){sessionStorage.setItem(key,value);localStorage.setItem(key,value);}else{sessionStorage.removeItem(key);localStorage.removeItem(key);}}catch(_e){}
  }
  function captureLink(){
    try{
      const url=new URL(window.location.href);
      const token=url.searchParams.get('invite');
      const proof=url.searchParams.get('recipient');
      if(token&&token.length>30)storageSet(TOKEN_KEY,token);
      if(proof&&/^[a-f0-9]{64}$/i.test(proof))storageSet(PROOF_KEY,proof.toLowerCase());
      if(token||proof||url.searchParams.has('setup')){
        url.searchParams.delete('invite');url.searchParams.delete('recipient');url.searchParams.delete('setup');
        history.replaceState(null,'',url.pathname+(url.search?url.search:'')+(url.hash||''));
      }
    }catch(_e){}
    flow.token=String(window.__MYSCHEDULE_TEST_INVITE_TOKEN||storageGet(TOKEN_KEY));
    flow.proof=String(window.__MYSCHEDULE_TEST_RECIPIENT_PROOF||storageGet(PROOF_KEY)).toLowerCase();
    flow.email=storageGet(EMAIL_KEY);
  }
  captureLink();

  function hasInvite(){return flow.token.length>30;}
  function h(value){
    return String(value==null?'':value).replace(/[&<>'"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch]));
  }
  function normalizeEmail(value){
    if(window.MyScheduleInviteCore?.normalizeEmail)return window.MyScheduleInviteCore.normalizeEmail(value);
    return String(value||'').trim().toLowerCase();
  }
  function validEmail(value){return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(normalizeEmail(value));}
  function constantEqual(a,b){
    a=String(a||'').toLowerCase();b=String(b||'').toLowerCase();
    if(a.length!==b.length)return false;
    let diff=0;for(let i=0;i<a.length;i++)diff|=a.charCodeAt(i)^b.charCodeAt(i);return diff===0;
  }
  async function hash(value){
    const api=window.MyScheduleInvitationV138||window.MyScheduleInvitationV137;
    if(!api?.hashToken)throw new Error('Secure invitation tools did not load. Refresh the page.');
    return api.hashToken(String(value||''));
  }
  async function recipientProof(email){return hash(`${flow.token}|${normalizeEmail(email)}`);}
  function expectedProof(){return String(flow.proof||flow.summary?.recipientProof||'').toLowerCase();}
  async function emailMatchesInvite(email){
    const expected=expectedProof();
    if(!/^[a-f0-9]{64}$/.test(expected))return false;
    return constantEqual(await recipientProof(email),expected);
  }
  function inviteUrl(extra={}){
    const api=window.MyScheduleInvitationV138||window.MyScheduleInvitationV137;
    let base='';
    try{base=api?.resolveBaseUrl?.()||window.location.href;}catch(_e){base=window.location.href;}
    const url=new URL(base,window.location.href);url.search='';url.hash='';
    url.searchParams.set('invite',flow.token);
    const proof=expectedProof();if(proof)url.searchParams.set('recipient',proof);
    url.searchParams.set('setup','1');
    Object.entries(extra).forEach(([key,value])=>{if(value!=null&&value!=='')url.searchParams.set(key,String(value));});
    return url.toString();
  }
  function clearInvite(){
    [TOKEN_KEY,PROOF_KEY,EMAIL_KEY,PENDING_KEY].forEach(key=>storageSet(key,''));
    flow.token='';flow.proof='';flow.email='';flow.summary=null;flow.initialized=false;
  }
  function passwordStatus(password,email,name){
    const p=String(password||'');
    // Practical Firebase password policy requested for every invited account:
    // at least 8 characters with uppercase, lowercase, number and symbol.
    const rules={
      length:p.length>=8&&p.length<=128,
      upper:/[A-Z]/.test(p),
      lower:/[a-z]/.test(p),
      number:/\d/.test(p),
      symbol:/[^A-Za-z0-9\s]/.test(p)
    };
    const passed=Object.values(rules).filter(Boolean).length;
    return {rules,passed,total:Object.keys(rules).length,valid:Object.values(rules).every(Boolean)};
  }

  function invitePage(){
    return `<section class="v138-invite-page" id="v138InviteFlow">
      <div class="v138-invite-shell">
        <aside class="v138-invite-context" aria-label="Invitation details">
          <div class="v138-invite-mark" aria-hidden="true">MS</div>
          <span class="v138-kicker">Private workplace invitation</span>
          <h1 id="v138BusinessName">Join your team</h1>
          <p id="v138InviteDescription">Checking the invitation securely…</p>
          <div class="v138-invite-facts" id="v138InviteFacts" aria-live="polite"></div>
          <ol class="v138-setup-steps" aria-label="Account setup steps">
            <li><span>1</span><div><strong>Confirm your invited email</strong><small>The email is checked without displaying it publicly.</small></div></li>
            <li><span>2</span><div><strong>Create a private password or sign in</strong><small>MySchedule never emails or stores a temporary password.</small></div></li>
            <li><span>3</span><div><strong>Verify and enter the workplace</strong><small>Your one-time invitation is accepted automatically.</small></div></li>
          </ol>
        </aside>
        <main class="v138-setup-card" aria-labelledby="v138SetupTitle">
          <div id="v138SetupStatus" class="v138-status" role="status" aria-live="polite">
            <span class="v138-spinner" aria-hidden="true"></span><strong>Checking invitation</strong><p>Please keep this page open.</p>
          </div>
          <div id="v138SetupBody"></div>
          <div class="v138-privacy-note"><span aria-hidden="true">✓</span><p>Your password is handled only by Firebase Authentication. Owners and managers cannot see it.</p></div>
        </main>
      </div>
    </section>`;
  }

  if(originalLoginView){
    window.loginView=function(){return hasInvite()?invitePage():originalLoginView();};
  }

  function body(){return document.getElementById('v138SetupBody');}
  function statusBox(){return document.getElementById('v138SetupStatus');}
  function setStatus(title,message,type='loading'){
    const box=statusBox();if(!box)return;
    box.className=`v138-status ${type}`;
    box.innerHTML=`${type==='loading'?'<span class="v138-spinner" aria-hidden="true"></span>':`<span class="v138-status-symbol" aria-hidden="true">${type==='success'?'✓':type==='warning'?'!':'×'}</span>`}<strong>${h(title)}</strong><p>${h(message||'')}</p>`;
  }
  function setBusy(busy,label='Please wait…'){
    flow.busy=busy;
    document.querySelectorAll('#v138InviteFlow button,#v138InviteFlow input').forEach(node=>{
      if(node.dataset.keepEnabled==='true')return;
      if(busy){
        if(!Object.prototype.hasOwnProperty.call(node.dataset,'v138WasDisabled'))node.dataset.v138WasDisabled=node.disabled?'1':'0';
        node.disabled=true;
      }else if(Object.prototype.hasOwnProperty.call(node.dataset,'v138WasDisabled')){
        node.disabled=node.dataset.v138WasDisabled==='1';
        delete node.dataset.v138WasDisabled;
      }
    });
    const primary=document.querySelector('#v138InviteFlow [data-v138-primary]');
    if(primary&&busy&&!primary.dataset.originalText){primary.dataset.originalText=primary.textContent;primary.textContent=label;}
    if(primary&&!busy&&primary.dataset.originalText){primary.textContent=primary.dataset.originalText;delete primary.dataset.originalText;}
  }
  function showInline(message,type='error'){
    const host=document.getElementById('v138InlineMessage');if(!host)return;
    host.hidden=!message;host.className=`v138-inline ${type}`;host.textContent=message||'';
  }
  function updateContext(){
    const s=flow.summary||{};
    const title=document.getElementById('v138BusinessName');if(title)title.textContent=s.businessName?`Join ${s.businessName}`:'Join your team';
    const desc=document.getElementById('v138InviteDescription');if(desc)desc.textContent=s.invitedByName?`${s.invitedByName} invited you to use MySchedule.`:'You received a secure MySchedule invitation.';
    const facts=document.getElementById('v138InviteFacts');if(facts){
      const expiry=s.expiresAt&&typeof dateTime==='function'?dateTime(s.expiresAt):s.expiresAt||'Soon';
      facts.innerHTML=`<div><span>Invited as</span><strong>${h(s.role||'Team member')}</strong></div><div><span>Email</span><strong>${h(s.emailMasked||'Your invited email')}</strong></div><div><span>Expires</span><strong>${h(expiry)}</strong></div>`;
    }
  }
  function footerButtons(){
    return `<div class="v138-secondary-actions"><button type="button" class="v138-link-button" data-keep-enabled="true" onclick="v138CancelInviteSetup()">Use a different MySchedule account</button></div>`;
  }
  function showEmailStep(message=''){
    const host=body();if(!host)return;
    setStatus('Invitation ready','Confirm the exact email address that received the invitation.','success');
    host.innerHTML=`<form class="v138-form" onsubmit="v138CheckInviteEmail(event)" novalidate>
      <div class="v138-form-heading"><span class="v138-step-label">Step 1 of 3</span><h2 id="v138SetupTitle">Confirm your invited email</h2><p>Use the email address where this invitation was delivered.</p></div>
      <div id="v138InlineMessage" class="v138-inline ${message?'warning':''}" ${message?'':'hidden'}>${h(message)}</div>
      <label for="v138InviteEmail">Invited email address</label>
      <input id="v138InviteEmail" name="email" type="email" inputmode="email" autocomplete="email" autocapitalize="none" spellcheck="false" maxlength="254" value="${h(flow.email)}" placeholder="name@company.com" required>
      <button class="v138-primary" data-v138-primary type="submit">Continue securely</button>
      ${footerButtons()}
    </form>`;
    setTimeout(()=>document.getElementById('v138InviteEmail')?.focus(),30);
  }
  function showCreateStep(){
    const host=body();if(!host)return;
    setStatus('Email confirmed','Create a private password for your MySchedule account.','success');
    host.innerHTML=`<form class="v138-form" onsubmit="v138CreateInvitedAccount(event)" novalidate>
      <div class="v138-form-heading"><span class="v138-step-label">Step 2 of 3</span><h2 id="v138SetupTitle">Create your private password</h2><p>This password is for <strong>${h(flow.email)}</strong>. It is never shared with your manager.</p></div>
      <div id="v138InlineMessage" class="v138-inline" hidden></div>
      <label for="v138NewPassword">New password</label>
      <div class="v138-password-wrap"><input id="v138NewPassword" type="password" autocomplete="new-password" minlength="8" maxlength="128" oninput="v138UpdatePasswordStrength()" placeholder="At least 8 characters" required><button type="button" class="v138-password-toggle" data-keep-enabled="true" onclick="v138TogglePassword('v138NewPassword',this)" aria-label="Show password">Show</button></div>
      <div class="v138-strength" aria-live="polite"><div class="v138-strength-track"><span id="v138StrengthBar"></span></div><strong id="v138StrengthText">Start typing a password</strong></div>
      <ul class="v138-password-rules" id="v138PasswordRules">
        <li data-rule="length">8–128 characters</li><li data-rule="upper">One uppercase letter</li><li data-rule="lower">One lowercase letter</li><li data-rule="number">One number</li><li data-rule="symbol">One symbol</li>
      </ul>
      <label for="v138ConfirmPassword">Confirm password</label>
      <div class="v138-password-wrap"><input id="v138ConfirmPassword" type="password" autocomplete="new-password" maxlength="128" oninput="v138UpdatePasswordStrength()" placeholder="Enter it again" required><button type="button" class="v138-password-toggle" data-keep-enabled="true" onclick="v138TogglePassword('v138ConfirmPassword',this)" aria-label="Show confirmation password">Show</button></div>
      <button class="v138-primary" data-v138-primary id="v138CreateButton" type="submit" disabled>Create account and verify email</button>
      <button class="v138-secondary" type="button" onclick="v138ShowSignIn()">I already have a MySchedule password</button>
      ${footerButtons()}
    </form>`;
    setTimeout(()=>document.getElementById('v138NewPassword')?.focus(),30);
  }
  function showSignInStep(message=''){
    const host=body();if(!host)return;
    setStatus('Email confirmed','Sign in to accept the workplace invitation.','success');
    host.innerHTML=`<form class="v138-form" onsubmit="v138SignInInvitedAccount(event)" novalidate>
      <div class="v138-form-heading"><span class="v138-step-label">Step 2 of 3</span><h2 id="v138SetupTitle">Sign in to continue</h2><p>Use the existing MySchedule password for <strong>${h(flow.email)}</strong>.</p></div>
      <div id="v138InlineMessage" class="v138-inline ${message?'warning':''}" ${message?'':'hidden'}>${h(message)}</div>
      <label for="v138ExistingPassword">Password</label>
      <div class="v138-password-wrap"><input id="v138ExistingPassword" type="password" autocomplete="current-password" maxlength="128" placeholder="Enter your password" required><button type="button" class="v138-password-toggle" data-keep-enabled="true" onclick="v138TogglePassword('v138ExistingPassword',this)" aria-label="Show password">Show</button></div>
      <button class="v138-primary" data-v138-primary type="submit">Sign in and accept invitation</button>
      <div class="v138-action-row"><button class="v138-link-button" type="button" onclick="v138SendInvitePasswordReset()">Forgot password?</button><button class="v138-link-button" type="button" onclick="v138ShowCreate()">Create a new account</button></div>
      ${footerButtons()}
    </form>`;
    setTimeout(()=>document.getElementById('v138ExistingPassword')?.focus(),30);
  }
  function showVerifyStep(message='Verification email sent. Open it, then return here.'){
    const host=body();if(!host)return;
    setStatus('Verify your email','Your account is created, but workplace access remains locked until verification.','warning');
    host.innerHTML=`<div class="v138-form v138-verify-panel">
      <div class="v138-form-heading"><span class="v138-step-label">Step 3 of 3</span><h2 id="v138SetupTitle">Check your inbox</h2><p>We sent a verification link to <strong>${h(flow.email)}</strong>.</p></div>
      <div id="v138InlineMessage" class="v138-inline success">${h(message)}</div>
      <div class="v138-mail-illustration" aria-hidden="true">✉</div>
      <p class="v138-verify-help">Open the verification email on this device or another device. Then return and continue. Check Spam or Junk if it is not visible.</p>
      <button class="v138-primary" data-v138-primary type="button" onclick="v138FinishVerification()">I verified my email — continue</button>
      <button class="v138-secondary" type="button" onclick="v138ResendVerification()">Resend verification email</button>
      <button class="v138-link-button v138-centered" type="button" onclick="v138ShowSignIn('Already verified on another device? Sign in here to finish setup.')">Sign in after verifying on another device</button>
      ${footerButtons()}
    </div>`;
  }
  function showTerminal(title,message,type='error',actionLabel='Return to sign in'){
    const host=body();if(!host)return;
    setStatus(title,message,type);
    host.innerHTML=`<div class="v138-terminal"><h2 id="v138SetupTitle">${h(title)}</h2><p>${h(message)}</p><button class="v138-primary" type="button" onclick="v138CancelInviteSetup()">${h(actionLabel)}</button></div>`;
  }

  async function loadSummary(){
    if(!hasInvite())return;
    try{
      setStatus('Checking invitation','Confirming that this link is current and unused.','loading');
      const api=window.MyScheduleInvitationV138||window.MyScheduleInvitationV137;
      if(!api?.getInvitation)throw new Error('Invitation tools are unavailable. Refresh the page.');
      flow.summary=await api.getInvitation({token:flow.token});
      if(!flow.proof&&/^[a-f0-9]{64}$/i.test(flow.summary?.recipientProof||'')){
        flow.proof=String(flow.summary.recipientProof).toLowerCase();storageSet(PROOF_KEY,flow.proof);
      }
      updateContext();
      const status=String(flow.summary?.status||'').toLowerCase();
      if(status!=='pending'){
        const messages={accepted:'This invitation has already been accepted.',expired:'This invitation has expired. Ask the owner or manager to resend it.',revoked:'This invitation was revoked. Ask the owner or manager for a new link.'};
        return showTerminal('Invitation unavailable',messages[status]||'This invitation is no longer available.','warning');
      }
      if(!/^[a-f0-9]{64}$/.test(expectedProof())){
        return showTerminal('New invitation required','This link was created before secure password setup was added. Ask the owner or manager to press Resend in Team Access, then use the new email.','warning');
      }
      const auth=window.firebaseAuth||window.firebase?.auth?.();
      const signed=auth?.currentUser;
      if(signed?.email){
        const match=await emailMatchesInvite(signed.email);
        if(!match){
          await auth.signOut().catch(()=>{});
          showEmailStep('A different account was signed in. Confirm the email that received this invitation.');
          return;
        }
        flow.email=normalizeEmail(signed.email);storageSet(EMAIL_KEY,flow.email);
        if(signed.emailVerified)return acceptAndEnter(signed);
        return showVerifyStep('This account still needs email verification.');
      }
      showEmailStep();
    }catch(error){
      console.error('v138 invitation load',error);
      showTerminal('Could not open invitation',friendlyError(error),'error','Try regular sign in');
    }
  }
  function friendlyError(error){
    const code=String(error?.code||'').replace(/^auth\//,'').replace(/^firestore\//,'');
    const raw=String(error?.message||'').replace(/^FirebaseError:\s*/i,'').trim();
    const map={
      'email-already-in-use':'An account already exists for this email. Sign in with its password.',
      'invalid-credential':'The email or password is incorrect.',
      'wrong-password':'The password is incorrect.',
      'too-many-requests':'Too many attempts were made. Wait a few minutes, then retry or reset the password.',
      'network-request-failed':'The internet connection was interrupted. Nothing was duplicated; retry when connected.',
      'weak-password':'Use a stronger password that satisfies every requirement.',
      'user-disabled':'This Firebase account is disabled. Contact the owner or administrator.',
      'user-not-found':'No existing account was found. Create a private password instead.'
    };
    return map[code]||raw||'The request could not be completed.';
  }

  async function acceptAndEnter(authUser){
    const ownsBusy=!flow.busy;
    if(ownsBusy)setBusy(true,'Activating access…');
    try{
      await authUser.reload();
      const user=(window.firebaseAuth||firebase.auth()).currentUser;
      if(!user?.emailVerified){showVerifyStep('Email verification is not complete yet.');return;}
      if(!(await emailMatchesInvite(user.email)))throw new Error('This signed-in email does not match the invitation.');
      const api=window.MyScheduleInvitationV138||window.MyScheduleInvitationV137;
      let accepted=null,last=null;
      for(let attempt=0;attempt<3;attempt++){
        try{accepted=await api.acceptInvitationAtomic({token:flow.token});break;}
        catch(error){last=error;const code=String(error?.code||'');if(!/unavailable|aborted|deadline|network/i.test(code+' '+error?.message))break;await new Promise(r=>setTimeout(r,350*(attempt+1)));}
      }
      if(!accepted)throw last||new Error('The invitation could not be accepted.');
      setStatus('Access activated','Loading your workplace securely…','success');
      storageSet(PENDING_KEY,'');
      const cloud=await loadFirebaseState();
      if(!cloud)throw new Error('Workplace access was activated, but the workspace could not be loaded. Refresh and sign in.');
      state=migrateState(cloud);
      try{startFirebaseLiveUpdates();}catch(_e){}
      clearInvite();
      await finishAuthLogin(user);
    }catch(error){
      console.error('v138 invitation acceptance',error);
      const text=friendlyError(error);
      if(/already accepted|no longer pending|not found/i.test(text)){
        clearInvite();
        try{
          const cloud=await loadFirebaseState();
          if(cloud){state=migrateState(cloud);await finishAuthLogin((firebaseAuth||firebase.auth()).currentUser);return;}
        }catch(_e){}
      }
      showInline(text,'error');
      setStatus('Setup needs attention',text,'error');
    }finally{if(ownsBusy)setBusy(false);}
  }

  window.v138CheckInviteEmail=async function(event){
    event?.preventDefault();if(flow.busy)return;
    const email=normalizeEmail(document.getElementById('v138InviteEmail')?.value||'');
    if(!validEmail(email))return showInline('Enter a complete email address.','error');
    setBusy(true,'Checking email…');showInline('');
    try{
      if(!(await emailMatchesInvite(email)))throw new Error('This email does not match the address that received the invitation.');
      flow.email=email;storageSet(EMAIL_KEY,email);
      const auth=window.firebaseAuth||firebase.auth();
      let methods=[];try{methods=await auth.fetchSignInMethodsForEmail(email);}catch(_e){}
      if(Array.isArray(methods)&&methods.includes('password'))showSignInStep();else showCreateStep();
    }catch(error){showInline(friendlyError(error),'error');}
    finally{setBusy(false);}
  };
  window.v138ShowCreate=showCreateStep;
  window.v138ShowSignIn=showSignInStep;
  window.v138TogglePassword=function(id,button){
    const input=document.getElementById(id);if(!input)return;const show=input.type==='password';input.type=show?'text':'password';button.textContent=show?'Hide':'Show';button.setAttribute('aria-label',show?'Hide password':'Show password');input.focus();
  };
  window.v138UpdatePasswordStrength=function(){
    const p=document.getElementById('v138NewPassword')?.value||'';
    const confirm=document.getElementById('v138ConfirmPassword')?.value||'';
    const result=passwordStatus(p,flow.email,flow.summary?.name||'');
    document.querySelectorAll('#v138PasswordRules [data-rule]').forEach(li=>li.classList.toggle('passed',!!result.rules[li.dataset.rule]));
    const bar=document.getElementById('v138StrengthBar');if(bar){bar.style.width=`${Math.round(result.passed/result.total*100)}%`;bar.dataset.level=String(result.passed);}
    const text=document.getElementById('v138StrengthText');if(text)text.textContent=result.valid?(p===confirm?'Strong password — ready':'Strong password — confirm it'):`${result.passed} of ${result.total} requirements met`;
    const button=document.getElementById('v138CreateButton');if(button)button.disabled=!(result.valid&&p===confirm&&!flow.busy);
  };
  window.v138CreateInvitedAccount=async function(event){
    event?.preventDefault();if(flow.busy)return;
    const password=document.getElementById('v138NewPassword')?.value||'';
    const confirm=document.getElementById('v138ConfirmPassword')?.value||'';
    const strength=passwordStatus(password,flow.email,flow.summary?.name||'');
    if(!strength.valid)return showInline('Complete every password requirement.','error');
    if(password!==confirm)return showInline('The two passwords do not match.','error');
    setBusy(true,'Creating account…');showInline('');
    try{
      if(!(await emailMatchesInvite(flow.email)))throw new Error('The invited email could not be confirmed.');
      const auth=window.firebaseAuth||firebase.auth();
      await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(()=>{});
      const cred=await auth.createUserWithEmailAndPassword(flow.email,password);
      await cred.user.updateProfile({displayName:flow.summary?.name||''}).catch(()=>{});
      storageSet(PENDING_KEY,JSON.stringify({type:'invite',token:flow.token,name:flow.summary?.name||'',email:flow.email,createdAt:new Date().toISOString()}));
      await sendVerification(cred.user,true);
      showVerifyStep();
    }catch(error){
      const code=String(error?.code||'');
      if(code.includes('email-already-in-use'))showSignInStep('An account already exists for this email. Enter its password, or reset it.');
      else showInline(friendlyError(error),'error');
    }finally{setBusy(false);window.v138UpdatePasswordStrength?.();}
  };
  async function sendVerification(user,force=false){
    const now=Date.now();if(!force&&now-flow.lastVerificationSentAt<30000)throw new Error('Wait 30 seconds before requesting another verification email.');
    await user.sendEmailVerification({url:inviteUrl({verified:'1'})});flow.lastVerificationSentAt=now;
  }
  window.v138ResendVerification=async function(){
    if(flow.busy)return;setBusy(true,'Sending…');
    try{
      const user=(window.firebaseAuth||firebase.auth()).currentUser;
      if(!user||normalizeEmail(user.email)!==flow.email){showSignInStep('Sign in first, then resend verification.');return;}
      await sendVerification(user,false);showInline('A new verification email was sent. Check Inbox, Spam and Junk.','success');
    }catch(error){showInline(friendlyError(error),'error');}
    finally{setBusy(false);}
  };
  window.v138FinishVerification=async function(){
    if(flow.busy)return;
    const auth=window.firebaseAuth||firebase.auth();const user=auth.currentUser;
    if(!user)return showSignInStep('Sign in with the password you created to finish setup.');
    setBusy(true,'Checking verification…');
    try{await user.reload();if(!auth.currentUser?.emailVerified)throw new Error('Email is not verified yet. Open the verification link, then try again.');await acceptAndEnter(auth.currentUser);}
    catch(error){showInline(friendlyError(error),'warning');}
    finally{setBusy(false);}
  };
  window.v138SignInInvitedAccount=async function(event){
    event?.preventDefault();if(flow.busy)return;
    const password=document.getElementById('v138ExistingPassword')?.value||'';
    if(!password)return showInline('Enter your password.','error');
    setBusy(true,'Signing in…');showInline('');
    try{
      if(!(await emailMatchesInvite(flow.email)))throw new Error('The invited email could not be confirmed.');
      const auth=window.firebaseAuth||firebase.auth();
      await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(()=>{});
      if(auth.currentUser&&normalizeEmail(auth.currentUser.email)!==flow.email)await auth.signOut();
      const cred=await auth.signInWithEmailAndPassword(flow.email,password);
      storageSet(PENDING_KEY,JSON.stringify({type:'invite',token:flow.token,name:flow.summary?.name||'',email:flow.email,createdAt:new Date().toISOString()}));
      if(!cred.user.emailVerified){
        try{await sendVerification(cred.user,false);}catch(_e){}
        showVerifyStep('Your account exists but is not verified. A verification email was requested.');
        return;
      }
      await acceptAndEnter(cred.user);
    }catch(error){showInline(friendlyError(error),'error');}
    finally{setBusy(false);}
  };
  window.v138SendInvitePasswordReset=async function(){
    if(flow.busy)return;setBusy(true,'Sending reset link…');showInline('');
    try{
      if(!(await emailMatchesInvite(flow.email)))throw new Error('The invited email could not be confirmed.');
      const auth=window.firebaseAuth||firebase.auth();
      await auth.sendPasswordResetEmail(flow.email,{url:inviteUrl({reset:'1'})});
      showInline('Password reset email sent. After resetting it, return to this invitation and sign in.','success');
    }catch(error){showInline(friendlyError(error),'error');}
    finally{setBusy(false);}
  };
  window.v138CancelInviteSetup=async function(){
    try{const auth=window.firebaseAuth||window.firebase?.auth?.();if(auth?.currentUser)await auth.signOut();}catch(_e){}
    clearInvite();
    try{const url=new URL(location.href);url.searchParams.delete('invite');url.searchParams.delete('recipient');url.searchParams.delete('setup');history.replaceState(null,'',url.pathname+(url.search?url.search:'')+(url.hash||''));}catch(_e){}
    if(typeof window.render==='function')window.render();else location.reload();
  };

  async function initialize(){
    if(!hasInvite())return;
    const root=document.getElementById('v138InviteFlow');if(!root)return;
    if(root.dataset.initialized===flow.token)return;
    root.dataset.initialized=flow.token;flow.initialized=true;
    await loadSummary();
  }
  const observer=new MutationObserver(()=>{if(hasInvite()&&document.getElementById('v138InviteFlow'))initialize();});
  observer.observe(document.documentElement,{childList:true,subtree:true});
  if(hasInvite()){
    setTimeout(()=>{if(typeof window.render==='function'&&!window.currentUser?.())window.render();initialize();},0);
    setTimeout(initialize,400);
    setTimeout(initialize,1200);
  }

  // Make a signed-in wrong account leave cleanly before the dedicated flow is shown.
  window.v138OpenInviteSetup=async function(){
    if(!hasInvite())return;
    try{if(originalLogout)await originalLogout();}catch(_e){}
    if(typeof window.render==='function')window.render();
  };

  window.MyScheduleInvitationSetupV138={
    passwordStatus,normalizeEmail,validEmail,constantEqual,recipientProof,emailMatchesInvite,inviteUrl,
    get token(){return flow.token;},get proof(){return expectedProof();}
  };
})();
