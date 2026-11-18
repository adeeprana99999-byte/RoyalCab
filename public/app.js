const easyrideLogo = '<img class="easyride-logo" src="/easyride-brand.png" alt="EASYRIDE" width="1536" height="1024">';
function requestId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}
const $ = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icons = { grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z', car: 'M5 17H3V10l3-6h12l3 6v7h-2 M5 17h14 M6 10h12 M6 14h1 M17 14h1 M5 17v3 M19 17v3', map: 'M3 5l6-2 6 2 6-2v16l-6 2-6-2-6 2z M9 3v16 M15 5v16', upload: 'M12 16V3 M7 8l5-5 5 5 M3 15v6h18v-6', users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M20 21v-2a4 4 0 0 0-3-4 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M17 3a4 4 0 0 1 0 8', clock: 'M12 8v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0', arrow: 'M5 12h14 M13 6l6 6-6 6', bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9 M10 21h4', check: 'M5 12l4 4L19 6', logout: 'M9 4H3v16h6 M10 12h11 M16 7l5 5-5 5', bolt: 'M13 2L4 14h7l-1 8 10-13h-7z', plus: 'M12 5v14 M5 12h14', flag: 'M5 21V3 M5 4c5-5 9 5 14 0v10c-5 5-9-5-14 0', search: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0' };
const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${icons[name] || icons.grid}"/></svg>`;
let fleetSource='device',fleetSourceInitialized=false;
var selectedScenarioTrip=null;
function matchesFleetSource(driver) {
  if (fleetSource === 'device') return driver.locationSource === 'device';
  if (fleetSource === 'replay') return driver.locationSource === 'replay';
  if (fleetSource === 'sample') return !driver.demoRunId && !['device','replay','scenario'].includes(driver.locationSource);
  const run = queueRun(fleetSource);
  return !!run && driver.demoRunId === run;
}
let fleetFilter = 'all', selectedDriverId = null;
let mapCamera=ProLiftMapCamera.create(), mapBounds=null, mapInteracting=false, mapMoved=false;
let schedulePeriod='priority', schedulePage=1, scheduleSearch='';
let reportGroup='driver',reportData=null,reportFrom='',reportTo='',settingsDirty=false,reportLoading=false,reportRequestId=0;
let boardPage = 1, tripDataScope = 'all', bookingOrder = 'next';
let user, config, state, tab = 'overview', loginTab = 'owner', stream, connected = false, search = '', filter = 'all', batch, loginPhone = '', loginName = '', codeSent = false;
const demoLoginRole = new URLSearchParams(location.search).get('demo');
let connectionMode='connecting', connectionTimer, fallbackRequest, lastStreamUpdate=0, lastSnapshotAt=0, snapshotReceivedAt=0, requestFreshGps;
const STREAM_STALE_MS=22000, RECOVERY_INTERVAL_MS=4000;
const active = t => !['completed', 'cancelled'].includes(t.status);
const labels = { pooled:'Shared run planned', awaiting_driver: 'Awaiting driver', needs_reassignment: 'Needs reassignment', offered: 'Offer pending', accepted: 'Accepted', heading_to_pickup: 'To pickup', arrived: 'At pickup', onboard: 'Onboard', completed: 'Completed', cancelled: 'Cancelled', online: 'Available', busy: 'On trip', offline: 'Offline', valid: 'Validated', preview: 'Preview only', imported: 'Imported' };
const time = v => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const date = v => new Date(v).toLocaleDateString([], { month: 'short', day: 'numeric' });
function badge(status, red = false) { return `<span class="badge ${red ? 'danger' : esc(status)}">${red ? icon('flag') : ''}${esc(red ? 'Needs reassignment' : labels[status] || status)}</span>`; }
function toast(message, error = false) { const el = $('#toast'); el.textContent = message; el.className = 'show' + (error ? ' error' : ''); clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.className = ''; }, 6500); }
async function api(url, body, key, signal) {
  const account=user;
  const rolePrefix = /^\/(owner|driver|james|sofia|backup|retry|fleet-test-[0-9]+|customer)\/$/.test(location.pathname) ? location.pathname.slice(0,-1) : "";
  const res = await fetch(rolePrefix + url, { signal, method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await res.json();
  if (!res.ok) {
    if (res.status===401 && account && user===account) {
      if(account.role==='driver') clearPhoneTracking('Sign in to share your location.');
      stopConnection();user=null;state=null;renderLogin();
    }
    throw new Error(data.error || 'Request failed');
  }
  return data;
}
let interactionPointer = null;
let interactionRenderPending = false;
let interactionReleaseTimer;
const expandedDriverRides=new Set();
document.addEventListener('pointerdown', event => {
  if (!event.isPrimary || event.button !== 0 || !(event.target instanceof Element)) return;
  const ownerControl = user?.role === 'owner' && event.target.closest('button, a, summary, input, select, textarea, label, [role="button"]');
  const driverControl = user?.role === 'driver' && event.target.closest('button[data-action][data-trip], button[data-driver-ride-actions], [data-driver-route]');
  if (ownerControl || driverControl) {
    clearTimeout(interactionReleaseTimer);
    interactionPointer = event.pointerId;
  }
}, true);
function releaseWorkspaceInteraction(event) {
  if (event.pointerId !== interactionPointer) return;
  // Keep the action button mounted until the browser dispatches its click.
  interactionReleaseTimer = setTimeout(() => {
    interactionPointer = null;
    if (!interactionRenderPending) return;
    interactionRenderPending = false;
    if (user && canRefreshWorkspace()) render();
  }, event.type === 'pointerup' && event.pointerType === 'touch' ? 350 : 0);
}
window.addEventListener('pointerup', releaseWorkspaceInteraction, true);
window.addEventListener('pointercancel', releaseWorkspaceInteraction, true);


function applySnapshot(r, explicit=false) {
    if (!user) return;
    if (state && (r.state.revision<state.revision ||
        r.state.revision===state.revision && r.at<lastSnapshotAt)) {
      if (explicit && interactionPointer === null && !$('dialog[open]')) render();
      return;
    }
    // The stopped replay can return an identical snapshot on every poll.
    // Leave the Start control mounted until there is new data to draw.
    if (!explicit && mongoLiveReplay() && tab === 'overview' && state?.lgtcReplay &&
        !state.lgtcReplay.running && state.revision === r.state.revision && lastSnapshotAt === r.at) return;
    // Repeated fleet updates can carry the same driver view with a new revision.
    const driverViewUnchanged = user.role === 'driver' && state &&
      JSON.stringify({...state, revision:0}) === JSON.stringify({...r.state, revision:0});
    const previous=new Set((state?.offers||[]).filter(o=>o.status==='pending').map(o=>o.id));
    const previousTrips = user.role==='owner' && state ? new Map(state.trips.map(trip => [trip.id,trip.status])) : null;
    const driverRide=user.role==='driver'&&state?.trips.find(t=>t.driverId===user.driverId&&active(t));
    const previousDriver=state?.trips.find(t=>t.id===focusedRideId)?.driverId;
    const previousReplay = state?.lgtcReplay;
    state=r.state;
    if (state.lgtcReplay && (!previousReplay || !previousReplay.running && state.lgtcReplay.running)) {
      changeFleetSource('test:' + state.lgtcReplay.runId);
      dispatchView = 'now';
      dispatchPage = 1;
      mapPriorityFilter = 'now';
    }
    if(user.role==='owner'&&focusedRideId){
      const driverId=state.trips.find(t=>t.id===focusedRideId)?.driverId;
      if(driverId!==previousDriver) selectedDriverId=driverId||null;
    }
    lastSnapshotAt=r.at;
    snapshotReceivedAt=performance.now();
    if(user.role==='owner'&&!fleetSourceInitialized){const savedSource=localStorage.getItem('prolift-fleet-source');fleetSource=state.lgtcReplay ? 'test:'+state.lgtcReplay.runId : initialFleetSource(savedSource);selectFirstQueue();fleetSourceInitialized=true;}
    if (user?.role === 'owner' && ['imports','trip-sources'].includes(tab)) updateLgtcLiveStatus();
    if(user?.role==='driver'){
      const closed=(state.offerUpdates||[]).filter(o=>previous.has(o.id));
      if(closed.some(o=>o.status==='taken'))toast('This ride was already taken.');
      else if(closed.length)toast('Dispatch changed this offer.');
    }
    if(driverRide&&!state.trips.some(t=>t.id===driverRide.id)) toast('This ride is no longer assigned to you. Check with dispatch before continuing.',true);
    if (previousTrips) {
      const completed = state.trips.filter(trip => trip.status === 'completed' && previousTrips.get(trip.id) !== 'completed');
      if (completed.length) updateOwnerAfterCompletion(completed);
    }
    if (!explicit && driverViewUnchanged) return;
    // Keep a revealed offer actionable while background updates leave it pending.
    if (!explicit && user.role === 'driver') {
      const accept = $('.driver-route-actions:not([hidden]) button[data-action="accept"]');
      if (accept && state.offers.some(offer => offer.id === accept.dataset.offer && offer.status === 'pending')) return;
    }
    if (interactionPointer !== null) {
      interactionRenderPending = true;
      return;
    }
    // Preserve active form input and modal focus while updates continue in memory.
    if (explicit && user.role === 'driver' && $('dialog[open]')) return;
    if (!explicit && tab==='trips' && mongoTripsEnabled()) {
      const visibleRides = new Map((mongoTrips?.rides||[]).map(ride=>[ride.id,ride]));
      document.querySelectorAll('[data-group-rides]').forEach(element=>{
        const rides=JSON.parse(element.dataset.groupRides).map(id=>visibleRides.get(id)).filter(Boolean);
        if(rides.length) element.innerHTML=mongoGroupStatus(rides);
      });
      document.querySelectorAll('[data-mongo-trip-id]').forEach(row=>{
        const ride=visibleRides.get(row.dataset.mongoTripId);
        const cell=row.querySelector('[data-mongo-trip-stage]');
        if (ride && cell) {
          const markup=mongoTripStage(ride);
          if (cell.innerHTML!==markup) cell.innerHTML=markup;
        }
      });
      return;
    }
    if (explicit || canRefreshWorkspace()) render();
}
function canRefreshWorkspace() {
  return !(tab==='drivers' && fleetPageTab==='records') &&
    !['imports','trip-sources','lgtc-settings','fleet-import'].includes(tab) &&
    !mapInteracting && !$('.fleet-panel-resize:active') && !$('#trip-results [data-bulk-trip]:checked') &&
    !(tab==='settings' && settingsDirty) &&
    !$('dialog[open], .dispatch-planning[open], #imported-fleet details[open]') &&
    !document.activeElement?.closest('form') &&
    !['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName);
}
async function refresh() {
  const account=user, r=await api(mongoLiveReplay() ? '/api/state?dashboard=1' : '/api/state');
  if(user===account) applySnapshot(r,true);
}
function stopConnection() {
  clearInterval(connectionTimer);
  stream?.close();
  stream=null;
  fallbackRequest?.abort();
  fallbackRequest=null;
  setConnection('connecting');
}
function startStream() {
  // The local Wi-Fi replay shares an HTTP/1.1 origin across all demo panels.
  if (location.port === '4781' && location.pathname === '/owner/') return;
  // Three test panels share the same HTTP/1.1 connection pool.
  if (config.mongoReplay || location.port === '4783' && ['/owner/', '/driver/', '/james/'].includes(location.pathname)) return;
  stream?.close();
  lastStreamUpdate=Date.now();
  const source=stream=new EventSource(location.pathname.replace(/\/$/,'')+'/api/events');
  source.onerror=()=>{
    if(stream!==source) return;
    if(connectionMode==='polling') return;
    setConnection(navigator.onLine?'reconnecting':'offline');
    if(navigator.onLine) void checkConnection();
  };
  source.addEventListener('state',e=>{
    if(stream!==source) return;
    lastStreamUpdate=Date.now();
    setConnection('live');
    applySnapshot(JSON.parse(e.data));
  });
}
async function checkConnection() {
  if(!user) return;

  if(!navigator.onLine){setConnection('offline');return;}
  if(Date.now()-lastStreamUpdate>=STREAM_STALE_MS){
    if(connectionMode!=='polling') setConnection('reconnecting');
    startStream();
  }
  if(connectionMode==='live' || fallbackRequest) return;
  const request=fallbackRequest=new AbortController();
  const timeout=setTimeout(()=>request.abort(),RECOVERY_INTERVAL_MS);
  try {
    const r=await api(mongoLiveReplay() ? '/api/state?dashboard=1' : '/api/state',undefined,undefined,request.signal);
    if(fallbackRequest!==request) return;
    if(connectionMode!=='live') setConnection('polling');
    applySnapshot(r);
  } catch {
    if(fallbackRequest===request && connectionMode!=='live') setConnection(navigator.onLine?'reconnecting':'offline');
  } finally {
    clearTimeout(timeout);
    if(fallbackRequest===request) fallbackRequest=null;
  }
}
function listen() {
  stopConnection();
  if(navigator.onLine) startStream();
  else setConnection('offline');
  connectionTimer=setInterval(checkConnection,RECOVERY_INTERVAL_MS);
  if (location.port === '4783' && !stream) void checkConnection();
}
function setConnection(mode) {
  connectionMode=mode;
  connected=mode==='live'||mode==='polling';
  updateConnection();
}
function updateConnection() {
  const el=$('#connection');
  if(!el) return;
  const label={live:'Live connection',connecting:'Connecting…',reconnecting:'Reconnecting · last known',offline:'Offline · last known',polling:'Updating every 4 seconds'}[connectionMode];
  if(el.textContent!==label) el.textContent=label;
  el.className=connected?'connection':'connection reconnect';
  el.setAttribute('role','status');
  let alert=$('#connection-alert');
  const needsAlert=!connected && connectionMode!=='connecting' && !el.getClientRects().length;
  if(needsAlert && !alert){
    alert=document.createElement('p');
    alert.id='connection-alert';
    alert.setAttribute('role','status');
    $('#main-content .page-content')?.prepend(alert);
  }
  if(alert){
    if(alert.textContent!==label) alert.textContent=label;
    alert.hidden=!needsAlert;
  }
}
window.addEventListener('resize',updateConnection);
window.addEventListener('offline',()=>{
  if(!user) return;
  stream?.close();
  stream=null;
  fallbackRequest?.abort();
  fallbackRequest=null;
  setConnection('offline');
});
window.addEventListener('online',()=>{
  if(!user) return;
  setConnection('reconnecting');
  startStream();
  void checkConnection();
  requestFreshGps?.();
});
document.addEventListener('visibilitychange',()=>{
  if(!document.hidden) void checkConnection();
});
function updateOwnerAfterCompletion(completed) {
  const trip = completed.find(t => t.id === $('#modal[open] [data-trip-detail-id]')?.dataset.tripDetailId);
  if (trip) {
    const back = $('#driver-day-back');
    tripDetail(trip.id);
    if (back) $('#modal').append(back);
  }
  const dayForm = $('#modal[open] #driver-day-form');
  if (dayForm) dayForm.refreshAfterCompletion(completed);
  if ($('#modal[open] #dispatch-fleet-detail-table')) showDispatchFleetStatus();
  if (tab === 'reports' && reportData && !document.activeElement?.closest('#report-filters')) run(() => generateReport(true));
}
function referenceLoginForm() {
  if(!config.localPhoneLogin&&!config.hostedPhoneLogin) return loginContent();
  let savedPhone='';try{savedPhone=localStorage.getItem('easyride-login-phone-'+loginTab)||'';}catch{}
  const lock='<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10" width="14" height="12" rx="2" fill="currentColor"/><path d="M8 10V7a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="2.6"/><circle cx="12" cy="15" r="1.5" fill="#15254b"/><path d="M12 16v3" stroke="#15254b" stroke-width="2"/></svg>';
  const person='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="6" r="4" fill="currentColor"/><path d="M3 23v-3a9 9 0 0 1 18 0v3z" fill="currentColor"/></svg>';
  return '<form id="demo-phone-login"><label class="reference-input"><span class="sr-only">Mobile number</span>'+person+'<input id="access-mobile" name="phone" type="tel" inputmode="tel" autocomplete="username" placeholder="Mobile Number" value="'+esc(savedPhone)+'" required></label>'+
    '<label class="reference-input"><span class="sr-only">Password</span>'+lock+'<input id="access-password" name="password" type="password" autocomplete="current-password" aria-label="Password" placeholder="Password" required><button type="button" id="password-visibility" aria-label="Show password" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/><path d="M3 3l18 18"/></svg></button></label>'+
    '<div class="reference-options"><label><input type="checkbox" name="rememberDevice" checked> Remember Me</label><button type="button" data-login-help="password">Forgot Password?</button></div>'+
    '<button class="reference-signin btn primary full" type="submit"><span aria-hidden="true">'+icon('arrow')+'</span> Sign In</button></form>';
}
function renderLogin() {
  if(config.mode==='pilot' && loginTab==='customer') loginTab='owner';
  const roles=config.mode==='pilot'?['owner','driver']:['owner','driver','customer'];
  $('#app').innerHTML=`<div class="easyride-reference" id="easyride-signin"><svg class="reference-filter-defs" width="0" height="0" aria-hidden="true"><defs><filter id="reference-ink-only" color-interpolation-filters="sRGB"><feColorMatrix type="matrix" values="1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 2 2 0 0 -1.1"/></filter></defs></svg>
    <a class="reference-logo" href="#easyride-signin" aria-label="EASYRIDE home"><svg viewBox="60 18 400 195" role="img" aria-label="EasyRide · Ride Smart. Travel Easy."><image href="/login-reference-art.png" width="1672" height="941"/></svg></a>
    <nav class="reference-nav" aria-label="Welcome navigation"><a href="#easyride-signin"><svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M2 10L12 2l10 8-2 2-1-1v11h-5v-7h-4v7H5V11l-1 1z" fill="currentColor"/></svg> Home</a><span aria-hidden="true">|</span><button type="button" data-login-help="about">About</button><span aria-hidden="true">|</span><button type="button" data-login-help="contact">Contact</button><button type="button" class="reference-download" data-login-help="download"><span aria-hidden="true">▯</span> Download App</button></nav>
    <main class="reference-main"><section class="reference-hero" aria-label="Your next ride is just a click away"><h1 class="sr-only">Your Next Ride is Just a Click Away!</h1><svg class="reference-headline" viewBox="185 235 505 165" role="img" aria-label="Your Next Ride is Just a Click Away!"><image href="/login-reference-art.png" width="1672" height="941"/></svg></section>
    <section class="reference-card" aria-labelledby="reference-welcome"><div class="reference-car-icon" aria-hidden="true"><svg viewBox="1273 110 122 122"><image href="/login-reference-art.png" width="1672" height="941"/></svg></div>
      <label class="reference-workspace">Workspace<select id="login-workspace" aria-label="Workspace">${roles.map(role=>`<option value="${role}" ${role===loginTab?'selected':''}>${esc(role[0].toUpperCase()+role.slice(1))}</option>`).join('')}</select></label>
      <h2 id="reference-welcome">Welcome Back!</h2><p class="reference-subtitle">Sign in to continue your journey</p>
      <div id="login-content">${config.needsPreviewAccess?'<label class="reference-workspace-password">Workspace password<input id="workspace-password" type="password" autocomplete="current-password"></label><label><input id="remember-workspace-device" type="checkbox"> Remember this device for 14 days</label>':''}${referenceLoginForm()}</div>
      <div class="reference-divider" aria-hidden="true"><span></span><b>or</b><span></span></div>
      <div class="reference-social"><button type="button" data-login-help="google"><b class="google-letter" aria-hidden="true">G</b>Continue with Google</button><button type="button" data-login-help="apple"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 12c0-2 1-3 2-4-1-2-3-3-5-2-1 0-2 1-3 1s-2-1-3-1C5 6 3 8 3 12c0 4 3 9 5 9 1 0 2-1 3-1 2 0 2 1 4 1 2 0 4-4 5-6-2 0-3-2-3-3zM12 6c0-3 2-5 5-5 0 3-2 5-5 5z" fill="currentColor"/></svg>Continue with Apple</button></div>
      <p class="reference-signup">Don’t have an account? <button type="button" data-login-help="signup">Sign Up</button></p>
      ${config.localPhoneLogin?'<details class="reference-demo"><summary>Local test sign-in details</summary><p>'+esc(({owner:'+15550103001',driver:'+15550101001',customer:'+15550102001'})[loginTab])+' · Ride1234</p></details>':''}
    </section></main>
    <footer class="reference-footer"><div>${icon('bolt')}<span>Fast Booking</span></div><i aria-hidden="true"></i><div><svg viewBox="0 0 32 36" aria-hidden="true"><path d="M16 2L3 7v10c0 8 8 14 13 17 5-3 13-9 13-17V7z"/><path d="M9 17l5 5 9-11"/></svg><span>Safe &amp; Secure</span></div><i aria-hidden="true"></i><div><svg viewBox="0 0 32 36" aria-hidden="true"><path d="M3 19v-3a13 13 0 0 1 26 0v3M3 18H1v11h6V18zM29 18h2v11h-6V18zM27 29c0 4-6 5-10 5"/><text x="8" y="24" fill="currentColor" stroke="none" font-size="12" font-weight="bold">24</text></svg><span>24/7 Support</span></div></footer>
  </div>`;
  bindLogin();
  $('#login-workspace').onchange=event=>{loginTab=event.target.value;codeSent=false;renderLogin();};
  if($('#password-visibility'))$('#password-visibility').onclick=()=>{const input=$('#access-password'),button=$('#password-visibility'),show=input.type==='password';input.type=show?'text':'password';button.setAttribute('aria-label',show?'Hide password':'Show password');button.setAttribute('aria-pressed',String(show));};
  const messages={about:'EASYRIDE connects your Owner, Driver, and Customer workspaces for trip planning and dispatch.',contact:'For account help, contact your fleet owner or dispatcher.',download:'The app-store download is not configured yet. You can use EASYRIDE in your phone browser.',password:'Password recovery is not configured yet. Contact your fleet owner to reset your password.',google:'Google sign-in is not connected yet. Please sign in with your mobile number and password.',apple:'Apple sign-in is not connected yet. Please sign in with your mobile number and password.',signup:'Please contact your fleet owner to create your account.'};
  document.querySelectorAll('[data-login-help]').forEach(button=>button.onclick=()=>toast(messages[button.dataset.loginHelp]));
}
function loginContent() {
  if (config.localPhoneLogin || config.hostedPhoneLogin) {
    const samples={owner:'+15550103001',driver:'+15550101001',customer:'+15550102001'};
    let savedPhone=''; try { savedPhone=localStorage.getItem('easyride-login-phone-'+loginTab)||''; } catch {}
    return '<form id="demo-phone-login"><label>Mobile number<input name="phone" type="tel" autocomplete="username" value="'+esc(savedPhone)+'" required></label>'+ 
      '<label>Password<input name="password" type="password" autocomplete="current-password" required></label>'+
      (config.hostedPhoneLogin?'<label><input type="checkbox" name="rememberDevice" checked> Remember me on this device for 14 days</label>':'')+
      '<button class="btn primary full">Sign in</button>'+(config.localPhoneLogin?'<p class="help">Demo mobile: '+samples[loginTab]+' · Password: Ride1234</p>':'')+'</form>';
  }
  if (config.mode === 'pilot') return '<form id="pilot-login">' +
    (loginTab === 'driver' ? '<label>Driver ID<input name="driverId" maxlength="80" required autocomplete="username"></label>' : '') +
    '<label>Access code<input type="password" name="code" minlength="20" maxlength="150" required autocomplete="current-password"></label>' +
    '<button class="btn primary full">Sign in</button></form>';
  if (loginTab === 'owner') return `<div class="workspace-card">${icon('grid')}<h3>Your fleet command center</h3><p>Manage planned trips, dispatch drivers, and see your fleet in one view.</p></div><button class="btn primary full" id="owner-login">Open owner dashboard ${icon('arrow')}</button><p class="help">Demo access only. Production requires individual owner accounts and MFA.</p>`;
  if (loginTab === 'driver') return `<label>Demo driver<select id="driver-choice">${config.drivers.map(d => `<option value="${d.id}">${esc(d.name)} · ${esc(d.vehicle)}</option>`).join('')}</select></label><div class="workspace-card compact">${icon('car')} Accept offers, update trips, and keep dispatch informed.</div><button class="btn primary full" id="driver-login">Open driver app ${icon('arrow')}</button>`;
  return `<div class="workspace-card compact">${icon('users')} Try the sample customer, Alex Morgan.</div><button class="btn primary full" type="button" id="demo-customer-login">Open customer app ${icon('arrow')}</button><details class="help"${codeSent ? ' open' : ''}><summary>Test mobile verification</summary><form id="customer-login"><label>Your name<input id="customer-name" maxlength="100" autocomplete="name" value="${esc(loginName || 'Alex Morgan')}" required></label><label>Mobile number<input id="customer-phone" type="tel" autocomplete="tel" placeholder="+15550102001" value="${esc(loginPhone || '+15550102001')}" required></label><p class="help">Include the country code. The sample number has an existing planned trip.</p>${codeSent ? '<label>Verification code<input id="sms-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label>' : ''}<div id="sms-hint" class="sms-hint"></div><button class="btn primary full" type="submit">${codeSent ? 'Verify & continue' : 'Send verification code'} ${icon('arrow')}</button>${codeSent ? '<button class="btn quiet full" type="button" id="resend">Request another code</button>' : ''}</form></details>`;
}
async function enter(u) {stopConnection(); driverPayDate=''; expandedMongoTrips.clear(); mongoTrips=null; mongoTripQuery=''; mongoTripFilter='all'; mongoTripPage=1; if (u.role==='owner' && location.protocol==='https:') { config=await api('/api/config'); if(config.mongoOwnerRecords) fleetPageTab='records'; }state=null;lastSnapshotAt=0;fleetSourceInitialized=false; readinessData=null;readinessRevision=-1;readinessFilter='all';readinessPageNumber=1; scheduledData=null;scheduledPageNumber=1;selectedCustomerTrip=null;highlightedHistoryRide=null;customerHistoryReturn=null;user = u; if(config.mode==='pilot') config=await api('/api/config'); tab = user.role === 'owner' ? (config.sheetOnly ? 'imports' : 'overview') : user.role === 'driver' ? 'work' : 'mytrips'; await refresh(); listen(); if (u.role === 'owner') loadLgtcHistory(); }
async function grantHostedWorkspaceAccess() {
  if (!config.needsPreviewAccess) return;
  const input = $('#workspace-password');
  if (!input?.value) {
    input?.focus();
    throw Error('Enter the workspace password to continue.');
  }
  await api('/api/preview/access',{username:'preview',password:input.value,rememberDevice:!!$('#remember-workspace-device')?.checked});
  config.needsPreviewAccess=false;
  input.value='';
}
async function enterDemoRole(role,driverId) {
  await grantHostedWorkspaceAccess();
  return enter((await api('/api/demo-login',{role,driverId})).user);
}
const signOut = () => run(async () => { if(user.role==='driver'&&gpsWatch!==null)await stopPhoneTracking();await api('/api/logout', {}); stopConnection(); user = null; codeSent = false; renderLogin(); });
function bindLogin() {
  const phoneLogin=$('#demo-phone-login');
  if(phoneLogin) phoneLogin.onsubmit=event=>{
    event.preventDefault();
    const credentials=Object.fromEntries(new FormData(phoneLogin));
    credentials.rememberDevice=phoneLogin.elements.rememberDevice?.checked===true;
    run(async()=>{
      const result=await api(config.hostedPhoneLogin?'/api/hosted-login':'/api/auth/demo-password',{role:loginTab,...credentials});
      try { if(credentials.rememberDevice) localStorage.setItem('easyride-login-phone-'+loginTab,credentials.phone); else localStorage.removeItem('easyride-login-phone-'+loginTab); } catch {}
      await enter(result.user);
    });
  };
  if ($('#forget-workspace-device')) $('#forget-workspace-device').onclick=()=>run(async()=>{
    await api('/api/preview/forget',{});
    config.needsPreviewAccess=true;
    renderLogin();
  });
  document.querySelectorAll('[data-login-tab]').forEach(el => el.onclick = () => { loginTab = el.dataset.loginTab; codeSent = false; renderLogin(); });
  if ($('#owner-login')) $('#owner-login').onclick = () => run(async () => enterDemoRole('owner'));
  if ($('#driver-login')) $('#driver-login').onclick = () => run(async () => enterDemoRole('driver', $('#driver-choice').value));
  if ($('#demo-customer-login')) $('#demo-customer-login').onclick = () => run(async () => enterDemoRole('customer'));
  if ($('#customer-login')) $('#customer-login').onsubmit = e => { e.preventDefault(); run(async () => {
    await grantHostedWorkspaceAccess();
    loginPhone = $('#customer-phone').value.trim(); loginName = $('#customer-name').value.trim();
    if (codeSent) return enter((await api('/api/auth/verify', { phone: loginPhone, name: loginName, code: $('#sms-code').value })).user);
    const result = await api('/api/auth/request-code', { phone: loginPhone }); codeSent = true; renderLogin(); $('#sms-hint').textContent = `DEMO code: ${result.demoCode} · No SMS was sent.`; $('#sms-code').focus();
  }); };
  if ($('#resend')) $('#resend').onclick = () => {
    codeSent = false;
    renderLogin();
    $('#customer-login').closest('details').open = true;
    $('#customer-phone').focus();
  };
  if ($('#pilot-login')) $('#pilot-login').onsubmit = event => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    run(async () => {
      const result = await api('/api/pilot-login',{role:loginTab,driverId:fields.get('driverId')?.trim(),code:fields.get('code')});
      await enter(result.user);
    });
  };
}
async function run(fn) { try { await fn(); } catch (e) { toast(e.message, true); } }
function shell(content) {
  const retainedMap=document.querySelector('#geo-fleet-map');

  const owner = user.role === 'owner';if(owner){ownerShell(content,retainedMap);return;}
  const nav = user.role === 'driver' ? [['work', 'car', 'My work'], ['vehicle','car','Vehicle'], ['driver-messages','bell','Messages'], ['scheduled','clock','Scheduled rides'], ['history', 'clock', 'Trip history']] : [['mytrips', 'car', 'My trips'], ['help','bell','Help requests'], ['messages','bell','Ride updates'], ['history', 'clock', 'Trip history']];
  const titles = {readiness: 'Pickup readiness',scheduled:'Scheduled rides',help:'Help requests', overview: 'Live fleet', trips: 'All trips', schedule: 'Upcoming rides', fleet: 'Live fleet', imports: 'Import planned trips', drivers: 'Your drivers', activity: 'Activity log', work: 'Your driving day', vehicle:'Vehicle', 'driver-messages':'Messages', mytrips: 'Your trips', history: 'Trip history', reports:'Reports', messages:'Customer messages', settings:'Settings' };
  $('#app').innerHTML = `<a class="skip-link" href="#main-content">Skip to main content</a><div class="app-layout rider-driver-portal role-${esc(user.role)}"><aside class="sidebar"><a class="brand" href="/">${easyrideLogo}</a><div class="workspace-label">${owner ? 'OWNER WORKSPACE' : user.role === 'driver' ? 'DRIVER WORKSPACE' : 'CUSTOMER WORKSPACE'}</div><nav>${nav.map(([id, i, label]) => `<button data-nav="${id}" class="nav-item ${tab === id ? 'active' : ''}" ${tab===id?'aria-current="page"':''}>${icon(i)}${label}${driverReplyBadge(id)}${id === 'trips' && state.trips.some(t => t.redFlag) ? '<span class="nav-alert">!</span>' : ''}</button>`).join('')}</nav>${quickNavigation(nav)}<label class="mobile-navigation">Workspace<select id="workspace-navigation" aria-label="Open workspace section">${nav.map(([id,,label])=>`<option value="${id}" ${tab===id?'selected':''}>${label}</option>`).join('')}</select></label><div class="sidebar-bottom"><div class="simulation">${icon('bolt')}<div><strong>Demo environment</strong><span>Dummy GPS, SMS & routing</span></div></div><div class="profile"><span class="avatar">${esc(user.name[0])}</span><div><strong>${esc(user.name)}</strong><span>${owner ? 'Fleet owner' : user.role === 'driver' ? 'Driver' : 'Customer'}</span></div><button id="logout" class="icon-btn" title="Sign out" aria-label="Sign out">${icon('logout')}</button></div></div></aside><main class="main" id="main-content" tabindex="-1"><header class="topbar"><span>Workspace <span class="slash">/</span> <strong>${titles[tab]}</strong></span><div><span id="connection" class="connection">${connected ? 'Live connection' : 'Connecting…'}</span><span class="today">${new Date().toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</span></div></header><div class="page-content ${user.role === 'owner' && tab === 'overview' ? 'fleet-home' : ''}">${content}</div><footer>EASYRIDE <span>Local demo · Simulated dispatch</span></footer></main></div><dialog id="modal"></dialog>`;
  document.querySelectorAll('[data-nav]').forEach(el => el.onclick = () => { tab = el.dataset.nav; search = ''; filter = 'all'; render(); });
  $('#logout').onclick = signOut;
  const newMap=document.querySelector('#geo-fleet-map');if(retainedMap&&newMap&&geoMap){newMap.replaceWith(retainedMap);}else if(geoMap){geoMap.remove();geoMap=null;geoMarkers=null;}
  bindActions();
}
function driverReplyBadge(id){
  if(user.role!=='driver'||id!=='driver-messages')return '';
  const key='royalcab.driver-replies.'+user.driverId;
  let read={};
  try{read=JSON.parse(localStorage.getItem(key)||'{}')||{};}catch{}
  let unread=0;
  for(const request of state.supportRequests||[]){
    if(!request.ownerReply)continue;
    const version=JSON.stringify([request.updatedAt,request.ownerReply]);
    if(tab==='driver-messages')read[request.id]=version;
    else if(read[request.id]!==version)unread++;
  }
  if(tab==='driver-messages'){try{localStorage.setItem(key,JSON.stringify(read));}catch{}}
  return unread?'<span class="nav-alert" aria-label="'+unread+' unread replies">'+unread+'</span>':'';
}
function quickNavigation(nav){const ids=user.role==='owner'?['overview','readiness','trips','schedule']:user.role==='driver'?['work','vehicle','driver-messages','scheduled','history']:['mytrips','messages','history','help'];return '<div class="quick-nav" aria-label="Quick workspace navigation">'+nav.filter(([id])=>ids.includes(id)).map(([id,i,label])=>'<button data-nav="'+id+'" class="'+(tab===id?'active':'')+'" '+(tab===id?'aria-current="page"':'')+'>'+icon(i)+esc(label)+driverReplyBadge(id)+'</button>').join('')+'</div>';}

function scenarioTrips(){return state.fleetScenario?state.trips.filter(t=>t.demoRunId===state.fleetScenario.runId):[];}
function scenarioControls(){const r=state.fleetScenario,trips=scenarioTrips(),completed=trips.filter(t=>t.status==='completed').length;return '<section class="scenario-controls"><div><span class="eyebrow">CHARLOTTE FLEET SIMULATION</span><h2>4 cars. 6 trips. Watch dispatch work.</h2><p>'+(r?esc(r.status)+' · '+completed+' of 6 rides completed.':'Nearest eligible driver → offer → simulated acceptance → pickup → drop-off → available again.')+'</p><small>Dummy coordinates, automatic test-driver responses and accelerated travel. No real customers or SMS.</small></div><div class="card-actions"><button class="btn primary" data-scenario-action="start">'+(r?'Restart Charlotte fleet':'Run Charlotte fleet')+'</button>'+(r?.status==='running'?'<button class="btn" data-scenario-action="stop">Stop fleet test</button>':'')+'</div></section>';}
function scenarioRideBoard(){if(fleetSource!=='scenario'||!state.fleetScenario)return '';return '<section class="scenario-ride-board"><div class="panel-heading"><div><h2>Follow each Charlotte ride</h2><p>Choose a ride to highlight its car, pickup, destination and trail.</p></div></div><div class="scenario-cards">'+scenarioTrips().map(t=>{const o=state.offers.find(o=>o.tripId===t.id&&o.status==='pending'),d=state.drivers.find(d=>d.id===(t.driverId||o?.driverId)),e=ProLiftRideExplanation.explain(state,t,'owner');return '<article class="panel scenario-card '+(selectedScenarioTrip===t.id?'selected':'')+'"><div class="trip-card-head"><strong>'+esc(t.reference)+'</strong>'+badge(t.status)+'</div><p class="scenario-car">'+(d?esc(d.name)+' · '+esc(d.plate):'Waiting for an available car')+'</p><div class="scenario-route"><span><b>PICKUP</b>'+esc(t.pickup)+'</span><span><b>DROP-OFF</b>'+esc(t.destination)+'</span></div><p>'+esc(e.meaning)+'</p>'+(t.demoAssignmentReason?'<div class="scenario-reason">'+esc(t.demoAssignmentReason)+'</div>':'<div class="scenario-reason">Busy cars cannot take a second ride. A freed car will be considered automatically.</div>')+(t.demoCandidateRanking?'<details><summary>Driver choices when offered</summary><ol>'+t.demoCandidateRanking.slice(0,4).map(c=>'<li>'+esc(c.name)+' · '+c.eta+' min simulated ETA</li>').join('')+'</ol></details>':'')+'<div class="card-actions"><button class="btn primary" data-follow-scenario="'+t.id+'">Follow ride</button><button class="btn" data-detail="'+t.id+'">Details</button></div></article>';}).join('')+'</div></section>';}
function drawScenarioRoutes(){if(!geoScenarioRoutes)return;geoScenarioRoutes.clearLayers();if(fleetSource!=='scenario'||!state.fleetScenario)return;const run=state.fleetScenario,t=scenarioTrips().find(t=>t.id===selectedScenarioTrip),driver=t?.driverId||state.offers.find(o=>o.tripId===t?.id&&o.status==='pending')?.driverId||selectedDriverId;for(const [id,trail] of Object.entries(run.trails)){if(driver&&driver!==id)continue;fleetMapProvider().polyline(trail.map(p=>[p.lat,p.lng]),{color:driver?'#285fda':'#718bb8',weight:driver?5:2,opacity:.7}).addTo(geoScenarioRoutes);}if(!t)return;for(const [name,label,color] of [[t.pickup,'PICKUP','#14916b'],[t.destination,'DROP-OFF','#7754d5']]){const p=config.places.find(p=>p.name===name);if(p)fleetMapProvider().circleMarker([p.lat,p.lng],{radius:7,color:'#fff',weight:2,fillColor:color,fillOpacity:1}).addTo(geoScenarioRoutes).bindTooltip(label,{permanent:true,direction:'top'});}}

function trackingReplayControls(){const r=state.trackingReplay,active=r&&['running','paused'].includes(r.status);return '<section class="tracking-test-panel"><div><span class="eyebrow">TRACKING TEST · NO PHONE REQUIRED</span><h2>Follow the test car in Charlotte.</h2><p>'+(r?'Replay '+esc(r.status)+' · '+Math.round(r.progress*100)+'% · '+r.sequence+' validated readings.':'Press Start tracking test. Look for the large car labeled TEST CAR on the map below.')+'</p></div><div class="card-actions"><button class="btn primary" data-replay-action="start">'+(r?'Restart tracking test':'Start tracking test')+'</button>'+(active?'<button class="btn" data-replay-action="'+(r.status==='paused'?'resume':'pause')+'">'+(r.status==='paused'?'Resume test':'Pause test')+'</button><button class="btn" data-replay-action="stop">Stop test</button>':'')+'</div>'+(r?'<progress max="1" value="'+r.progress+'" aria-label="Coordinate replay progress"></progress>':'')+'</section>';}

function operationsSummary(){const fleet=ProLiftBoard.fleet(state).filter(i=>matchesFleetSource(i.driver)),trips=state.trips.filter(t=>!t.demoRunId),attention=trips.filter(t=>ProLiftBoard.group(t)==='attention').length;return '<div class="operations-summary">'+[['Available drivers',fleet.filter(d=>d.status==='available').length,'Ready for a pickup','car'],['Active rides',state.trips.filter(t=>t.driverId&&active(t)&&fleet.some(i=>i.driver.id===t.driverId)).length,'Accepted and in progress','map'],['Upcoming pickups',trips.filter(t=>active(t)&&t.pickupAt>=Date.now()).length,'Scheduled ahead','clock'],['Needs attention',attention,'Review dispatch exceptions','flag']].map(([label,value,note,i])=>'<article class="operations-metric '+(i==='flag'&&value?'attention':'')+'"><div>'+label+icon(i)+'</div><strong>'+value+'</strong><small>'+note+'</small></article>').join('')+'</div>';}
function heading(eyebrow, title, subtitle, buttons = '') { if (user?.role === 'owner') return ownerPageHeading(title,subtitle,buttons); return `<section class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${subtitle}</p></div><div class="heading-actions">${buttons}</div></section>`; }
function stats() {
  const cards = [['Planned trips', state.trips.length, 'All trips in this workspace', 'car'], ['Awaiting a driver', state.trips.filter(t => ['awaiting_driver', 'needs_reassignment', 'offered'].includes(t.status)).length, 'Ready for your attention', 'clock'], ['Drivers available', state.drivers.filter(d => d.status === 'online').length, `${state.drivers.length} drivers in your fleet`, 'users'], ['Completed trips', state.trips.filter(t => t.status === 'completed').length, 'Successfully delivered', 'check']];
  return `<div class="stats">${cards.map(([label, count, sub, i]) => `<article class="stat"><div>${label}<span class="stat-icon">${icon(i)}</span></div><strong>${count.toString().padStart(2, '0')}</strong><small>${sub}</small></article>`).join('')}</div>`;
}
function mapView(drivers = state.drivers, trip) {
  // Non-geographic schematic: GPS coordinates project into a simplified local panel.
  const project = p => ({ x: Math.max(35, Math.min(725, 65 + (p.lng + 74.025) * 2400)), y: Math.max(35, Math.min(365, 350 - (p.lat - 40.70) * 3100)) });
  const pins = drivers.map((d, i) => { const p = project(d); return `<g transform="translate(${p.x.toFixed(1)} ${p.y.toFixed(1)})"><circle r="22" fill="${d.status === 'busy' ? '#fff2d2' : '#d7f4b7'}"/><circle r="14" fill="#163e37" stroke="white" stroke-width="3"/><text text-anchor="middle" y="4" fill="white" font-size="11" font-weight="700">${esc(d.name.split(' ').map(x => x[0]).join(''))}</text><title>${esc(d.name)} · ${esc(labels[d.status])}</title></g>`; }).join('');
  const pickup = trip && config.places.find(p => p.name === trip.pickup), dest = trip && config.places.find(p => p.name === trip.destination);
  const route = pickup && dest ? (() => { const a = project(pickup), b = project(dest); return `<path d="M${a.x} ${a.y} L${a.x} ${b.y} L${b.x} ${b.y}" fill="none" stroke="#307467" stroke-width="4" stroke-dasharray="7 6"/><circle cx="${a.x}" cy="${a.y}" r="7" fill="#387e69" stroke="white" stroke-width="3"/><circle cx="${b.x}" cy="${b.y}" r="7" fill="#d79336" stroke="white" stroke-width="3"/>`; })() : '';
  return `<div class="map-wrap"><div class="map-top"><span class="map-label">${icon('map')} ${trip ? 'Trip route' : 'Fleet overview'}</span><span class="map-demo">SCHEMATIC · DEMO GPS</span></div><svg class="fleet-map" viewBox="0 0 760 400" role="img" aria-label="Schematic map with simulated driver positions; not a real road map"><defs><pattern id="blocks" width="76" height="55" patternTransform="rotate(-14)" patternUnits="userSpaceOnUse"><rect width="76" height="55" fill="#f0f1e9"/><rect x="5" y="5" width="64" height="42" rx="3" fill="#e4e7dd"/><path d="M0 0H76M0 0V55" stroke="#fff" stroke-width="6"/></pattern></defs><rect width="760" height="400" fill="url(#blocks)"/><path d="M560-20C510 80 600 150 555 230S520 350 600 430H800V-20Z" fill="#cbdfe0"/><path d="M300 20L360 8 400 160 342 175Z" fill="#ccdcbc"/><path d="M0 285L565 120M140 400L350 0" stroke="white" stroke-width="13"/><text x="395" y="86" fill="#818e80" font-size="12" letter-spacing="2">MIDTOWN</text><text x="150" y="320" fill="#818e80" font-size="12" letter-spacing="2">DOWNTOWN</text><text x="620" y="240" fill="#7c9ea4" font-size="12" transform="rotate(-75 620 240)">EAST RIVER</text>${route}${pins}</svg><div class="map-bottom"><span><i class="dot green"></i> Available</span><span><i class="dot amber"></i> On trip</span><span>Positions refresh automatically</span></div></div>`;
}
function driverRows() { return state.drivers.map(d => `<div class="driver-row"><span class="avatar ${d.status === 'busy' ? 'gold' : ''}">${esc(d.name.split(' ').map(x => x[0]).join(''))}</span><div><strong>${esc(d.name)}</strong><small>${esc(d.vehicle)} · ${esc(d.plate)}</small></div><div class="driver-end">${badge(d.status)}<small>${Math.max(0, Math.floor((Date.now() - d.lastLocationAt) / 1000))}s ago · demo GPS</small></div></div>`).join(''); }
function alerts() {
  const dropped = state.trips.filter(t => t.redFlag);
  return dropped.length ? `<div class="alert danger-alert">${icon('flag')}<div><strong>${dropped.length} ${dropped.length === 1 ? 'trip needs' : 'trips need'} reassignment</strong><span>A driver dropped an accepted ride. Replacement dispatch is active; the flag clears when a driver accepts.</span></div><button class="btn small" data-go="trips">Review trips ${icon('arrow')}</button></div>` : '';
}
function tripTable(trips, compact = false) {
  if (!trips.length) return `<div class="empty">${icon('car')}<h3>No trips here yet</h3><p>${user.role === 'owner' ? 'Import your planned trips or change the filters.' : 'Your trips will appear here.'}</p></div>`;
  return `<div class="table-scroll"><table><thead><tr><th>Trip / customer</th><th>Route</th><th>Pickup</th><th>Status</th>${compact ? '' : '<th>Driver / offer</th>'}<th></th></tr></thead><tbody>${trips.map(t => { const d = state.drivers.find(d => d.id === t.driverId); return `<tr class="${t.redFlag ? 'flagged-row' : ''}"><td><button class="text-btn trip-ref" data-detail="${t.id}">${esc(t.reference)}</button><small>${esc(t.customerName)}</small></td><td><div class="route-cell"><span class="route-dot"></span>${esc(t.pickup)}<small>↳ ${esc(t.destination)}</small></div></td><td><strong>${time(t.pickupAt)}</strong><small>${date(t.pickupAt)}</small></td><td>${badge(t.status, t.redFlag)}${t.redFlag && t.status === 'offered' ? '<small>Replacement offer pending</small>' : ''}</td>${compact ? '' : `<td>${assignmentCell(t)}</td>`}<td>${user.role === 'owner' && ['awaiting_driver', 'needs_reassignment'].includes(t.status) ? `<button class="btn small ${t.redFlag ? 'red-btn' : 'primary'}" data-trip="${t.id}" data-action="offer">${icon('bolt')} Auto-assign</button>` : `<button class="icon-btn" aria-label="View ${esc(t.reference)}" data-detail="${t.id}">${icon('arrow')}</button>`}</td></tr>`; }).join('')}</tbody></table></div>`;
}
function assignmentCell(t) {
  const driver = state.drivers.find(d => d.id === t.driverId);
  const offers = state.offers.filter(o => o.tripId === t.id);
  const pending = offers.find(o => o.status === 'pending' && o.expiresAt > Date.now());
  const candidate = pending && state.drivers.find(d => d.id === pending.driverId);
  if (driver) {
    const accepted = offers.find(o => o.status === 'accepted' && o.driverId === driver.id);
    return `<strong>${esc(driver.name)}</strong><small class="assignment-success">Accepted · assignment confirmed</small>${accepted ? `<small>Selected by pickup ETA · ${accepted.eta} min (demo)</small>` : ''}`;
  }
  if (candidate) return `<strong>${esc(candidate.name)}</strong><small class="assignment-pending">Offer sent · waiting for acceptance</small><small>Nearest eligible · ${pending.eta} min (demo)</small><small>Respond by ${time(pending.expiresAt)}</small>`;
  if (t.dispatchError) return `<span class="validation-error">No driver selected</span><small class="dispatch-error">${esc(t.dispatchError)}</small><small>Open trip details to retry the search.</small>`;
  if (!active(t)) return '<span class="muted">No current assignment</span>';
  if (t.pickupAt > Date.now() + dispatchLead() * 60000) return `<strong>Scheduled</strong><small>${t.autoDispatch ? 'Automatic dispatch queued' : 'Automatic dispatch not enabled'}</small><small>Opens ${time(t.pickupAt - dispatchLead() * 60000)} · ${date(t.pickupAt - dispatchLead() * 60000)}</small>`;
  return `<strong>${t.autoDispatch ? 'Finding a driver' : 'Not dispatched yet'}</strong><small>${t.autoDispatch ? 'Automatic search enabled' : 'Click Auto-assign or start automatic dispatch above'}</small>`;
}
function dispatchPanel() {
  const offers = state.offers.filter(o => o.status === 'pending' && o.expiresAt > Date.now());
  const accepted = state.trips.filter(t => t.driverId && active(t));
  const waiting = state.trips.filter(t => ['awaiting_driver', 'needs_reassignment'].includes(t.status));
  return `<section class="panel dispatch-panel"><div class="dispatch-intro"><span class="stat-icon">${icon('bolt')}</span><div><h2>Automatic trip assignment</h2><p>Available drivers → nearest eligible driver → offer → driver accepts → confirmed assignment.</p></div><button class="btn primary" id="start-auto-dispatch" ${waiting.length ? '' : 'disabled'}>${icon('bolt')} Start automatic dispatch</button></div><div class="dispatch-counters"><span><strong>${waiting.length}</strong> Waiting / scheduled</span><span><strong>${offers.length}</strong> Offers awaiting acceptance</span><span><strong>${accepted.length}</strong> Confirmed assignments</span></div><p class="dispatch-explanation">Check <strong>Driver / offer</strong> below to see exactly who received each ride. A pending offer is not a confirmed assignment. Drivers respond in their own app; GPS and ETAs are simulated.</p></section>${dummyWalkthrough()}`;
}
function dummyWalkthrough() {
  const t = [...state.trips].reverse().find(t => t.demoRunId);
  const o = t && state.offers.find(o => o.tripId === t.id && o.status === 'pending' && o.expiresAt > Date.now());
  const d = o && state.drivers.find(d => d.id === o.driverId);
  const accepted = t && state.drivers.find(d => d.id === t.driverId);
  return `<section class="panel demo-walkthrough"><div class="panel-heading"><div><div class="eyebrow">INTERACTIVE WALKTHROUGH · DUMMY TRIP ONLY</div><h2>See automatic assignment happen.</h2><p>Start a trip, compare nearby drivers, and try the driver's response.</p></div><button class="btn primary" id="start-dummy-trip">${icon('plus')} ${t ? 'Start fresh dummy trip' : 'Try a dummy trip'}</button></div>${t ? `<div class="demo-columns"><div><h3>1. System compares available drivers</h3><p><strong>${esc(t.reference)}</strong> · Central Station → City Hospital</p><div class="demo-ranking">${t.demoCandidates.map((c, index) => `<div><span class="count">${index + 1}</span><div><strong>${esc(c.name)}</strong><small>${c.eta} min to pickup · simulated</small></div><span>${c.driverId === t.driverId ? '✓ Accepted' : c.driverId === o?.driverId ? '← Offer sent' : t.excluded.includes(c.driverId) ? 'Skipped after decline / timeout' : 'Next in queue'}</span></div>`).join('')}</div><p class="help">All three have suitable cars and fresh simulated locations. The shortest pickup time wins. Demo drivers are isolated from other trips.</p></div><div class="demo-phone"><div class="eyebrow">2. DRIVER RESPONSE PREVIEW</div>${o && d ? `<h3>New trip for ${esc(d.name)}</h3><p>Central Station → City Hospital<br>Pickup ETA: <strong>${o.eta} min (demo)</strong><br>Offer expires at ${time(o.expiresAt)}</p><div class="card-actions"><button class="btn primary" data-demo-response="accept" data-demo-offer="${o.id}" data-demo-trip="${t.id}">Accept trip</button><button class="btn" data-demo-decline="${o.id}" data-demo-trip="${t.id}">Decline · choose reason</button></div><p class="help">These walkthrough buttons simulate this driver's response using the actual dispatch rules. In normal operation, only that driver responds in their app.</p>` : accepted ? `<span class="badge completed">Assignment confirmed</span><h3>${esc(accepted.name)} accepted.</h3><p>The trip is now assigned to this driver. Start a fresh dummy trip to try declining instead.</p>` : `<h3>No active offer</h3><p>${t.status === 'cancelled' ? 'This demo ended.' : 'Offers have expired or all demo drivers were tried.'} Start a fresh dummy trip to continue.</p>`}<p class="help">Real drivers should respond only when safely stopped.</p></div></div><div class="demo-timeline"><h3>3. Watch the result</h3>${state.events.filter(e => e.tripId === t.id).slice(0, 5).map(e => `<p><strong>${esc(e.type.replace(/[._]/g, ' '))}</strong> · ${esc(e.actor)}${e.detail ? ' · ' + esc(e.detail) : ''}</p>`).join('')}</div>` : '<div class="empty"><p>Creates a fresh trip and three available dummy drivers. No real SMS or phone notifications are sent.</p></div>'}</section>`;
}
var dispatchView = 'now', dispatchPage = 1, dispatchSearch = '', focusedRideId = null, geoFocusedRoute = null;
const queuePageSize = 6;

function queueRun(source) {
  if (source === 'device' || source === 'sample') return null;
  if (source === 'scenario') return state.fleetScenario?.runId;
  if (source === 'volume') return state.volumeDemo?.runId;
  if (source === 'queue-review') return state.queueReviewDemo?.runId;
  if (source?.startsWith('test:')) return source.slice(5);
  return undefined;
}
function queueFor(source = fleetSource, now = fleetNow()) {
  return ProLiftBoard.dispatchQueue(state.trips, queueRun(source), now, dispatchLead());
}
function visibleDispatchQueue(lists) {
  return Object.fromEntries(Object.entries(lists).map(([key,rides])=>[key,ProLiftBoard.searchTrips(rides,dispatchSearch,state.drivers)]));
}
function queueTotal(queue) {
  return queue.now.length + queue.later.length + queue.attention.length;
}
function initialFleetSource(savedSource) {
  if (savedSource === 'device' || savedSource === 'sample') return savedSource;
  if (queueRun(savedSource) && queueTotal(queueFor(savedSource))) return savedSource;
  return 'device';
}
function selectFirstQueue() {
  const queue = queueFor();
  dispatchView = queue.now.length ? 'now' : queue.attention.length ? 'attention' : queue.later.length ? 'later' : 'now';
  mapPriorityFilter = dispatchView;
  dispatchPage = 1;
}
function changeFleetSource(source) {
  fleetSource = source;
  dispatchSearch = '';
  dutyFilter = 'all';
  fleetSearch = '';
  vehicleFocusId = followedVehicleId = null;
  localStorage.setItem('prolift-fleet-source', source);
  focusedRideId = selectedDriverId = null;
  if (geoMap) { geoMap.remove(); geoMap = geoMarkers = null; }
  mapInteracting = false;
  selectFirstQueue();
}
function testQueueOptions() {
  const options = [];
  const knownRuns = new Set();
  for (const [source, label, run] of [
    ['scenario', 'Charlotte test', state.fleetScenario?.runId],
    ['volume', '500-trip test', state.volumeDemo?.runId],
    ['queue-review', '150-trip queue test', state.queueReviewDemo?.runId],
    [null, 'Shared ride test', state.sharedPlanDemo?.runId]
  ]) {
    if (!run) continue;
    knownRuns.add(run);
    options.push([source || 'test:' + run, label, run]);
  }
  if (state.lgtcReplay) {
    knownRuns.add(state.lgtcReplay.runId);
    options.push(['test:'+state.lgtcReplay.runId,'LGTC dispatch replay',state.lgtcReplay.runId]);
  }
  const additional = new Set(state.trips.filter(t => t.demoRunId && active(t) && !t.poolParentId && !knownRuns.has(t.demoRunId)).map(t => t.demoRunId));
  for (const [i, run] of [...additional].entries()) {
    const walkthrough=state.trips.some(t=>t.demoRunId===run&&Array.isArray(t.demoCandidates));
    options.push(['test:' + run, walkthrough?'Driver offer walkthrough':'Test dataset '+(i+1), run]);
  }
  return options;
}
function fleetIdentity(source) {
  const identities = {
    device: { theme:'phone', code:'GPS', label:'Ordinary fleet', detail:'Phone GPS' },
    sample: { theme:'sample', code:'SMP', label:'Sample fleet', detail:'Simulated cars' },
    scenario: { theme:'charlotte', code:'CLT', label:'Charlotte test', detail:'Dispatch simulation' },
    volume: { theme:'volume', code:'500', label:'500-trip test', detail:'Volume dataset' },
    'queue-review': { theme:'other', code:'150', label:'150-trip queue test', detail:'50 rides per queue at setup' },
    'test:mongo-lgtc-replay': { theme:'other', code:'LGTC', label:'LGTC dispatch replay', detail:'Simulated dispatch' },
    replay: { theme:'sample', code:'RPL', label:'GPS replay', detail:'Location simulation' }
  };
  if (identities[source]) return identities[source];
  if (queueRun(source) && queueRun(source) === state.sharedPlanDemo?.runId) {
    return { theme:'shared', code:'SHR', label:'Shared ride test', detail:'Shared pickup simulation' };
  }
  const label = testQueueOptions().find(([key]) => key === source)?.[1];
  return { theme:'other', code:'TST', label:label || 'Test fleet', detail:'Test bookings' };
}
function fleetBadge(identity) {
  return '<span class="fleet-identity-badge fleet-theme-' + identity.theme + '"><span>' +
    esc(identity.code) + '</span> ' + esc(identity.label) + '</span>';
}
function dispatchFleetPicker() {
  const options = testQueueOptions();
  if(fleetSource==='replay'||state.trackingReplay) options.push(['replay']);
  const ordinary=fleetSource==='device'||fleetSource==='sample';
  if(!ordinary&&!options.some(([source])=>source===fleetSource)) options.push([fleetSource]);
  const button = (source, selected=fleetSource===source) => {
    const identity = fleetIdentity(source);
    const count = queueTotal(queueFor(source));
    return '<button type="button" class="dispatch-fleet-choice fleet-theme-' + identity.theme + '" data-dispatch-fleet="' +
      esc(source) + '" aria-pressed="' + selected + '"><span class="fleet-choice-code" aria-hidden="true">' + esc(identity.code) +
      '</span><span class="fleet-choice-copy"><strong>' + esc(identity.label) + '</strong><small>' +
      (source === 'replay' ? 'Map only' : count + (count===1?' open ride':' open rides')) + '</small></span></button>';
  };
  const previous=$('#dispatch-test-fleets');
  const open=previous?.dataset.source===fleetSource?previous.open:!ordinary;
  const tests=config.mode==='pilot'||!options.length?'':'<details id="dispatch-test-fleets" data-source="'+esc(fleetSource)+'" '+(open?'open':'')+'>'+
    '<summary>Test fleets'+(!ordinary?' · '+esc(fleetIdentity(fleetSource).label):'')+'</summary>'+
    '<p>Sample rides are separate from the ordinary fleet.</p><div class="dispatch-test-options">'+options.map(([source])=>button(source)).join('')+'</div></details>';
  return '<nav class="dispatch-fleet-picker" aria-label="Choose dispatch fleet">'+button('device',ordinary)+tests+'</nav>';
}
function openQueueBookings() {
  const run = queueRun(fleetSource);
  tripDataScope = run === null ? 'live' : run || 'all';
  bookingOrder = 'next';
  search = '';
  filter = 'all';
  boardPage = 1;
  tab = 'trips';
  render();
  window.scrollTo(0, 0);
}
function dispatchEmpty(total) {
  if (!total && fleetSource === 'test:mongo-lgtc-replay') return '<h3>No open rides in this replay</h3><p>Start local dispatch to replay the schedule.</p>';
  if (fleetSource === 'replay') return '<h3>GPS replay</h3><p>Choose a queue above to view open rides.</p>';
  if (!total) return config.mode==='pilot' ? '<h3>No open rides</h3><p>Import and approve your LGTC schedule or add a booking.</p>' :
    '<h3>No open rides in this queue</h3><p>Choose another queue, open Bookings, or start a Charlotte test.</p><button class="btn small" id="watch-auto-dispatch">Start Charlotte test</button>';
  const title = { now:'No rides in the next hour', later:'No later pickups', attention:'No rides need attention' }[dispatchView];
  return '<h3>' + title + '</h3><p>Choose another queue tab above to see the open rides.</p>';
}
const dutyLabels = { online:'Online', busy:'On ride', offline:'Offline' };
let dutyFilter = 'all';
let fleetSearch='',vehicleFocusId=null,followedVehicleId=null,lastFollowPosition='';
function dutyRoster(now = fleetNow()) {
  const run = queueRun(fleetSource);
  return ProLiftBoard.fleet(state,now).filter(({driver}) =>
    run === undefined ? matchesFleetSource(driver) : (driver.demoRunId || null) === run);
}
function dutyLocation({driver,hasLocation,age}) {
  if (driver.setupPending) return 'Confirm vehicle, seats and accessibility';
  if (['scenario','replay'].includes(driver.locationSource)) return hasLocation ? 'Simulated GPS' : 'Waiting for test position';
  if (driver.locationSource !== 'device') return hasLocation ? 'Sample position' : 'No phone GPS';
  if (driver.status === 'offline' && hasLocation) return 'Last phone position';
  if (!driver.trackingEnabled || !hasLocation) return 'Phone GPS off';
  return age > 120000 ? 'Phone GPS stale' : 'Phone GPS live';
}
function fleetRowMatches({driver,hasLocation,age}) {
  const needsLocation=!hasLocation||age>120000||driver.locationSource==='device'&&!driver.trackingEnabled;
  const matchesDuty=dutyFilter==='all'||(dutyFilter==='gps'?needsLocation:driver.status===dutyFilter);
  return matchesDuty&&[driver.name,driver.vehicle,driver.plate].join(' ').toLowerCase().includes(fleetSearch.toLowerCase());
}
function vehicleCanFollow(item) {
  return item?.hasLocation&&item.driver.status!=='offline'&&item.age<=120000&&
    (item.driver.locationSource==='device'?item.driver.trackingEnabled:['scenario','replay'].includes(item.driver.locationSource));
}
function selectedVehiclePanel() {
  const item=dutyRoster().find(item=>item.driver.id===vehicleFocusId);
  if(!item) return '';
  const {driver,trip,offer,hasLocation,age}=item;
  const canLocate=hasLocation&&matchesFleetSource(driver)&&fleetRowMatches(item);
  const activeRide=trip||state.trips.find(t=>t.id===offer?.tripId);
  const nextRide=state.trips.filter(ride => ride.id !== activeRide?.id && !ride.poolParentId &&
    active(ride) && ride.pickupAt >= fleetNow() &&
    (ride.driverId === driver.id || ride.reservedDriverId === driver.id || ride.plannedDriverId === driver.id))
    .sort((a,b) => a.pickupAt - b.pickupAt)[0];
  const freshness=hasLocation?' · '+(age<60000?Math.floor(age/1000)+' sec ago':Math.floor(age/60000)+' min ago'):'';
  const follow=followedVehicleId===driver.id&&vehicleCanFollow(item);
  return '<section class="fleet-inspector" aria-label="Selected vehicle"><div class="fleet-inspector-head"><div><small>SELECTED VEHICLE</small><h3>'+
    esc([driver.vehicle,driver.plate].filter(Boolean).join(' · '))+'</h3></div></div>'+
    '<p><strong>'+esc(driver.name)+'</strong> · '+esc(dutyLabels[driver.status]||driver.status)+'</p><p>'+esc(dutyLocation(item)+freshness)+
    (hasLocation?' · '+time(driver.lastLocationAt):'')+'</p>'+
    '<p>'+(activeRide?esc((trip?'Current ride ':'Offer pending ')+activeRide.reference+' · '+activeRide.customerName+
      (trip ? ' · '+(labels[trip.status] || trip.status) : '')):'No active ride')+'</p>'+
    '<p>'+(nextRide ? esc('Next pickup · '+time(nextRide.pickupAt)+' · '+nextRide.customerName+' · '+nextRide.reference+
      (nextRide.driverId === driver.id ? ' · Assigned' : nextRide.reservedDriverId === driver.id ? ' · Reserved' : ' · Planned')) :
      'No upcoming pickup for this driver')+'</p><div class="fleet-inspector-actions">'+
    (canLocate?'<button class="btn small" id="center-selected-vehicle">Center map</button>':'<small>Position unavailable in this map view.</small>')+
    (canLocate&&vehicleCanFollow(item)?'<button class="btn small" id="follow-selected-vehicle" aria-pressed="'+!!follow+'">'+(follow?'Stop following':'Follow vehicle')+'</button>':'')+
    (activeRide?'<button class="text-btn" data-focus-ride="'+esc(activeRide.id)+'">Open ride</button>':'')+
    (nextRide?'<button class="text-btn" data-focus-ride="'+esc(nextRide.id)+'">Open next ride</button>':'')+
    '<button class="text-btn" data-driver-day="'+esc(driver.id)+'">Driver day</button></div></section>';
}
function centerFleetVehicle() {
  const item=dutyRoster().find(item=>item.driver.id===vehicleFocusId);
  if(!geoMap||!item?.hasLocation||!matchesFleetSource(item.driver)||!fleetRowMatches(item)) return;
  geoMap.fitBounds([[item.driver.lat,item.driver.lng]],{padding:[55,55],maxZoom:15,animate:false});
}
function stopVehicleFollow() {
  followedVehicleId=null;
  lastFollowPosition='';
  const button=$('#follow-selected-vehicle');
  if(button){button.textContent='Follow vehicle';button.setAttribute('aria-pressed','false');}
}
function chooseFleetVehicle(id) {
  stopVehicleFollow();
  focusedRideId=null;
  vehicleFocusId=selectedDriverId=id;
  render();
  if (!id) return;
  const details=selectedVehiclePanel();
  if (!details) return;
  modal(details, {compact:true});
  const dialog=$('#modal');
  $('#center-selected-vehicle')?.addEventListener('click',centerFleetVehicle);
  const follow=$('#follow-selected-vehicle');
  if (follow) follow.onclick=()=>{
    if (followedVehicleId) stopVehicleFollow();
    else {
      followedVehicleId=vehicleFocusId;
      centerFleetVehicle();
      follow.textContent='Stop following';
      follow.setAttribute('aria-pressed','true');
    }
  };
  dialog.querySelectorAll('[data-focus-ride]').forEach(button=>{
    button.onclick=()=>tripDetail(button.dataset.focusRide);
  });
  bindDriverDayButtons(dialog);
}
function fleetProfilePhoto(driver) {
  if (!driver?.profilePhotoVersion) return '';
  const prefix = location.pathname === '/owner/' ? '/owner' : '';
  return prefix+'/api/driver-profile-photo?driverId='+encodeURIComponent(driver.id)+
    '&v='+encodeURIComponent(driver.profilePhotoVersion);
}
function editFleetProfilePhoto(driver) {
  if (!driver) return;
  modal('<h2>Profile photo · '+esc(driver.name)+'</h2><form id="fleet-profile-form">'+
    '<label>Choose a profile photo<input type="file" name="photo" accept="image/jpeg,image/png,image/webp" required></label>'+
    '<p>Saved photos appear on every Owner screen.</p><button class="btn primary">Save photo</button></form>');
  $('#fleet-profile-form').onsubmit = event => {
    event.preventDefault();
    const file = event.currentTarget.elements.photo.files[0];
    run(async()=>{
      if (!file || !['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 5000000) throw Error('Choose a JPEG, PNG or WebP photo under 5 MB.');
      const photo = await createImageBitmap(file);
      try {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 160;
        const size = Math.min(photo.width, photo.height);
        canvas.getContext('2d').drawImage(photo,(photo.width-size)/2,(photo.height-size)/2,size,size,0,0,160,160);
        await api('/api/driver-profile-photo',{driverId:driver.id,photo:canvas.toDataURL('image/jpeg',.85)});
      } finally { photo.close(); }
      $('#modal').close();
      await refresh();
    });
  };
}
function fleetDriverAvatar(driver) {
  const photo = fleetProfilePhoto(driver);
  const initials = driver?.name?.trim().split(/\s+/).slice(0,2).map(word=>word[0]).join('');
  const tone = [...(driver?.id || '')].reduce((sum,letter)=>sum+letter.charCodeAt(0),0)%4;
  return '<span class="live-driver-avatar avatar-tone-'+tone+'" aria-hidden="true">'+
    '<span class="live-driver-silhouette"></span><b>'+esc(initials||'—')+'</b>'+
    (photo?'<img alt="" src="'+esc(photo)+'">':'')+'</span>';
}
function dispatchFleetStatus() {
  const roster = dutyRoster();
  const counts = { all:roster.length, online:0, busy:0, offline:0 };
  for (const {driver} of roster) if (Object.hasOwn(dutyLabels,driver.status)) counts[driver.status]++;
  const filters = Object.entries({all:'All',...dutyLabels,gps:'GPS needs attention'}).map(([key,label])=>
    '<button type="button" data-duty-filter="' + key + '" aria-pressed="' + (dutyFilter===key) +
    '" class="duty-filter duty-' + key + '"><span>' + label + '</span>'+ (Object.hasOwn(counts,key)?' <strong>'+counts[key]+'</strong>':'')+'</button>'
  ).join('');
  const rows = roster.filter(fleetRowMatches)
    .sort((a,b)=>a.driver.name.localeCompare(b.driver.name)).map(item=>{
      const {driver,trip,status} = item;
      return '<li><button class="text-btn live-driver-identity" data-vehicle-focus="' + esc(driver.id) + '" aria-pressed="'+(vehicleFocusId===driver.id)+'">' +
        fleetDriverAvatar(driver) + '<span><b>'+esc(driver.name)+'</b><small>'+esc([driver.vehicle,driver.plate].filter(Boolean).join(' · '))+'</small></span></button><span class="duty-pill duty-' + esc(driver.status) + '">' + esc(dutyLabels[driver.status] || driver.status) +
        '</span><small>' + esc(trip ? trip.reference + ' · ' + dutyLocation(item) : status==='offered' ?
          'Offer pending · ' + dutyLocation(item) : dutyLocation(item)) + '</small><button class="text-btn live-photo-edit" data-fleet-photo="'+esc(driver.id)+'" aria-label="Change profile photo for '+esc(driver.name)+'">Photo</button></li>';
    }).join('');
  return '<section id="driver-duty" class="driver-duty" aria-label="Driver duty status"><div class="driver-duty-heading"><div><h3>Vehicles and driver duty</h3>' +
    '</div>' +
    (roster.length ? '<button class="text-btn" id="dispatch-fleet-status">Fleet details</button>' :
      '<button class="text-btn" data-go="drivers">Drivers &amp; cars</button>') + '</div>' +
    '<form id="fleet-vehicle-search" class="fleet-vehicle-search"><input type="search" name="query" maxlength="100" aria-label="Find a vehicle" placeholder="Plate, vehicle or driver" value="'+esc(fleetSearch)+'"><button class="btn small">Find</button>'+
    (fleetSearch?'<button type="button" class="text-btn" id="clear-fleet-search">Clear</button>':'')+'</form>'+
    '<div class="driver-duty-filters" aria-label="Filter drivers by duty status">' + filters + '</div>' +
    '<ul id="driver-duty-roster" tabindex="0" aria-label="Drivers in this fleet">' +
    (rows || '<li class="driver-duty-empty">No vehicles match this view.</li>') + '</ul></section>';
}
function showDispatchFleetStatus() {
  const rows = dutyRoster().map(({ driver, hasLocation, trip, ...item }) =>
    '<tr><td><button class="text-btn" data-driver-day="' + esc(driver.id) + '">' + esc(driver.name) + '</button><small>' + esc(driver.vehicle + ' · ' + driver.plate) + '</small></td><td>' +
    esc(dutyLabels[driver.status] || driver.status) + '</td><td>' + esc(dutyLocation({driver,hasLocation,...item})) +
    (hasLocation ? '<small>' + esc(date(driver.lastLocationAt) + ' · ' + time(driver.lastLocationAt)) + '</small>' : '') +
    '</td><td>' + (trip ? '<button class="text-btn" data-fleet-trip="' + esc(trip.id) + '">' + esc(trip.reference) + '</button>' : '—') + '</td></tr>'
  ).join('');
  modal('<h2>Fleet details</h2><p>' + fleetBadge(fleetIdentity(fleetSource)) + '</p><div class="table-scroll"><table id="dispatch-fleet-detail-table"><thead><tr><th>Driver and car</th><th>Status</th><th>Last location</th><th>Current ride</th></tr></thead><tbody>' +
    rows + '</tbody></table></div>');
  $('#modal').querySelectorAll('[data-fleet-trip]').forEach(button => {
    button.onclick = () => tripDetail(button.dataset.fleetTrip);
  });
  bindDriverDayButtons($('#modal'));
}
function bindDriverDayButtons(root = document) {
  root.querySelectorAll('[data-driver-day]').forEach(button => {
    button.onclick = () => run(() => openDriverDay(button.dataset.driverDay));
  });
}
async function openDriverDay(driverId, date) {
  if (!driverId) driverId = state.drivers.find(matchesFleetSource)?.id || state.drivers[0]?.id;
  if (!driverId) throw Error('Add a driver before planning a day.');
  modal('<h2>Driver day</h2><p role="status">Loading schedule…</p>');
  const dialog = $('#modal');
  try {
    const { day } = await api('/api/driver-day', { action:'view', driverId, date });
    if (dialog.isConnected && dialog.open) renderDriverDay(day);
  } catch (error) {
    if (dialog.isConnected && dialog.open) modal('<h2>Driver day</h2><p role="alert">' + esc(error.message) + '</p>');
  }
}
function renderDriverDay(day) {
  const clock = new Intl.DateTimeFormat([], { timeZone:day.timezone, hour:'numeric', minute:'2-digit' });
  const labels = { planned:'Planned', proposed:'Proposed', reserved:'Reserved', offer:'Offer sent', accepted:'Confirmed',
    heading_to_pickup:'To pickup', arrived:'At pickup', onboard:'On ride', completed:'Completed', cancelled:'Cancelled',
    fallback:'Alternate driver', preference:'Needs review' };
  const options = [...state.drivers].sort((a,b) => a.name.localeCompare(b.name)).map(driver =>
    '<option value="' + esc(driver.id) + '" ' + (driver.id === day.driver.id ? 'selected' : '') + '>' +
    esc(driver.name + ' · ' + driver.vehicle) + '</option>').join('');
  const fleetPreview = day.previewScope === 'fleet';
  const fleetSummary = day.fleet.drivers.map(driver =>
    '<tr><td><button type="button" class="text-btn" data-day-driver="' + esc(driver.id) + '"' +
    (driver.id === day.driver.id ? ' aria-current="true"' : '') + '>' + esc(driver.name) + '</button></td><td>' +
    driver.assigned + '</td><td>' + driver.completed + '</td><td>' + driver.remaining + '</td><td>' + driver.tentative +
    '</td>' + (fleetPreview ? '<td>' + driver.proposed + '</td>' : '') + '</tr>').join('');
  const left = day.fleet.left.map(row => '<li><strong>' + esc(clock.format(row.pickupAt) + ' · ' + row.pickup) + '</strong><small>' +
    esc(row.reference + ' · ' + row.reason) + '</small><button class="text-btn" data-day-trip="' + esc(row.id) + '">Ride details</button></li>').join('');
  const summary = '<section class="day-fleet-summary"><h3>Fleet schedule</h3><p class="help">Assigned includes confirmed and completed runs. Left to run includes pending offers, reservations and saved plans.</p>' +
    '<div class="table-scroll"><table><thead><tr><th>Driver</th><th>Assigned</th><th>Completed</th><th>Left to run</th><th>Tentative</th>' +
    (fleetPreview ? '<th>Proposed</th>' : '') + '</tr></thead><tbody>' + fleetSummary + '</tbody></table></div>' +
    '<details><summary>' + day.fleet.left.length + ' ' + (fleetPreview ? 'left unallocated after this preview' : (day.fleet.left.length === 1 ? 'ride' : 'rides') + ' left unallocated') +
    '</summary>' + (left ? '<ol class="day-unallocated">' + left + '</ol>' : '<p class="help">Every open run has a driver or plan.</p>') + '</details></section>';
  const rows = day.rows.map(row => '<li><div class="driver-day-time"><strong>' + esc(clock.format(row.pickupAt)) + '</strong>' +
    (row.endAt ? '<small>' + (row.status === 'completed' ? 'Completed ' : 'Est. end ') + esc(clock.format(row.endAt)) + '</small>' : '') + '</div><div class="driver-day-route"><strong>' + esc(row.pickup) +
    '</strong><p>→ ' + esc(row.destination) + '</p><small>' + esc(row.reference) + '</small>' +
    (row.shared?.length > 1 ? '<details><summary>' + row.shared.length + ' shared pickups</summary><ul>' +
      row.shared.map(stop => '<li>' + esc(clock.format(stop.pickupAt) + ' · ' + stop.pickup) + '</li>').join('') + '</ul></details>' : '') +
    '</div><div class="driver-day-state"><span class="badge ' + (row.conflict || row.status === 'preference' ? 'danger' : row.status === 'completed' ? 'completed' : 'offered') + '">' +
    esc(labels[row.status] || row.status) + '</span>' + (row.regular ? '<small>Regular customer</small>' : '') +
    (row.note || row.conflict ? '<small>' + esc([row.note,row.conflict].filter(Boolean).join(' · ')) + '</small>' : '') +
    (row.tripId ? '<button class="text-btn" data-day-trip="' + esc(row.tripId) + '">Ride details</button>' : '') + '</div></li>').join('');
  modal('<h2>Driver day</h2><p>' + esc(day.driver.name + ' · ' + day.driver.seats + ' passenger seats · ' + day.timezone) + '</p>' +
    '<form id="driver-day-form"><label>Driver<select name="driverId">' + options + '</select></label><label>Service date<input type="date" name="date" value="' + esc(day.date) +
    '" required></label></form><p class="validation-error" id="driver-day-error" role="alert"></p>' +
    '<div class="driver-day-actions">' + (day.date >= day.today ? '<button class="btn" id="fleet-day-preview">Preview fleet day</button>' : '') +
    (fleetPreview && day.fleet.proposed ? '<button class="btn primary" id="fleet-day-save">Save fleet plan · ' + day.fleet.proposed + ' runs</button>' : '') + '</div>' +
    summary + '<h3>' + esc(day.driver.name) + '’s schedule</h3><p class="help">End times use estimated travel and a five-minute buffer. Planned rides still need driver acceptance.</p>' +
    (rows ? '<ol class="driver-day-timeline">' + rows + '</ol>' : '<div class="empty"><p>No rides on this driver’s timeline for this date.</p></div>') +
    '<div class="driver-day-actions">' + (day.date >= day.today ? '<button class="btn" id="driver-day-preview">Preview day plan</button>' : '') +
    (!fleetPreview && day.proposedCount ? '<button class="btn primary" id="driver-day-save">Save ' + day.proposedCount + ' proposed ' +
      (day.proposedCount === 1 ? 'ride' : 'rides') + '</button>' : '') + '</div>' +
    (day.previewKey && !day.proposedCount ? '<p class="help">No additional rides fit this driver’s current availability and commitments.</p>' : ''));
  const form = $('#driver-day-form'), dialog = $('#modal');
  const dayFormat = new Intl.DateTimeFormat('en-CA', {timeZone:day.timezone,year:'numeric',month:'2-digit',day:'2-digit'});
  let completionRequest = 0;
  form.refreshAfterCompletion = completed => {
    const driverIds = new Set(day.fleet.drivers.map(driver => driver.id));
    if (!completed.some(trip => !trip.poolParentId && driverIds.has(trip.driverId) &&
      dayFormat.format(trip.pickupAt) === day.date)) return;
    if (day.previewKey) {
      $('#driver-day-error').textContent = 'A ride was completed. Preview again to review the updated schedule.';
      for (const button of dialog.querySelectorAll('#driver-day-save, #fleet-day-save')) button.disabled = true;
      return;
    }
    if (form.elements.date.disabled) return;
    const request = ++completionRequest;
    run(async () => {
      const { day:updated } = await api('/api/driver-day', { action:'view', driverId:day.driver.id, date:day.date });
      if (request !== completionRequest || !form.isConnected || !dialog.open || form.elements.date.disabled ||
          form.elements.date.value !== day.date || form.elements.driverId.value !== day.driver.id) return;
      const scrollTop = dialog.scrollTop;
      renderDriverDay(updated);
      dialog.scrollTop = scrollTop;
    });
  };
  const load = async (action, scope) => {
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const controls = [...dialog.querySelectorAll('#driver-day-form input, #driver-day-form select, .driver-day-actions button, [data-day-driver]')];
    controls.forEach(control => control.disabled = true);
    try {
      const result = await api('/api/driver-day', { action, scope, driverId:data.get('driverId'), date:data.get('date'), previewKey:day.previewKey });
      if (!form.isConnected || !dialog.open) return;
      renderDriverDay(result.day);
      if (action === 'save') toast((scope === 'fleet' ? 'Fleet plan saved.' : 'Driver day saved.') + ' Dispatch will request acceptance before pickup.');
    } catch (error) {
      if (form.isConnected) $('#driver-day-error').textContent = error.message;
    } finally { controls.forEach(control => control.disabled = false); }
  };
  form.onchange = () => load('view');
  form.onsubmit = event => { event.preventDefault(); load('view'); };
  if ($('#driver-day-preview')) $('#driver-day-preview').onclick = () => load('preview');
  if ($('#driver-day-save')) $('#driver-day-save').onclick = () => load('save');
  if ($('#fleet-day-preview')) $('#fleet-day-preview').onclick = () => load('preview', 'fleet');
  if ($('#fleet-day-save')) $('#fleet-day-save').onclick = () => load('save', 'fleet');
  dialog.querySelectorAll('[data-day-driver]').forEach(button => {
    button.onclick = () => {
      form.elements.driverId.value = button.dataset.dayDriver;
      if (fleetPreview) load('preview', 'fleet');
      else load('view');
    };
  });
  dialog.querySelectorAll('[data-day-trip]').forEach(button => {
    button.onclick = () => {
      tripDetail(button.dataset.dayTrip);
      const back = document.createElement('button');
      back.id = 'driver-day-back'; back.className = 'btn'; back.textContent = 'Back to driver day';
      back.onclick = () => run(() => openDriverDay(day.driver.id,day.date));
      dialog.append(back);
    };
  });
}
function dispatchRideRow(t, now) {
  const kind = dispatchView === 'attention' ? 'overdue' : ProLiftBoard.priority(t, now);
  const driver = state.drivers.find(d => d.id === t.driverId);
  const status = {accepted:'Confirmed',heading_to_pickup:'To pickup',arrived:'At pickup',onboard:'On ride'}[t.status] || 'Assigned';
  const opens = t.pickupAt - dispatchLead()*60000;
  const issue = ProLiftBoard.attentionReason(t,now,dispatchLead());
  const pendingOffer=state.offers.find(o=>o.tripId===t.id&&o.status==='pending'&&o.expiresAt>now);
  const pending=!!pendingOffer;
  const assignment = driver ? status + ': ' + driver.name : pending ? (t.demoRunId==='mongo-lgtc-replay' ? 'Offer pending: '+(state.drivers.find(d=>d.id===pendingOffer.driverId)?.name||'Driver') : ProLiftBoard.dispatchLabel(state,t,now).label) : issue || (opens>now ?
    'Scheduled · offers open ' + date(opens) + ' ' + time(opens) : ProLiftBoard.dispatchLabel(state,t,now).label);
  const lastFailure=state.offers.findLast(o=>o.tripId===t.id&&['declined','expired'].includes(o.status));
  const attempt=lastFailure?(state.drivers.find(d=>d.id===lastFailure.driverId)?.name||'Previous driver')+
    (lastFailure.status==='declined'?' declined':' did not respond in 45 seconds'):'';
  const canAssign = t.demoRunId!=='mongo-lgtc-replay' && !t.driverId && opens<=now && ['awaiting_driver','needs_reassignment','offered'].includes(t.status);
  return '<article class="dispatch-ride-wrap"><button class="dispatch-row ' + (t.id === focusedRideId ? 'selected' : '') +
    '" data-detail="' + esc(t.id) + '"><div><span class="dispatch-dot ' + kind + '"></span><strong>' + esc(t.reference) +
    '</strong><span>' + esc(date(t.pickupAt) + ' · ' + time(t.pickupAt)) + '</span></div><p class="live-pickup">' + icon('map') + ' ' + esc(t.pickup) +
    '</p><small class="live-dropoff">' + icon('flag') + ' ' + esc(t.destination) + '</small>' + (driver&&issue?'<small class="dispatch-last-attempt">'+esc(issue)+'</small>':'')+
    (attempt?'<small class="dispatch-last-attempt">'+esc(attempt)+'</small>':'') + '<footer><span class="' + (issue&&!pending?'queue-issue':'') + '">' + esc(assignment) + '</span> <span>' + t.passengers +
    (t.passengers === 1 ? ' rider' : ' riders') + (t.isSharedRun ? ' · Shared' : '') + '</span></footer></button>' +
    (canAssign ? '<button class="dispatch-assign" data-quick-assign="' + esc(t.id) + '">' + (issue?'Review &amp; assign':'Assign') + '</button>' : '') + '</article>';
}
function latestCompletion() {
  const run = queueRun(fleetSource);
  if (run === undefined) return '';
  const ride = state.trips.reduce((latest,t) =>
    t.status === 'completed' && !t.poolParentId && (t.demoRunId || null) === run && t.completedAt &&
    (!latest || t.completedAt > latest.completedAt) ? t : latest, null);
  if (!ride) return '';
  const driver = state.drivers.find(d=>d.id===ride.driverId);
  return '<section class="dispatch-completion dispatch-completion-clickable"><div>' + icon('check') + '<strong>Last completed</strong></div><p>' +
    esc([ride.reference,driver?.name,date(ride.completedAt),time(ride.completedAt)].filter(Boolean).join(' · ')) +
    '</p><button class="text-btn" data-detail="' + esc(ride.id) + '">View completed ride</button></section>';
}
function selectedDispatchRide(t,now) {
  const driver=state.drivers.find(d=>d.id===t.driverId);
  const attempts=state.offers.filter(o=>o.tripId===t.id).slice(-4).reverse();
  const openHistory=$('#selected-offer-history')?.open&&$('#selected-offer-history').dataset.rideId===t.id;
  const issue=ProLiftBoard.attentionReason(t,now,dispatchLead());
  const forecast=t.pickupForecast;
  const eta=forecast?.status==='available'&&forecast.expiresAt>now?'Road ETA '+time(forecast.arrivalAt)+' · Checked '+time(forecast.checkedAt):
    forecast?.status==='gps_unavailable'?'Pickup ETA unavailable · waiting for fresh driver GPS':forecast?'Pickup ETA unavailable · waiting for a fresh road estimate':'';
  const assignment=driver?driver.name+' · '+(labels[t.status]||t.status):ProLiftBoard.dispatchLabel(state,t,now).label;
  const canOffer=!t.driverId&&active(t)&&t.pickupAt<=now+dispatchLead()*60000;
  const statuses={pending:'Awaiting response',accepted:'Accepted',declined:'Declined',expired:'Timed out',replaced_by_owner:'Replaced by dispatch',taken:'Another driver accepted'};
  return '<section class="dispatch-selection" aria-label="Selected ride"><div><small>SELECTED RIDE</small><button class="text-btn" id="clear-focused-ride" aria-label="Clear selected ride">×</button></div>'+
    '<h3>'+esc(t.reference)+' · '+esc(t.customerName)+'</h3><p>'+esc(t.pickup)+' → '+esc(t.destination)+'</p>'+
    '<p><strong>'+esc(assignment)+'</strong> · Pickup '+date(t.pickupAt)+' '+time(t.pickupAt)+(issue?'<br><span class="dispatch-last-attempt">'+esc(issue)+'</span>':'')+'</p>'+
    (driver?'<p>'+esc(driver.vehicle)+' · '+esc(driver.plate)+'</p>':'')+(eta?'<p>'+esc(eta)+'</p>':'')+
    '<div class="dispatch-selection-actions">'+(canOffer?'<button class="btn primary small" data-quick-assign="'+esc(t.id)+'">Review drivers</button>':'')+
    (active(t)?'<a class="text-btn" href="#fleet-map" id="selected-ride-map">Show on map</a>':'')+
    (driver?'<button class="text-btn" data-driver-day="'+esc(driver.id)+'">Driver day</button>':'')+
    (canReplaceConfirmed(t)?'<button class="text-btn danger-text" data-replace-confirmed="'+esc(t.id)+'">Replace driver</button>':'')+
    '<button class="text-btn" data-detail="'+esc(t.id)+'">Open ride details</button></div>'+
    (attempts.length?'<details id="selected-offer-history" data-ride-id="'+esc(t.id)+'" '+(openHistory?'open':'')+'><summary>Recent offers</summary><ol>'+
      attempts.map(o=>'<li><strong>'+esc(state.drivers.find(d=>d.id===o.driverId)?.name||'Driver')+'</strong> · '+
        esc(o.status==='pending'&&o.expiresAt<=now?'Awaiting timeout check':statuses[o.status]||o.status)+
        (o.declineReason?' · '+esc(o.declineReason):'')+'</li>').join('')+'</ol></details>':'')+'</section>';
}
let missedPickupProgress='', missedPickupTimer;
function bindMissedPickupDemo(){
  const button=$('#start-missed-pickup');
  if(!button)return;
  $('#missed-group-test').onclick=()=>run(async()=>{
    clearInterval(missedPickupTimer);
    const result=await fetch('/owner/missed-group-test',{method:'POST'});
    if(!result.ok)throw Error(await result.text());
    missedPickupProgress=await result.text();
    $('#missed-pickup-progress').textContent=missedPickupProgress;
  });
  const url='/owner/missed-pickup-demo';
  const retry=$('#retry-missed-demo'),accept=$('#accept-missed-demo'),decline=$('#decline-missed-demo');
  const show=status=>{
    missedPickupProgress='Minute '+status.minute+' / 15 · '+status.attempts+' driver searches · '+
      (status.attention?'Needs Attention · '+status.reason:status.status==='accepted'?'Confirmed assignment · '+status.driver:status.status==='offered'?'Offer pending · '+status.driver:'Searching for an eligible driver');
    if(status.history?.length)missedPickupProgress+=' · Offers: '+status.history.join(', ');
    $('#missed-pickup-progress').textContent=missedPickupProgress;
    $('#retry-missed-demo').hidden=!(status.attention&&status.history?.length===3);
    $('#accept-missed-demo').hidden=$('#decline-missed-demo').hidden=!(status.status==='offered'&&status.driver==='Jordan Reed');
  };
  for(const [control,path] of [[retry,'retry'],[accept,'accept'],[decline,'decline']])control.onclick=()=>run(async()=>{
    const response=await fetch('/owner/missed-'+path,{method:'POST'});
    if(!response.ok)throw Error(await response.text());
    show(await response.json());
  });
  button.onclick=()=>run(async()=>{
    clearInterval(missedPickupTimer);
    const scenario=$('#decline-all-recovery-offers').checked?'?decline=3':$('#decline-second-recovery-offer').checked?'?decline=2':$('#decline-recovery-offer').checked?'?decline=1':$('#recover-with-driver').checked?'?accept=1':'';
    const update=async method=>{
      const response=await fetch(url+scenario,{method});
      if(!response.ok)throw Error('Missed pickup test unavailable.');
      const status=await response.json();
      show(status);
      if(status.attention||status.status==='accepted')clearInterval(missedPickupTimer);
    };
    await update('POST');
    missedPickupTimer=setInterval(()=>run(()=>update('GET')),500);
  });
}
function liveFleetProgress(){
  if(location.pathname!=='/owner/'||location.port!=='4781')return '';
  const rides=state.trips.filter(ride=>ride.reference.startsWith('TEST284-'));
  if(!rides.length)return '<button class="btn" type="button" id="start-live-284">Start 284-ride dispatch</button>';
  const count=status=>rides.filter(ride=>ride.status===status).length;
  const completed=count('completed'), attention=count('needs_reassignment');
  const resolved=completed+attention, running=resolved<rides.length;
  return '<section class="live-fleet-progress" aria-label="284-ride test progress">'+
    '<div class="fleet-progress-top"><span class="fleet-run-state '+(running?'is-running':'')+'">'+
    (running?'Dispatch running':'Run finished')+'</span><strong>'+resolved+' / '+rides.length+' processed</strong></div>'+
    '<progress aria-label="Rides processed" value="'+resolved+'" max="'+rides.length+'"></progress>'+
    '<div class="fleet-progress-counts"><span><b>'+completed+'</b> completed</span><span><b>'+count('offered')+
    '</b> offers pending</span><span><b>'+attention+'</b> need attention</span><span><b>'+
    rides.filter(ride=>!ride.driverId).length+'</b> unassigned</span></div></section>';
}
const fleetMetricHistory = new Map();
function fleetMetricTrend(kind, count) {
  const key = fleetSource + ':' + (queueRun(fleetSource) || '') + ':' + kind;
  const samples = fleetMetricHistory.get(key) || [];
  if (samples.at(-1)?.value !== count) {
    samples.push({value:count});
    if (samples.length > 16) samples.shift();
    fleetMetricHistory.set(key,samples);
  }
  const peak = Math.max(1,...samples.map(sample=>sample.value));
  const points = samples.map((sample,index)=>
    (100*index/Math.max(1,samples.length-1)).toFixed(1)+','+(23-20*sample.value/peak).toFixed(1));
  if (points.length===1) {
    const [,y] = points[0].split(',');
    return '<svg class="live-metric-trend" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true"><circle cx="97" cy="'+y+'" r="2"/></svg>';
  }
  return '<svg class="live-metric-trend" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">'+
    '<polygon points="0,26 '+points.join(' ')+' 100,26"/><polyline points="'+points.join(' ')+'"/></svg>';
}
let mongoDispatchStarting = false;
function mongoDispatchControls() {
  if (!mongoLiveReplay()) return '';
  const replay = state.lgtcReplay;
  const rides = replay ? state.trips.filter(ride=>ride.demoRunId===replay.runId) : [];
  const progress = replay ? rides.filter(ride=>ride.status==='completed').length+' / '+rides.length+
    ' completed · '+rides.filter(ride=>ride.status==='offered').length+' offers pending · '+replay.held+' in Owner review' : '';
  return '<button type="button" class="btn primary" id="start-mongo-dispatch" '+(replay?.running||mongoDispatchStarting?'disabled':'')+'>'+
    (replay?.running?'Dispatch running':'Start local dispatch')+'</button>'+
    (replay ? '<p role="status">'+esc(replay.error||progress)+'</p>' : '') +
    (config.mongoReplay && replay ? '<button type="button" class="btn small" id="mongo-owner-review">View Owner review</button>' : '');
}
function fleetNow() {
  return fleetSource === 'test:'+state?.lgtcReplay?.runId ? state.lgtcReplay.at : lastSnapshotAt || Date.now();
}
function overview() {
  if(location.hash==='#acceptance-test'){dispatchSearch='DUAL-ACCEPT-TEST';dispatchView='now';}
  const now = fleetNow();
  const fleet = ProLiftBoard.fleet(state, now).filter(i => matchesFleetSource(i.driver));
  const lists = queueFor(fleetSource, now), total = queueTotal(lists), visible=visibleDispatchQueue(lists), rows=visible[dispatchView];
  const pages = Math.max(1, Math.ceil(rows.length / queuePageSize));
  dispatchPage = Math.min(dispatchPage, pages);
  const runId=queueRun(fleetSource);
  const selected=state.trips.find(t=>t.id===focusedRideId&&(t.demoRunId||null)===runId);
  const identity = fleetIdentity(fleetSource);
  const tabs = [['now','Now'],['later','Later'],['attention','Attention']].map(([key,label]) =>
    '<button data-dispatch-view="' + key + '" class="' + (dispatchView === key ? 'selected' : '') +
    '" aria-pressed="' + (dispatchView === key) + '">' + label + ' <span>' + visible[key].length + '</span></button>').join('');
  const list = rows.length ? rows.slice((dispatchPage - 1) * queuePageSize, dispatchPage * queuePageSize).map(t => dispatchRideRow(t, now)).join('') :
    '<div class="dispatch-empty">' + (dispatchSearch?'<h3>No matching rides in this queue</h3><p>Check another queue or clear the search.</p>':dispatchEmpty(total)) + '</div>';
  const paging = pages > 1 ? '<div class="dispatch-paging"><button class="btn small" data-dispatch-page="' + (dispatchPage - 1) +
    '" ' + (dispatchPage === 1 ? 'disabled' : '') + '>Previous</button><small>' + dispatchPage + ' / ' + pages +
    '</small><button class="btn small" data-dispatch-page="' + (dispatchPage + 1) + '" ' + (dispatchPage === pages ? 'disabled' : '') + '>Next</button></div>' : '';
  const activeTrips = [...lists.now, ...lists.later, ...lists.attention]
    .filter(t => ['accepted','heading_to_pickup','arrived','onboard'].includes(t.status));
  const metrics = [
    ['available','Available drivers',fleet.filter(i => i.status === 'available').length,'car'],
    ['riding','On trip',activeTrips.length,'map'],
    ['waiting','Waiting requests',[...lists.now,...lists.later].filter(t => ['awaiting_driver','offered','needs_reassignment'].includes(t.status)).length,'clock'],
    ['attention','Needs attention',lists.attention.length,'flag']
  ];
  const summary = '<section class="live-metrics" aria-label="Fleet totals">'+metrics.map(([kind,label,count,symbol]) =>
    '<button type="button" class="live-metric '+kind+'" data-live-total="'+kind+'"><span class="live-metric-icon" aria-hidden="true">'+icon(symbol)+'</span><div><strong>'+count+'</strong><span>'+label+'</span>'+fleetMetricTrend(kind,count)+'</div></button>').join('')+'</section>';
  const imported = config.importedFleetCounts;
  const importedSummary = imported ? '<div class="imported-fleet-summary"><span><strong>Imported fleet</strong> · '+
    imported.drivers+' driver records · '+imported.vehicles+' vehicle records</span>'+
    '<button type="button" class="btn small" data-owner-nav="drivers">Fleet records</button></div>' : '';
  const activeBoard = '<section class="live-active-board"><h2>Active trips</h2>'+
    (activeTrips.length ? '<div class="live-active-scroll"><table><thead><tr><th>Trip</th><th>Driver</th><th>Pickup</th><th>Drop-off</th><th>Status</th></tr></thead><tbody>'+
      activeTrips.map(t=>'<tr><td><button class="btn small active-trip-link" data-detail="'+esc(t.id)+'">'+esc(t.reference)+'</button></td><td>'+
        fleetDriverAvatar(state.drivers.find(d=>d.id===t.driverId)) + esc(state.drivers.find(d=>d.id===t.driverId)?.name||'—')+'</td><td>'+esc(t.pickup)+'</td><td>'+esc(t.destination)+'</td><td>'+badge(t.status)+'</td></tr>').join('')+
      '</tbody></table></div>' : '<p>No trips in progress.</p>')+'</section>';
  return '<div class="live-dashboard"><div class="dispatch-command fleet-theme-' + identity.theme + '"><section class="dispatch-toolbar"><div class="dispatch-title"><div><h1>Live fleet</h1>' + dispatchIndicator() + liveFleetProgress() + mongoDispatchControls() + (config.mongoOwnerRecords ? '<a class="btn small" href="/owner/records?show=lgtc_rides">View imported MongoDB records</a>' : '') +
    (location.pathname==='/owner/'&&location.port==='4781'?'<details class="missed-pickup-demo" '+($('#missed-pickup-test')?.open?'open':'')+' id="missed-pickup-test"><summary>Missed pickup test</summary><label><input type="checkbox" id="recover-with-driver"> Bring a test driver online at minute 8</label> <label><input type="checkbox" id="decline-recovery-offer"> Maya declines the first offer</label> <label><input type="checkbox" id="decline-second-recovery-offer"> Maya and James decline</label> <label><input type="checkbox" id="decline-all-recovery-offers"> All three drivers decline</label> <button class="btn small" id="start-missed-pickup">Start recovery test</button><button class="btn small" id="retry-missed-demo" hidden>Retry driver search</button> <button class="btn small" id="accept-missed-demo" hidden>Accept as Jordan</button> <button class="btn small" id="decline-missed-demo" hidden>Decline as Jordan</button><button class="btn small" id="missed-group-test">Test five eligible drivers</button><p id="missed-pickup-progress" role="status">'+esc(missedPickupProgress)+'</p></details>':'') +
    '</div></div><button class="btn primary" id="add-planned-ride">'+icon('plus')+' New booking</button></section>' + summary + importedSummary +
    (mongoLiveReplay() ? '' : '<div class="dispatch-rail">' + dispatchFleetPicker() + '</div>') + '</div>' +
    (!['device','sample','test:mongo-lgtc-replay'].includes(fleetSource)?'<aside class="queue-test-notice"><p><strong>Test data</strong> · '+esc(identity.label)+' is selected.'+
      (fleetSource==='queue-review'?' Starts with 50 Now, 50 Later and 50 Attention.':'')+'</p>'+
      (fleetSource==='queue-review'?'<button class="btn small" data-queue-review="restart">Start fresh test</button>':'')+
      '<button class="btn small" data-dispatch-fleet="device">Back to Ordinary fleet</button></aside>':'')+
    (mongoLiveReplay() ? '' : '<details class="live-filter-disclosure" '+ (document.querySelector('.live-filter-disclosure')?.open || dispatchSearch || dutyFilter !== 'all' || vehicleFocusId ? 'open' : '') +'><summary>Search &amp; filters</summary><div class="avl-filter-bar"><form id="dispatch-search" class="dispatch-search"><label for="avl-ride-query">Find a ride</label><input id="avl-ride-query" name="query" type="search" maxlength="120" placeholder="Ride, rider, driver or stop" value="'+esc(dispatchSearch)+'"><button class="btn small">Find</button>'+
    '</form><div class="avl-fleet-controls"><label>Status<select id="avl-status">' +
    [['all','All vehicles'],['online','Available'],['busy','On a ride'],['offline','Offline'],['gps','Location needs attention']].map(([key,label]) =>
      '<option value="'+key+'" '+(dutyFilter===key?'selected':'')+'>'+label+'</option>').join('') +
    '</select></label><label>Vehicle<select id="avl-vehicle"><option value="">Choose a vehicle</option>' +
    fleet.map(({driver}) => '<option value="'+esc(driver.id)+'" '+(vehicleFocusId===driver.id?'selected':'')+'>'+
      esc(driver.name+' · '+driver.vehicle+' · '+driver.plate)+'</option>').join('') +
    '</select></label><button type="button" class="btn small" id="avl-reset">Reset filters</button></div></div></details>') +
    '<div class="dispatch-workspace avl-workspace"><section id="fleet-map" class="dispatch-map fleet-map-panel">' +
    '<div class="dispatch-map-title"><div><h2>Fleet map</h2><small>' + esc(identity.detail) + '</small></div>' + fleetBadge(identity) + '</div>' +
    liveFleetMap(fleet.filter(fleetRowMatches),null) + activeBoard + '</section>' +
    '<div class="live-dispatch-side"><aside id="ride-queue" class="dispatch-queue fleet-theme-' + identity.theme + '"><header><div><h2 tabindex="-1">' + icon('flag') + ' Ride queue</h2>' + fleetBadge(identity) +
    '</div><div class="queue-header-actions"><strong>' + (dispatchSearch?queueTotal(visible)+' of ':'') + total + ' open</strong></div></header>'+
    '<div class="dispatch-tabs">' + tabs +
    '</div>' + (selected?selectedDispatchRide(selected,now):'') + '<div class="dispatch-queue-rows">' + list + '</div>' + paging + latestCompletion() + '</aside>' + dispatchFleetStatus() + '</div></div></div>';
}
function sourceForTrip(trip) {
  if (!trip.demoRunId) {
    if (trip.lgtc?.test) {
      const pending = state.offers.find(o=>o.tripId===trip.id&&o.status==='pending'&&o.expiresAt>Date.now());
      const driver = state.drivers.find(d=>d.id===(trip.driverId || pending?.driverId || trip.plannedDriverId));
      if (driver) return driver.locationSource === 'device' ? 'device' : 'sample';
    }
    return fleetSource === 'sample' ? 'sample' : 'device';
  }
  return testQueueOptions().find(([, , run]) => run === trip.demoRunId)?.[0];
}
function canShowInDispatch(trip) {
  return active(trip) && !trip.poolParentId && sourceForTrip(trip);
}
function fitFocusedRide() {
  const trip = state.trips.find(t => t.id === focusedRideId);
  if (!geoMap || !trip) return false;
  const points = [trip.status === 'onboard' ? trip.destination : trip.pickup, trip.destination]
    .map(name => config.places.find(place => place.name === name)).filter(Boolean).map(p => [p.lat,p.lng]);
  const driver = state.drivers.find(d=>d.id===trip.driverId&&matchesFleetSource(d));
  if (Number.isFinite(driver?.lat) && Number.isFinite(driver?.lng)) points.push([driver.lat,driver.lng]);
  if (!points.length) return false;
  geoMap.fitBounds(points, { padding:[80,80], maxZoom:15, animate:false });
  return true;
}
function focusDispatchRide(id, fromMap=false) {
  const trip = state.trips.find(t => t.id === id);
  if (!trip || !canShowInDispatch(trip)) return;
  const source = sourceForTrip(trip);
  if (fleetSource !== source) changeFleetSource(source);
  const now = Date.now();
  const nextView = ProLiftBoard.dispatchBucket(trip, now, dispatchLead());
  const queue=queueFor(source,now);
  let index=visibleDispatchQueue(queue)[nextView].findIndex(t=>t.id===id);
  if(index===-1&&dispatchSearch){
    dispatchSearch='';
    index=queue[nextView].findIndex(t=>t.id===id);
  }
  if (index === -1) return;
  const leavingBookings = tab !== 'overview';
  stopVehicleFollow();
  vehicleFocusId=null;
  tab = 'overview';
  focusedRideId = id;
  selectedDriverId = trip.driverId || null;
  dispatchView = mapPriorityFilter = nextView;
  dispatchPage = Math.floor(index / queuePageSize) + 1;
  render();
  fitFocusedRide();
  if(fromMap&&matchMedia('(max-width: 760px)').matches) $('#ride-queue h2')?.focus();
  else if (leavingBookings) window.scrollTo(0, 0);
}
function fleetDetails(item,labels) {
  if (!item) return '<div class="empty"><p>No phone is sharing a location yet. Start location sharing in the driver app.</p></div>';
  const d=item.driver,t=item.trip,offered=item.offer&&state.trips.find(t=>t.id===item.offer.tripId);
  if(d.locationSource==='replay'){const r=state.trackingReplay;return '<div class="fleet-person"><span class="avatar large">GPS</span><h2>TEST · Moving driver</h2><p>Dummy coordinates · no real phone</p><span class="badge offered">'+esc(r?.status||'test')+'</span></div><div class="location-details"><small>LAST VALIDATED TEST LOCATION</small><strong>'+d.lat.toFixed(5)+', '+d.lng.toFixed(5)+'</strong><span>'+Math.floor(item.age/1000)+' seconds ago · dummy coordinate replay</span></div><div class="selected-ride"><h3>'+Math.round((r?.progress||0)*100)+'% of test route</h3><p>'+ (r?.sequence||0)+' readings passed location validation and were sent to the live feed.</p><p>This driver cannot receive ordinary trips. Pause, resume or restart using the test controls.</p></div>';}
  const age=Math.floor(item.age/1000),seen=age<60 ? age+' seconds ago' : Math.floor(age/60)+' minutes ago';
  return '<div class="fleet-person"><span class="avatar large">'+esc(d.name.split(' ').map(x=>x[0]).join(''))+'</span><h2>'+esc(d.name)+'</h2><span class="fleet-state '+item.status+'"><i class="fleet-dot '+item.status+'"></i>'+labels[item.status]+'</span><p>'+esc(d.vehicle)+' · '+esc(d.plate)+'</p></div><div class="location-details"><small>LAST LOCATION</small><strong>'+esc(d.lat?.toFixed(5))+', '+esc(d.lng?.toFixed(5))+'</strong><span>'+seen+(item.status==='offline'?' · last known location':d.locationSource==='device'?' · phone GPS'+(d.trackingEnabled===false?' · sharing stopped':''):d.locationSource==='replay'?' · dummy coordinate replay':' · simulated GPS')+'</span></div><div class="selected-ride"><small>'+(t?'CURRENT RIDE':offered?'OFFER SENT':'CURRENT WORK')+'</small>'+(t?'<h3>'+esc(t.reference)+'</h3>'+tripFacts(t,d)+'<p><strong>'+esc(t.pickup)+'</strong><br>↓<br>'+esc(t.destination)+'</p>'+badge(t.status)+'<p>Pickup '+time(t.pickupAt)+' · '+esc(t.customerName)+'</p><button class="btn full" data-detail="'+t.id+'">View ride</button>':offered?'<h3>'+esc(offered.pickup)+'</h3><p>Waiting for this driver to accept.<br>Pickup '+time(offered.pickupAt)+'</p><button class="btn full" data-detail="'+offered.id+'">View offer</button>':'<h3>'+(item.status==='available'?'Ready for the next pickup':item.status==='offline'?'Off duty':'Location update needed')+'</h3><p>'+(item.status==='available'?'The system will offer a suitable nearby trip when its pickup time approaches.':'This driver is not eligible for new automatic offers right now.')+'</p>')+'</div>';
}
let fleetMapTheme = 'night';
try { if (localStorage.getItem('royalcab.map-theme') === 'day') fleetMapTheme = 'day'; } catch {}
function liveFleetMap(items,selected){return '<div class="geo-map-wrap">'+mapPriorityLegend()+'<div id="geo-fleet-map" role="region" aria-label="Geographic fleet map" data-map-theme="'+fleetMapTheme+'"></div><ul class="live-vehicle-legend" aria-label="Vehicle marker colors"><li>Available</li><li>On trip</li><li>Near drop-off</li><li>Offer pending</li><li>Offline / GPS stale</li></ul><div class="geo-map-actions"><div class="fleet-map-theme" role="group" aria-label="Map appearance"><button type="button" data-map-theme-choice="day">Day</button><button type="button" data-map-theme-choice="night">Night</button></div><button class="btn small" id="fit-geo-fleet">Show vehicles</button><button class="btn small" id="fit-priority-map">Show priority rides</button><span>'+ (fleetSource==='scenario'?'4 TEST CARS':fleetSource==='device'?'PHONE GPS':fleetSource==='replay'?'DUMMY COORDINATES':'SAMPLE POSITIONS')+'</span></div>'+(!items.some(i=>i.hasLocation)?(fleetSource==='device'?'<div class="geo-empty"><strong>No phone locations yet</strong><span>Drivers can share their location from My work.</span></div>':'<div class="geo-empty"><strong>No vehicle positions for this fleet</strong></div>'):'')+'<div id="geo-map-status" role="status"></div></div>';}
function bookingScopeOptions() {
  const scopes = [['all', 'All records'], ['live', 'Ordinary bookings']];
  for (const [source, label, run] of testQueueOptions()) scopes.push([run, source === 'volume' ? '500-trip test dataset' : label]);
  if (!scopes.some(([key]) => key === tripDataScope)) scopes.push([tripDataScope, 'Previous test']);
  return scopes.map(([key, label]) => '<option value="' + esc(key) + '" ' + (tripDataScope === key ? 'selected' : '') + '>' + label + '</option>').join('');
}
const tripFilters = { date:'', driver:'', service:'', source:'', willCall:'', rider:'', reference:'' };
const tripDateEastern = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'});
function selectTripWorkspace(page = boardPage, pageSize = 25){
 const filteredTrips = state.trips.filter(ride =>
   (!tripFilters.willCall || Boolean(ride.willCall) === (tripFilters.willCall === 'yes')) &&
   (!tripFilters.reference || ride.reference.toLowerCase().includes(tripFilters.reference.trim().toLowerCase())) &&
   (!tripFilters.rider || ride.customerName.toLowerCase().includes(tripFilters.rider.trim().toLowerCase())) &&
   (!tripFilters.date || Number.isFinite(ride.pickupAt) && tripDateEastern.format(ride.pickupAt) === tripFilters.date) &&
   (!tripFilters.driver || [ride.driverId,ride.reservedDriverId,ride.plannedDriverId].includes(tripFilters.driver) ||
     state.offers.some(offer => offer.tripId === ride.id && offer.driverId === tripFilters.driver && offer.status === 'pending' && offer.expiresAt > Date.now())) &&
   (!tripFilters.service || (ride.requirements?.includes('wheelchair') ? 'accessible' : 'standard') === tripFilters.service) &&
   (!tripFilters.source || (ride.lgtc ? 'lgtc' : ride.demoRunId || ride.testData ? 'sample' : 'booking') === tripFilters.source));
 return ProLiftBoard.select(filteredTrips,{scope:tripDataScope,filter,search,page,pageSize,drivers:state.drivers,order:filter==='upcoming'&&bookingOrder==='past'?'next':bookingOrder,now:lastSnapshotAt||Date.now(),leadMinutes:dispatchLead()});
}
function filteredTripsCsv() {
  const {rows} = selectTripWorkspace(1, Math.max(1,state.trips.length));
  if (!rows.length) return;
  const cell = value => {
    const raw = String(value ?? '');
    const safe = /^[\s]*[=+@-]|^[\t\r\n]/.test(raw) ? "'" + raw : raw;
    return '"' + safe.replace(/"/g,'""') + '"';
  };
  const records = [['Trip ID','Rider','Status','Driver','Pickup (ISO UTC)','Planned drop-off (ISO UTC)','Pickup','Destination','Service','Source','Will-call']];
  const iso = timestamp => Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
  for (const ride of rows) {
    const driver = state.drivers.find(candidate => candidate.id === (ride.driverId || ride.reservedDriverId || ride.plannedDriverId));
    records.push([ride.reference,ride.customerName,labels[ride.status] || ride.status,driver?.name || ride.confirmedDriver?.name,
      iso(ride.pickupAt),iso(ride.plannedEndAt),ride.pickup,ride.destination,
      ride.requirements?.includes('wheelchair') ? 'Wheelchair accessible' : 'Standard',
      ride.lgtc ? 'LGTC' : ride.demoRunId || ride.testData ? 'Test data' : 'Other booking',
      ride.willCall ? 'Yes' : 'No']);
  }
  return records.map(row => row.map(cell).join(',')).join('\r\n');
}
const tripColumns = ['Pickup / end','Trip / customer','Journey','Service / source','Driver','Status'];
const tripViewStorage = 'royalcab-owner-trips-v1';
function readTripPreferences() {
  try { return JSON.parse(localStorage.getItem(tripViewStorage)) || {}; }
  catch { return {}; }
}
function tripWorkspaceControls() {
  const views = readTripPreferences().views || [];
  return '<div class="bookings-filters"><label>Saved views<select id="saved-trip-view"><option value="">Choose a saved view</option>'+views.map((view,index)=>'<option value="'+index+'">'+esc(view.name)+'</option>').join('')+'</select></label><button class="btn small" id="save-trip-view">Save current filters</button><button class="btn small" id="trip-columns">Columns</button></div>';
}
function bindTripPreferences() {
  const picker = $('#saved-trip-view');
  if (!picker) return;
  picker.onchange = () => {
    if (!picker.value) return;
    const view = readTripPreferences().views?.[Number(picker.value)];
    if (!view) return;
    for (const key of Object.keys(tripFilters)) tripFilters[key] = view.fields[key] || '';
    ({search,filter,bookingOrder,tripDataScope} = view);
    boardPage = 1;
    render();
    $('#saved-trip-view').value = picker.value;
  };
  $('#save-trip-view').onclick = () => {
    modal('<h2>Save current filters</h2><form id="save-trip-view-form"><label>View name<input name="name" required maxlength="60"></label><button class="btn primary">Save view</button></form>');
    $('#save-trip-view-form').onsubmit = event => {
      event.preventDefault();
      const name = new FormData(event.currentTarget).get('name').trim();
      if (!name) return;
      const preferences = readTripPreferences();
      const views = (preferences.views || []).filter(view=>view.name.toLowerCase()!==name.toLowerCase());
      views.push({name,fields:{...tripFilters},search,filter,bookingOrder,tripDataScope});
      localStorage.setItem(tripViewStorage,JSON.stringify({...preferences,views}));
      $('#modal').close();
      render();
      $('#saved-trip-view').value = String(views.length-1);
      toast('Trip view saved.');
    };
  };
  $('#trip-columns').onclick = () => {
    const preferences = readTripPreferences();
    modal('<h2>Trip columns</h2><form id="trip-column-form">'+tripColumns.map((label,index)=>'<label><input type="checkbox" name="column" value="'+index+'" '+((preferences.hidden || []).includes(index)?'':'checked')+'>'+esc(label)+'</label>').join('')+'<button class="btn primary">Apply columns</button></form>');
    $('#trip-column-form').onsubmit = event => {
      event.preventDefault();
      const visible = new Set(new FormData(event.currentTarget).getAll('column').map(Number));
      const hidden = tripColumns.map((_,index)=>index).filter(index=>!visible.has(index));
      localStorage.setItem(tripViewStorage,JSON.stringify({...preferences,hidden}));
      $('#modal').close();
      render();
    };
  };
  const table = $('#trip-results table');
  for (const index of readTripPreferences().hidden || []) {
    if (!Number.isInteger(index) || index < 0 || index >= tripColumns.length) continue;
    for (const row of table?.rows || []) row.cells[index+1].hidden = true;
  }
}
let mongoTrips, mongoTripRequest, mongoTripQuery='', mongoTripFilter='all', mongoTripPage=1;
let mongoTripPageSize=500;
let mongoTripWrap=true, mongoTripWidths={};
try {
  mongoTripWrap=localStorage.getItem('easyride-trip-wrap')!=='false';
  mongoTripWidths=JSON.parse(localStorage.getItem('easyride-trip-widths')||'{}');
  if(!mongoTripWidths || Array.isArray(mongoTripWidths) || typeof mongoTripWidths!=='object') mongoTripWidths={};
} catch {}
const expandedMongoTrips=new Set();
function mongoTripsEnabled() { return !!config.mongoOwnerRecords; }
const mongoSheetColumns = ["Driver","Trip Id","Status","Rider's Name","Level Of Service","PU - Schedule Time","DO - Schedule Time","PU - Full Street","PU - City","DO - Full Street","DO - City","Escorts","PU - Actual Time","DO - Actual Time","Miles","Age","Trip Source","Cancellation Reason Code","Rejection Reason Code","PU Ship To","DO Ship To","Actual Ride Duration"];
const mongoColumnLabels={"Rider's Name":"RIDER Name","PU - Schedule Time":"Time","PU - Full Street":"Pickup","DO - Schedule Time":"Drop off Time","DO - Full Street":"Destination"};
let mongoSelectedColumns = ["Trip Id","Status","Rider's Name","PU - Schedule Time","PU - Full Street","DO - Schedule Time","DO - Full Street","Miles"];
try {
  const saved=JSON.parse(localStorage.getItem('easyride-trip-columns'));
  if(Array.isArray(saved) && saved.length && saved.every(name=>mongoSheetColumns.includes(name))) mongoSelectedColumns=[...new Set(saved)];
} catch {}
if(!mongoSelectedColumns.includes('Trip Id')) mongoSelectedColumns.unshift('Trip Id');
function actualRideMinutes(start,end) {
  if (!start || !end) return null;
  const elapsed=(new Date(end).getTime()-new Date(start).getTime())/60000;
  return Number.isFinite(elapsed) && elapsed>=0 ? Math.round(elapsed*10)/10 : null;
}
function mongoColumnOptions() {
  const ordered=[...mongoSelectedColumns,...mongoSheetColumns.filter(name=>!mongoSelectedColumns.includes(name))];
  return ordered.map(name=>{
    const position=mongoSelectedColumns.indexOf(name);
    return '<div class="mongo-column-option"><label><input type="checkbox" data-trip-column="'+esc(name)+'" '+
      (position>=0?'checked ':'')+(name==='Trip Id'?'disabled ':'')+'>'+esc(mongoColumnLabels[name]||name)+'</label>'+
      (position>=0?'<span><button type="button" data-column-move="-1" data-column-name="'+esc(name)+'" aria-label="Move '+esc(name)+' up" '+(position===0?'disabled':'')+'>↑</button>'+
      '<button type="button" data-column-move="1" data-column-name="'+esc(name)+'" aria-label="Move '+esc(name)+' down" '+(position===mongoSelectedColumns.length-1?'disabled':'')+'>↓</button></span>':'')+'</div>';
  }).join('');
}
function mongoTripsPage() {
  return '<section class="bookings-panel" id="mongo-trips">'+
    '<input class="mongo-trip-search" type="search" id="mongo-trip-search" aria-label="Search trips" value="'+esc(mongoTripQuery)+'" placeholder="Search by ride ID or city">'+
    '<div class="bookings-filters"><h1>Trips</h1><label>Showing<select id="mongo-trip-page-size" aria-label="Trips per page">'+
    [25,50,100,200,500].map(size=>'<option'+(size===mongoTripPageSize?' selected':'')+'>'+size+'</option>').join('')+
    '</select></label><details class="mongo-trip-filter-menu"'+(mongoTripFilter==='all'?'':' open')+'><summary>Filter</summary>'+
    '<label>Review status<select id="mongo-trip-filter"><option value="all">All rides</option>'+
    '<option value="review">Owner review</option><option value="ready">Assigned in replay plan</option>'+
    '<option value="missing">Pickup time missing</option></select></label></details>'+
    '<details class="mongo-column-picker"><summary>Columns</summary><div aria-label="Trip columns">'+mongoColumnOptions()+'</div></details>'+
    '<label class="mongo-wrap-control"><input type="checkbox" id="mongo-trip-wrap" '+(mongoTripWrap?'checked':'')+'>Wrap text</label>'+
    '<button type="button" class="btn small" id="reload-mongo-trips">Refresh</button>'+
    '<button type="button" class="btn primary small" id="export-mongo-trips" disabled>Export CSV</button></div>'+
    '<p id="mongo-trips-status" role="status">Loading MongoDB rides…</p><div id="mongo-trips-results"></div></section>';
}
function mongoTripStage(ride) {
  const sourceStatus=String(ride.sourceStatus||ride.status||'').trim().toLowerCase();
  const known={'completed':'completed','dropoff completed':'completed','cancelled':'cancelled','canceled':'cancelled'};
  if(known[sourceStatus]) return badge(known[sourceStatus]);
  const replay=state?.lgtcReplay;
  const simulated=replay?.serviceDate===ride.date && state.trips.find(
    trip=>trip.demoRunId===replay.runId && trip.reference===ride.reference);
  if (['completed','cancelled'].includes(ride.status)) return badge(ride.status);
  if (simulated) return badge(simulated.status)+' <small>Replay</small>';
  return '<span class="badge">'+esc(ride.sourceStatus||'Status unavailable')+'</span>';
}
function mongoGroupStatus(rides) {
  const stages=rides.map(mongoTripStage);
  if(stages.every(stage=>stage===stages[0])) {
    return stages[0]+'<small class="mongo-status-legs">'+esc(rides.map(ride=>ride.leg).join(' / '))+'</small>';
  }
  return rides.map((ride,index)=>'<span class="mongo-trip-leg-status"><small>'+esc(ride.leg)+
    '</small>'+stages[index]+'</span>').join('');
}
async function openMongoTrip(id) {
  const {trip}=await api('/api/owner/mongo-trip?id='+encodeURIComponent(id));
  const address = fields => Array.isArray(fields) ? fields.filter(Boolean).join(', ') : fields;
  const fields=[
    ['Passenger',trip.passenger],['Passenger mobile',trip.phone],['Service date',trip.date],
    ['Pickup address',address(trip.pickupAddress)],['Drop-off address',address(trip.dropoffAddress)],
    ['Pickup time (ET)',trip.pickup],['Drop-off time (ET)',trip.dropoff],
    ['Distance (from workbook)',trip.miles==null ? 'Unavailable' : trip.miles+' mi'],
    ['Service code',trip.serviceCode],['Workbook row',trip.row]
  ];
  const held=mongoTrips?.review.find(ride=>ride.reference===trip.reference && (!ride.date || ride.date===trip.date));
  modal('<h2>'+esc(trip.reference)+'</h2><p>'+mongoTripStage(trip)+'</p>'+
    '<section class="notice"><strong>'+esc(trip.passenger || 'Passenger not provided')+'</strong><p>'+
    esc(address(trip.pickupAddress)||'Pickup address unavailable')+' → '+
    esc(address(trip.dropoffAddress)||'Drop-off address unavailable')+'</p></section>'+
    '<dl class="trip-facts">'+fields.map(([label,value])=>'<div><dt>'+esc(label)+'</dt><dd>'+
      esc(value==null||value===''?'—':value)+'</dd></div>').join('')+'</dl>'+
    (trip.instructions?'<h3>Workbook instructions</h3><p>'+esc(trip.instructions)+'</p>':'')+
    (held?'<h3>Owner review</h3><ul>'+held.reasons.map(reason=>'<li>'+esc(reason)+'</li>').join('')+'</ul>':''));
}
function bindMongoTrips() {
  const panel=$('#mongo-trips');
  if(!panel) return;
  const search=$('#mongo-trip-search'), filter=$('#mongo-trip-filter'), results=$('#mongo-trips-results');
  const status=$('#mongo-trips-status');
  filter.value=mongoTripFilter;
  const show=()=>{
    if(!mongoTrips || !panel.isConnected) return;
    const reasons=new Map(mongoTrips.review.map(ride=>[(ride.date||mongoTrips.plannedDate||'')+':'+ride.reference,ride.reasons]));
    const havePlan=mongoTrips.review.length>0 || !!mongoTrips.plannedDate;
    filter.options[1].disabled=filter.options[2].disabled=!havePlan;
    if(!havePlan && ['review','ready'].includes(filter.value)) filter.value=mongoTripFilter='all';
    const reviewFor=ride=>reasons.get(ride.date+':'+ride.reference);
    const query=mongoTripQuery.trim().toLowerCase();
    const groups=new Map();
    for(const ride of mongoTrips.rides) {
      const key=JSON.stringify([ride.program,ride.date,ride.group]);
      if(!groups.has(key)) groups.set(key,[]);
      groups.get(key).push(ride);
    }
    const matches=[...groups.entries()].filter(([,rides])=>rides.some(ride=>
      [ride.reference,ride.from,ride.to].join(' ').toLowerCase().includes(query) &&
      (mongoTripFilter==='all' || mongoTripFilter==='missing' && !ride.pickup ||
        mongoTripFilter==='review' && reviewFor(ride) ||
        mongoTripFilter==='ready' && ride.date===mongoTrips.plannedDate && !reviewFor(ride))));
    const perPage=mongoTripPageSize, pages=Math.max(1,Math.ceil(matches.length/perPage));
    const exportButton=panel.querySelector('#export-mongo-trips');
    exportButton.disabled=!matches.length;
    exportButton.onclick=()=>{
      const cell=value=>{
        const text=String(value??'');
        return '"'+(/^[\s]*[=+@-]|^[\t\r\n]/.test(text)?"'":"")+text.replaceAll('"','""')+'"';
      };
      const rows=[['Trip group','Ride ID','Leg','Service date','Pickup (ET)','From','To','Review status','Trip status']];
      const stage=document.createElement('span');
      for(const [,rides] of matches) for(const ride of rides) {
        stage.innerHTML=mongoTripStage(ride);
        rows.push([ride.group,ride.reference,ride.leg,ride.date,ride.pickup,ride.from,ride.to,
          reviewFor(ride)?.join(', ') || (ride.date===mongoTrips.plannedDate?'Assigned in replay plan':''),
          stage.textContent.trim()]);
      }
      const url=URL.createObjectURL(new Blob(['\uFEFF',rows.map(row=>row.map(cell).join(',')).join('\r\n')],{type:'text/csv;charset=utf-8'}));
      const link=document.createElement('a');
      link.href=url;
      link.download='easyride-trips.csv';
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(()=>URL.revokeObjectURL(url),30000);
    };
    mongoTripPage=Math.min(mongoTripPage,pages);
    const start=(mongoTripPage-1)*perPage;
    status.textContent=matches.length ? (start+1)+'–'+Math.min(start+perPage,matches.length)+' of '+matches.length+
      ' trips · '+mongoTrips.rides.length+' imported legs' : 'No matching trips · '+mongoTrips.rides.length+' imported legs';
    const columns=['Trip ID',...mongoSelectedColumns.filter(name=>name!=='Trip Id')];
    const address=value=>Array.isArray(value)?value.filter(Boolean).join(', '):value;
    const cells=(ride,status,review)=>{
      const linked=state?.trips.find(trip=>trip.reference===ride.reference);
      const driver=state?.drivers.find(driver=>driver.id===linked?.driverId);
      const events=(state?.events||[]).filter(event=>event.tripId===linked?.id);
      const duration=ride.actualDurationMinutes ?? actualRideMinutes(
        ride.sourceColumns?.['PU - Actual Time'] || events.find(event=>event.type==='trip.onboard')?.at,
        ride.sourceColumns?.['DO - Actual Time'] || linked?.completedAt);
      const values={
        ...ride.sourceColumns,
        Driver:driver?.name,Status:status,"Rider's Name":ride.passenger,
        "Level Of Service":ride.serviceCode,"PU - Schedule Time":ride.pickup,
        "DO - Schedule Time":ride.dropoff,"PU - Full Street":address(ride.pickupAddress),
        "PU - City":ride.from,"DO - Full Street":address(ride.dropoffAddress),"DO - City":ride.to,
        "Actual Ride Duration":duration===null?'—':duration+' min',
        Miles:ride.miles,"Trip Source":ride.program
      };
      return columns.slice(1).map(name=>'<td data-label="'+esc(mongoColumnLabels[name]||name)+'">'+
        (name==='Status'?status+(review?'<small class="mongo-trip-review">'+esc(review)+'</small>':''):
          esc(values[name]??ride.sourceColumns?.[name]??'—'))+'</td>').join('');
    };
    const legRow=(ride,child=false)=>{
      const review=reviewFor(ride);
      return '<tr class="'+(child?'mongo-trip-leg':'')+'" data-mongo-trip-id="'+esc(ride.id)+'"><td><button class="text-btn" type="button" title="'+esc(ride.reference)+'">'+
        (child&&ride.leg?'Leg '+esc(ride.leg):esc(ride.reference))+'</button></td>'+
        cells(ride,'<span data-mongo-trip-stage>'+mongoTripStage(ride)+'</span>',
          review?.join(', ') || (ride.date===mongoTrips.plannedDate?'Assigned in replay plan':''))+'</tr>';
    };
    const rows=matches.slice(start,start+perPage).map(([key,rides])=>{
      if (rides.length===1) return legRow(rides[0]);
      rides.sort((a,b)=>a.reference.localeCompare(b.reference));
      const [first]=rides;
      const open=expandedMongoTrips.has(key);
      const pending=rides.filter(reviewFor).length;
      const statuses='<span class="mongo-group-status" data-group-rides="'+esc(JSON.stringify(rides.map(ride=>ride.id)))+'">'+mongoGroupStatus(rides)+'</span>';
      const parent='<tr class="mongo-trip-group"><td><button class="text-btn" type="button" aria-expanded="'+open+
        '" data-mongo-trip-group="'+esc(key)+'">'+(open?'▾ ':'▸ ')+esc(first.group)+
        ' <small>· '+rides.length+' legs</small></button></td>'+
        cells(first,statuses,pending?pending+' need review':'')+'</tr>';
      return parent+(open?rides.map(ride=>legRow(ride,true)).join(''):'');
    }).join('');
    results.innerHTML=rows?'<div class="table-scroll"><table><thead><tr>'+
      columns.map(label=>'<th scope="col">'+esc(mongoColumnLabels[label]||label)+'</th>').join('')+'</tr></thead><tbody>'+rows+'</tbody></table></div>'+
      '<nav class="pagination" aria-label="MongoDB trips pages"><button class="btn small" data-mongo-trip-step="-1" '+(mongoTripPage===1?'disabled':'')+
      '>Previous</button><span>Page '+mongoTripPage+' of '+pages+'</span><button class="btn small" data-mongo-trip-step="1" '+
      (mongoTripPage===pages?'disabled':'')+'>Next</button></nav>':'';
    reorderRows();
    const table=results.querySelector('table');
    if(table) {
      table.classList.toggle('mongo-wrap-text',mongoTripWrap);
      const group=document.createElement('colgroup');
      const widths=mongoSelectedColumns.map(name=>{
        const saved=Number(mongoTripWidths[name]);
        return Number.isFinite(saved)&&saved>=90&&saved<=700?saved:
          /Street|Ship To/.test(name)?230:name==='Trip Id'?220:150;
      });
      const setWidths=()=>{
        [...group.children].forEach((col,index)=>col.style.width=widths[index]+'px');
        table.style.width=widths.reduce((total,width)=>total+width,0)+'px';
      };
      widths.forEach(()=>group.append(document.createElement('col')));
      table.prepend(group);
      setWidths();
      table.querySelectorAll('th').forEach((header,index)=>{
        const handle=document.createElement('button');
        handle.type='button';
        handle.className='mongo-column-resize';
        const name=mongoSelectedColumns[index];
        handle.setAttribute('aria-label','Resize '+(mongoColumnLabels[name]||name)+' column');
        const saveWidth=()=>{try{localStorage.setItem('easyride-trip-widths',JSON.stringify(mongoTripWidths));}catch{}};
        const resize=width=>{
          widths[index]=Math.max(90,Math.min(700,width));
          mongoTripWidths[name]=widths[index];
          setWidths();
        };
        handle.onpointerdown=event=>{
          if(event.button!==0)return;
          event.preventDefault();
          const initialX=event.clientX, initialWidth=widths[index];
          handle.setPointerCapture(event.pointerId);
          handle.onpointermove=move=>resize(initialWidth+move.clientX-initialX);
          const finish=()=>{
            handle.onpointermove=null;
            handle.onpointerup=handle.onpointercancel=null;
            saveWidth();
          };
          handle.onpointerup=handle.onpointercancel=finish;
        };
        handle.onkeydown=event=>{
          if(!['ArrowLeft','ArrowRight'].includes(event.key))return;
          event.preventDefault();
          resize(widths[index]+(event.key==='ArrowRight'?10:-10));
          saveWidth();
        };
        header.append(handle);
      });
    }
  };
  const reorderRows=()=>{
    const order=['Trip Id',...mongoSelectedColumns.filter(name=>name!=='Trip Id')];
    results.querySelectorAll('tr').forEach(row=>{
      const cells=[...row.children];
      for(const name of mongoSelectedColumns) {
        const cell=cells[order.indexOf(name)];
        if(cell) row.append(cell);
      }
    });
  };
  const load=async()=>{
    try {
      if(!mongoTripRequest) mongoTripRequest=api('/api/owner/mongo-trips').finally(()=>{mongoTripRequest=null;});
      mongoTrips=await mongoTripRequest;
      show();
    } catch(error) { if(panel.isConnected) status.textContent=error.message; }
  };
  search.oninput=()=>{mongoTripQuery=search.value;mongoTripPage=1;show();};
  filter.onchange=()=>{mongoTripFilter=filter.value;mongoTripPage=1;show();};
  $('#mongo-trip-wrap').onchange=event=>{
    mongoTripWrap=event.target.checked;
    try {localStorage.setItem('easyride-trip-wrap',String(mongoTripWrap));} catch {}
    show();
  };
  const columnList=panel.querySelector('[aria-label="Trip columns"]');
  const saveColumns=()=>{
    try {localStorage.setItem('easyride-trip-columns',JSON.stringify(mongoSelectedColumns));} catch {}
    columnList.innerHTML=mongoColumnOptions();
    show();
  };
  columnList.onchange=event=>{
    const input=event.target.closest('[data-trip-column]');
    if(!input) return;
    const name=input.dataset.tripColumn;
    mongoSelectedColumns=input.checked?[...mongoSelectedColumns,name]:mongoSelectedColumns.filter(column=>column!==name);
    saveColumns();
  };
  columnList.onclick=event=>{
    const button=event.target.closest('[data-column-move]');
    if(!button) return;
    const current=mongoSelectedColumns.indexOf(button.dataset.columnName);
    const next=current+Number(button.dataset.columnMove);
    if(current<0 || next<0 || next>=mongoSelectedColumns.length) return;
    [mongoSelectedColumns[current],mongoSelectedColumns[next]]=[mongoSelectedColumns[next],mongoSelectedColumns[current]];
    saveColumns();
    [...columnList.querySelectorAll('[data-column-move]')].find(item=>
      item.dataset.columnName===button.dataset.columnName && item.dataset.columnMove===button.dataset.columnMove)?.focus();
  };
  $('#mongo-trip-page-size').onchange=event=>{mongoTripPageSize=Number(event.target.value);mongoTripPage=1;show();};
  results.onclick=event=>{
    const button=event.target.closest('[data-mongo-trip-step]');
    if(button){mongoTripPage+=Number(button.dataset.mongoTripStep);show();return;}
    const group=event.target.closest('[data-mongo-trip-group]');
    if(group){
      const key=group.dataset.mongoTripGroup;
      if(!expandedMongoTrips.delete(key)) expandedMongoTrips.add(key);
      show();
      [...results.querySelectorAll('[data-mongo-trip-group]')].find(el=>el.dataset.mongoTripGroup===key)?.focus();
      return;
    }
    const row=event.target.closest('tr[data-mongo-trip-id]');
    if(row) run(()=>openMongoTrip(row.dataset.mongoTripId));
  };
  $('#reload-mongo-trips').onclick=load;
  if(mongoTrips) show();
  void load();
}
function tripsPage(){
 if(mongoTripsEnabled()) return mongoTripsPage();
 const view=selectTripWorkspace();boardPage=view.page;
 const options = (key,entries) => entries.map(([value,label]) =>
   '<option value="'+esc(value)+'"'+(tripFilters[key]===value?' selected':'')+'>'+esc(label)+'</option>').join('');
 const fields = '<div class="bookings-filters trips-field-grid"><label>Trip ID<input type="search" data-trip-field="reference" value="'+esc(tripFilters.reference)+'"></label><label>Rider name<input type="search" data-trip-field="rider" value="'+esc(tripFilters.rider)+'"></label><label>Will-call<select data-trip-field="willCall">'+options('willCall',[['','All rides'],['yes','Will-call only'],['no','Confirmed time']])+'</select></label><label>Trip date (ET)<input type="date" data-trip-field="date" value="'+esc(tripFilters.date)+'"></label>'+
   '<label>Driver<select data-trip-field="driver">'+options('driver',[['','All drivers'],...state.drivers.map(d=>[d.id,d.name])])+'</select></label>'+
   '<label>Service<select data-trip-field="service">'+options('service',[['','All services'],['standard','Standard'],['accessible','Wheelchair accessible']])+'</select></label>'+
   '<label>Source<select data-trip-field="source">'+options('source',[['','All sources'],['lgtc','LGTC'],['booking','Other bookings'],['sample','Test data']])+
   '</select></label><button type="button" class="btn small" id="reset-trip-filters">Reset filters</button></div>';
 return '<section class="simple-page-head"><div><h1>Trips</h1><p>'+view.counts.all+' records</p></div><div></div></section>'+ '<section class="bookings-panel trips-workspace">'+tripWorkspaceControls()+fields+'<div class="bookings-filters"><label class="search">'+icon('search')+'<input id="trip-search" type="search" placeholder="Customer, mobile or booking" aria-label="Search trips" value="'+esc(search)+'"></label><select id="booking-order" aria-label="Pickup order">' + [['next','Next pickup first'],['latest','Latest pickup first'],['past','Past trips only']].map(([key,label]) => '<option value="'+key+'" '+(bookingOrder===key?'selected':'')+'>'+label+'</option>').join('') + '</select><select id="booking-status" aria-label="Booking status">'+[['all','All statuses'],['upcoming','Upcoming'],['waiting','Waiting'],['offered','Offer sent'],['assigned','Assigned'],['attention','Needs attention'],['completed','Completed'],['cancelled','Cancelled']].map(([key,label])=>'<option value="'+key+'" '+(filter===key?'selected':'')+'>'+label+'</option>').join('')+'</select><select id="trip-data-scope" aria-label="Booking records">'+bookingScopeOptions()+'</select></div><div class="bookings-filters trips-actions"><button type="button" class="btn small" id="refresh-trip-list">Refresh list</button>'+(view.total?'<button type="button" class="btn small" id="export-trip-list">Export filtered CSV</button>':'<button class="btn small" disabled>Export filtered CSV</button>')+'<span id="bulk-trip-count" aria-live="polite">0 selected</span><button class="btn small" data-bulk-action="assign" disabled>Assign driver</button><button class="btn small" data-bulk-action="unassign" disabled>Unassign driver</button><button class="btn small" data-bulk-action="will-call" disabled>Update will-call</button></div><div id="trip-results">'+simpleTripTable(view.rows)+'</div><div class="pagination"><span>'+view.start+'–'+view.end+' of '+view.total+'</span><button class="btn small" data-board-page="'+(view.page-1)+'" '+(view.page<=1?'disabled':'')+'>Previous</button><small>'+view.page+' / '+view.pages+'</small><button class="btn small" data-board-page="'+(view.page+1)+'" '+(view.page>=view.pages?'disabled':'')+'>Next</button></div></section>';
}
function openBulkTripAction(action) {
  const ids = [...document.querySelectorAll('[data-bulk-trip]:checked')].map(input => input.value);
  const title = {assign:'Assign driver',unassign:'Unassign driver','will-call':'Update will-call'}[action];
  if (!ids.length) return;
  modal('<h2>'+title+'</h2><p>'+ids.length+' selected rides</p><form id="bulk-trip-form">'+
    (action === 'assign' ? '<label>Driver<select name="driverId" required><option value="">Choose driver</option>'+
      state.drivers.map(driver=>'<option value="'+esc(driver.id)+'">'+esc(driver.name)+'</option>').join('')+
      '</select></label><p>Future rides are reserved. Drivers accept offers when dispatch opens.</p>' :
      action === 'will-call' ? '<label>Confirmed pickup (device local time)<input name="pickup" type="datetime-local"></label><p>Leave blank to mark as will-call. Enter a time to confirm pickup for every selected will-call ride.</p>' :
      '<p>Remove the assignment or offer and pause automatic dispatch for these rides.</p>')+
    '<button class="btn primary" type="submit">'+title+'</button></form>');
  $('#bulk-trip-form').onsubmit = event => {
    event.preventDefault();
    const fields = new FormData(event.currentTarget), button = event.submitter;
    button.disabled = true;
    run(async () => {
      try {
        const pickup = fields.get('pickup');
        if (pickup && !Number.isFinite(Date.parse(pickup))) throw Error('Choose a valid pickup time.');
        const result = await api('/api/trips/bulk',{action,ids,driverId:fields.get('driverId'),pickupAt:pickup ? Date.parse(pickup) : null});
        $('#modal').close();
        await refresh();
        toast(result.count+' rides updated.');
      } finally { button.disabled = false; }
    });
  };
}
function simpleTripTable(trips) {
  if (!trips.length) return '<div class="empty"><h3>No trips in this group</h3><p>Choose another group or import your planned rides.</p></div>';
  return '<div class="table-scroll"><table class="simple-trips"><thead><tr><th><input type="checkbox" id="bulk-trip-all" aria-label="Select rides on this page"></th><th>Pickup / end</th><th>Trip / customer</th><th>Journey</th><th>Service / source</th><th>Driver</th><th>Status</th><th></th></tr></thead><tbody>' + trips.map(t => {
    const g = ProLiftBoard.group(t,Date.now(),dispatchLead()), pending = state.offers.find(o => o.tripId === t.id && o.status === 'pending' && o.expiresAt > Date.now());
    const d = state.drivers.find(d => d.id === (t.driverId || pending?.driverId));
    const driverLabel = d ? esc(d.name) : '—';
    const status = { waiting:'Waiting',offered:'Waiting for driver',assigned:'Assigned',attention:'Needs attention',completed:'Completed',cancelled:'Cancelled' }[g];
    const note = ProLiftBoard.attentionReason(t,Date.now(),dispatchLead()) || ProLiftRideExplanation.explain(state,t,user.role).meaning;
    return '<tr class="' + (g === 'attention' ? 'flagged-row' : '') + '"><td><input type="checkbox" data-bulk-trip aria-label="Select ride ' + esc(t.reference) + '" value="' + esc(t.id) + '"' + (t.isSharedRun || t.poolParentId || !['awaiting_driver','needs_reassignment','offered','accepted'].includes(t.status) ? ' disabled' : '') + '></td><td><strong>' + (t.willCall ? 'Will-call' : time(t.pickupAt)) + '</strong><small>' + date(t.pickupAt) + (t.plannedEndAt ? ' · Ends ' + time(t.plannedEndAt) : '') + '</small></td><td><button class="text-btn trip-ref" data-detail="' + t.id + '">' + esc(t.reference) + '</button><small>' + esc(t.customerName) +(t.poolParentId?' · Shared booking':'')+(t.preferredDriver?' · Regular: '+esc(t.preferredDriver.name):'')+'</small>'+(t.demoRunId?fleetBadge(fleetIdentity(sourceForTrip(t)||'unknown')):'')+'</td><td>' + esc(t.pickup) + '<small>→ ' + esc(t.destination) + '</small></td><td>' + (t.requirements?.includes('wheelchair') ? 'Wheelchair accessible' : 'Standard') + '<small>' + (t.lgtc ? 'LGTC' : t.demoRunId || t.testData ? 'Test data' : 'Other booking') + '</small></td><td><strong>' + driverLabel + '</strong></td><td><span class="badge ' + (g === 'attention' ? 'danger' : g === 'assigned' ? 'completed' : g) + '">' + status + '</span><small>' + note + '</small></td><td><button class="btn small" data-detail="' + t.id + '">' + (g === 'attention' ? 'Review' : 'View') + '</button></td></tr>';
  }).join('') + '</tbody></table></div>';
}
function importsPage() {
  if (config.publicDemo) return heading('PLANNED RIDES', 'Try the sample rides.', 'The public demo uses built-in test data. File uploads are available in the local demo.');
  const sources=tab==='trip-sources';
  if (sources) return '<div class="trip-source-page">'+heading('TRANSPORT','Trip Sources','Upload LGTC or Excel and open a saved schedule.')+
    '<div class="trip-source-cards">'+
    '<section class="panel source-card"><span class="source-card-icon" aria-hidden="true">'+icon('upload')+'</span><h2>Upload trip file</h2>'+
    '<p>LGTC or Excel/CSV · Up to 1,000 trips · 5 MB</p><label class="btn primary source-file-picker">Choose file<input id="import-file" type="file" accept=".xlsx,.csv"></label><div id="upload-progress" aria-live="polite"></div>'+
    '<details><summary>Upload guidance</summary><p>Use the original LGTC export. Keep it for rider details and instructions.</p></details></section>'+
    '<section class="panel source-card" id="lgtc-history"><span class="source-card-icon source-schedule-icon" aria-hidden="true">'+icon('clock')+'</span><h2>Saved LGTC schedules</h2>'+lgtcHistoryView()+'</section>'+
    '<section class="panel source-card"><span class="source-card-icon source-extra-icon" aria-hidden="true">'+icon('plus')+'</span><h2>Additional source</h2>'+
    '<details><summary>Name this source</summary><label>Source name <input id="additional-source-name" placeholder="Name it later" maxlength="80"></label></details></section></div>'+
    '<a class="btn small source-template" href="'+location.pathname.replace(/\/$/,'')+'/api/template">Download Excel template</a>'+
    (state.imports.length?'<details class="panel source-import-history"><summary>Recent EASYRIDE template imports</summary>'+
      state.imports.slice(0,5).map(i=>'<div class="activity-row"><strong>'+i.count+' trip rows · '+esc(date(i.at))+'</strong>'+badge(i.confirmed?'imported':'preview')+'</div>').join('')+'</details>':'')+
    (batch&&batch.kind!=='lgtc'?previewImport():'')+'</div>';
  if (location.port === '4783' && location.pathname === '/owner/') {
    return heading('TRANSPORT','Route Workbench','Review the imported LGTC schedule and driver assignments.') +
      '<iframe title="MongoDB LGTC day plan" src="/owner/day-plan?view=workbench" style="display:block;width:100%;height:75vh;border:0"></iframe>';
  }
  const title=heading('TRANSPORT','Route Workbench','Build driver routes and review rides before dispatch.', '<button class="btn" id="design-vehicle-plan">Plan bookings</button><button class="btn" data-driver-day="">Driver day</button>');
  const schedules='<section class="panel" id="lgtc-history"><h2>Saved LGTC schedules</h2>'+lgtcHistoryView()+'</section>';
  const hasSchedule = batch?.kind === 'lgtc';
  const steps = [
    ['map','Plan','Build routes and review unassigned rides','data-workbench-section="plan"'],
    ['check','Approve','Review rides before sending them to dispatch','data-workbench-section="approve"'],
    ['car','Track','Watch drivers and ride progress','data-go="overview"']
  ];
  const flow = '<ol class="workbench-flow" aria-label="Ride planning workflow">'+steps.map(([symbol,label,text,action],index)=>
    '<li'+(index===0?' aria-current="step"':'')+'><button type="button" '+action+'><span class="workbench-step-icon" aria-hidden="true">'+icon(symbol)+'</span><span><strong>'+label+'</strong><small>'+text+'</small></span></button></li>').join('')+'</ol>';
  return '<div class="route-workbench">'+title+flow+(hasSchedule?lgtcPreview(schedules):schedules)+'</div>';
}
function previewImport() {
  const invalid = batch.rows.filter(r => r.errors.length).length;
  return `<section class="panel"><div class="panel-heading"><div><h2>Review your import</h2><p>${batch.rows.length} rows · ${invalid} with errors. ${batch.confirmed ? 'Already imported.' : 'All rows must be valid. Automatic dispatch uses your configured pickup window.'}</p></div><button class="btn primary" id="confirm-import" ${invalid || batch.confirmed ? 'disabled' : ''}>${icon('check')} ${batch.confirmed ? 'Imported' : 'Confirm import'}</button></div><div class="table-scroll"><table><thead><tr><th>Row</th><th>Trip</th><th>Customer</th><th>Pickup</th><th>Validation</th></tr></thead><tbody>${batch.rows.map(r => `<tr><td>${r.row}</td><td>${esc(r.trip_id)}</td><td>${esc(r.customer_name)}</td><td>${esc(r.pickup)}<small>${esc(r.pickup_at)}</small></td><td>${r.errors.length ? `<span class="validation-error">${r.errors.map(esc).join('<br>')}</span>` : badge('valid')}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function fleetPage() { return heading('LIVE OPERATIONS', 'Stay close to your fleet.', 'Location freshness and driver status, updated over a live connection.') + `<div class="overview-grid fleet-large"><section class="panel">${mapView()}</section><section class="panel"><div class="panel-heading"><h2>Working drivers</h2></div><div class="driver-list">${driverRows()}</div></section></div><div class="notice">${icon('map')} This is a schematic with simulated GPS. Real Google maps and phone GPS are separate production integrations.</div>`; }
function importedFleetPanel() {
  return '<section class="panel upload-panel" id="imported-fleet"><h2>Fleet records</h2><div class="card-actions"><button class="btn" data-add-fleet="vehicle">Add vehicle</button><button class="btn" data-add-fleet="driver">Add driver</button></div><details class="fleet-setup-disclosure"><summary>Fleet setup</summary><p>Save a vehicle and weekly Eastern shift for an existing driver account. Date-specific shifts take priority.</p><form id="fleet-setup"><label>Driver account<select name="account" required></select></label><label>Imported driver<select name="importedDriver" required></select></label><label>Vehicle<select name="vin" required></select></label><label>Passenger seats<input name="seats" type="number" min="1" max="7" required></label><label>Wheelchair accessibility<select name="accessible" required><option value="">Choose…</option><option value="no">Standard</option><option value="yes">Wheelchair accessible</option></select></label><fieldset><legend>Weekly workdays</legend>'+['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((label,index)=>'<label><input type="checkbox" name="day" value="'+index+'"> '+label+'</label>').join('')+'</fieldset><label>Shift starts (ET)<input name="start" type="time" required></label><label>Shift ends (ET)<input name="end" type="time" required></label><button class="btn primary">Save fleet setup</button><p class="fleet-setup-result" aria-live="polite"></p></form></details><div class="bookings-filters"><label>Record type<select name="kind"><option value="vehicle">Vehicles</option><option value="driver">Drivers</option></select></label><label>Search records<input type="search" name="query"></label><label>Vehicle status<select name="status"><option value="">All statuses</option></select></label></div><p role="status"></p><div class="table-scroll"></div></section>';
}
function bindImportedFleet() {
  const panel = $('#imported-fleet');
  if (!panel) return;
  const kind = panel.querySelector('[name="kind"]');
  const query = panel.querySelector('[name="query"]');
  const status = panel.querySelector('[name="status"]');
  const message = panel.querySelector('[role="status"]');
  const table = panel.querySelector('.table-scroll');
  panel.querySelectorAll('[data-add-fleet]').forEach(button=>button.onclick=()=>{
    const type=button.dataset.addFleet,vehicle=type==='vehicle';
    modal('<h2>Add '+type+'</h2><form id="new-fleet-record"><label>Name<input name="name" required maxlength="100"></label>'+
      (vehicle?'<label>VIN<input name="vin" required minlength="17" maxlength="17"></label><label>Year<input name="year" maxlength="4"></label><label>Make<input name="make"></label><label>Model<input name="model"></label><label>Status<select name="status"><option>Enabled</option><option>Disabled</option></select></label><label>Vehicle photo<input type="file" name="photo" accept="image/jpeg,image/png,image/webp"></label>':
        location.port==='4781'?'<p>Save the driver record here. Use the private Owner workspace to upload licenses and contracts.</p>':'<label>Driver license photo<input type="file" name="license" accept="image/jpeg,image/png,image/webp"></label><label>Contract<input type="file" name="contract" accept="application/pdf,image/jpeg,image/png,image/webp"></label>')+
      '<button class="btn primary">Save '+type+'</button></form>');
    $('#new-fleet-record').onsubmit=event=>{
      event.preventDefault();
      run(async()=>{
        const button=event.submitter;
        button.disabled=true;
        try{
          const record={kind:type};
          for(const [key,value] of new FormData(event.target)){
            if(typeof value==='string')record[key]=value;
            else if(value.size){
              if(value.size>2000000)throw Error('Files must be 2 MB or smaller.');
              record[key]=await new Promise((resolve,reject)=>{
                const reader=new FileReader();
                reader.onload=()=>resolve(reader.result);
                reader.onerror=()=>reject(Error('Could not read the file.'));
                reader.readAsDataURL(value);
              });
            }
          }
          await api('/api/fleet-record',record);
          $('#modal').close();render();toast('Fleet record saved.');
        }finally{button.disabled=false;}
      });
    };
  });
  message.textContent = 'Loading fleet records…';
  api('/api/fleet-import?list=1').then(({records,setupReadOnly,mongoRecords}) => {
    if (setupReadOnly) {
      panel.querySelector('.fleet-setup-disclosure').hidden = true;
      panel.querySelector('[data-add-fleet]').parentElement.hidden = true;
    }
    const vehicles = records.filter(row=>row.kind==='vehicle');
    const drivers = records.filter(row=>row.kind==='driver');
    if (mongoRecords) {
      kind.options[0].textContent = 'Vehicles ('+vehicles.length+')';
      kind.options[1].textContent = 'Drivers ('+drivers.length+')';
      status.closest('label').firstChild.textContent = 'Record status';
    }
    const setup = panel.querySelector('#fleet-setup');
    const fields = setup.elements;
    const accounts = state.drivers.filter(driver=>!driver.demoRunId);
    const options = (field, items) => field.replaceChildren(new Option('Choose…',''), ...items.map(([label,value])=>new Option(label,value)));
    options(fields.account,accounts.map(driver=>[driver.name,driver.id]));
    options(fields.importedDriver,drivers.map(driver=>[driver.name,driver.name.toLowerCase()]));
    options(fields.vin,vehicles.filter(vehicle=>vehicle['Vehicle Status']?.toLowerCase()==='enabled').map(vehicle=>{
      const vin=vehicle['Vehicle Identification Number (VIN)'];
      return [[vehicle['Vehicle Name'],vehicle.Make,vehicle.Model,vin].filter(Boolean).join(' · '),vin];
    }));
    const clockText = value => Number.isInteger(value) && value<1440 ? String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0') : '';
    fields.account.onchange = () => {
      const driver=accounts.find(item=>item.id===fields.account.value);
      fields.importedDriver.value=driver?.importedDriver||'';
      fields.vin.value=driver?.vehicleId||'';
      fields.seats.value=driver?.importedDriver ? driver.seats : '';
      fields.accessible.value=driver?.importedDriver ? (driver.capabilities.includes('wheelchair')?'yes':'no') : '';
      fields.start.value=clockText(driver?.recurringShift?.start);
      fields.end.value=clockText(driver?.recurringShift?.end);
      for (const day of fields.day) day.checked=!!driver?.recurringShift?.days.includes(Number(day.value));
    };
    const queued = new Map();
    const controls = document.createElement('div');
    controls.innerHTML = '<button type="submit" class="btn" value="queue">Add to bulk setup</button> <button type="button" class="btn" disabled>Save all queued links</button><ul aria-label="Queued fleet links"></ul>';
    setup.append(controls);
    const bulkSave = controls.querySelector('[type=button]');
    const queueList = controls.querySelector('ul');
    const result = setup.querySelector('.fleet-setup-result');
    function showQueue() {
      bulkSave.disabled = !queued.size;
      queueList.replaceChildren(...[...queued.values()].map(entry=>{
        const row=document.createElement('li');
        row.textContent=accounts.find(driver=>driver.id===entry.driverId).name+' · '+entry.vin+' · ';
        const remove=document.createElement('button');
        remove.type='button';
        remove.textContent='Remove';
        remove.onclick=()=>{queued.delete(entry.driverId);showQueue();};
        row.append(remove);
        return row;
      }));
    }
    bulkSave.onclick = async () => {
      bulkSave.disabled=true;
      try {
        const {count}=await api('/api/fleet-setup',{entries:[...queued.values()]});
        queued.clear();
        result.textContent=count+' fleet links saved.';
      } catch(error) { result.textContent=error.message; }
      finally { showQueue(); }
    };
    setup.onsubmit = async event => {
      event.preventDefault();
      const button=event.submitter;
      const minute=value=>Number(value.slice(0,2))*60+Number(value.slice(3));
      const entry={driverId:fields.account.value,importedDriver:fields.importedDriver.value,
        vin:fields.vin.value,seats:Number(fields.seats.value),accessible:fields.accessible.value==='yes',
        days:[...fields.day].filter(day=>day.checked).map(day=>Number(day.value)),
        start:minute(fields.start.value),end:minute(fields.end.value)};
      if (!entry.days.length || entry.start>=entry.end) {
        result.textContent='Choose workdays and an end time after the start.';
        return;
      }
      if (button.value==='queue') {
        queued.set(entry.driverId,entry);
        showQueue();
        result.textContent='Link queued. Choose another account or save all queued links.';
        return;
      }
      button.disabled=true;
      try {
        await api('/api/fleet-setup',entry);
        result.textContent='Fleet setup saved.';
      } catch(error) { result.textContent=error.message; }
      finally { button.disabled=false; }
    };
    const statuses = [...new Set(vehicles.map(row=>row['Vehicle Status']).filter(Boolean))].sort();
    for (const value of statuses) status.add(new Option(value,value));
    const vehiclePhotos = new Map();
    function renderVehiclePhoto(button, vin) {
      const thumb = button.querySelector('.fleet-vehicle-thumb');
      if (!thumb || !vin) return;
      if (!vehiclePhotos.has(vin)) vehiclePhotos.set(vin,
        api('/api/fleet-record?kind=vehicle&key='+encodeURIComponent(vin)).then(({files})=>files.photo).catch(()=>null));
      vehiclePhotos.get(vin).then(photo=>{
        if (!photo || !thumb.isConnected) return;
        const image = document.createElement('img');
        image.alt = '';
        image.onload = ()=>thumb.replaceChildren(image);
        image.src = photo;
      });
    }
    let recordPage = 1;
    const size = document.createElement('label');
    size.textContent = 'Records per page ';
    size.insertAdjacentHTML('beforeend','<select><option>10</option><option>50</option><option>100</option><option>200</option></select>');
    const limit = size.querySelector('select');
    if (mongoRecords) limit.value = '200';
    size.className = 'fleet-page-size';
    const recordBar = document.createElement('div');
    recordBar.className = 'fleet-record-bar';
    message.before(recordBar);
    recordBar.append(message,size);
    const pager = document.createElement('nav');
    pager.className = 'pagination';
    pager.setAttribute('aria-label','Fleet record pages');
    table.after(pager);
    function show() {
      const isVehicle = kind.value==='vehicle';
      const statusKey = isVehicle ? 'Vehicle Status' : 'Driver Status';
      status.disabled = !isVehicle && !mongoRecords;
      const source = isVehicle ? vehicles : drivers;
      const columns = isVehicle ? ['Vehicle Name','Year','Make','Model','Vehicle Status','Last Known Driver'] : ['name','Driver Status'];
      const needle = query.value.trim().toLowerCase();
      const matching = source.filter(row=>(status.disabled || !status.value || row[statusKey]===status.value) &&
        columns.some(key=>String(row[key] ?? '').toLowerCase().includes(needle)));
      const pageSize = Number(limit.value);
      const pages = Math.max(1, Math.ceil(matching.length/pageSize));
      const start = (recordPage-1)*pageSize;
      const end = Math.min(start+pageSize,matching.length);
      message.textContent = matching.length ? (start+1)+'–'+end+' of '+matching.length+(isVehicle?' vehicles':' drivers') : 'No matching records';
      pager.hidden = pages <= 1;
      pager.innerHTML = '<button class="btn small" data-record-step="-1" '+(recordPage===1?'disabled':'')+'>Previous</button>'+
        '<span>Page '+recordPage+' of '+pages+'</span><button class="btn small" data-record-step="1" '+
        (recordPage===pages?'disabled':'')+'>Next</button>';
      table.innerHTML = '<table><thead><tr>'+columns.map(key=>'<th scope="col">'+esc(key==='name'?'Driver name':key)+'</th>').join('')+
        '</tr></thead><tbody>'+matching.slice(start,end).map((row,index)=>'<tr>'+columns.map((key,column)=>{
          const value = row[key];
          if (mongoRecords && key===statusKey && ['Enabled','Disabled'].includes(value)) {
            return '<td><span class="badge '+value.toLowerCase()+'">'+value+'</span></td>';
          }
          if (column===0 && !mongoRecords) return '<td><button class="text-btn" data-fleet-record="'+(start+index)+'">'+
            (isVehicle?'<span class="fleet-vehicle-thumb" aria-hidden="true">'+icon('car')+'</span>':'')+esc(value||'View record')+'</button></td>';
          return '<td>'+esc(value || '—')+'</td>';
        }).join('')+'</tr>').join('')+'</tbody></table>';
      if (isVehicle) table.querySelectorAll('[data-fleet-record]').forEach(button=>{
        const row = matching[Number(button.dataset.fleetRecord)];
        renderVehiclePhoto(button,row.recordKey ?? row['Vehicle Identification Number (VIN)']?.toUpperCase());
      });
    }
    table.onclick=event=>{
      const button=event.target.closest('[data-fleet-record]');
      if(!button)return;
      run(async()=>{
        const type=kind.value,vehicle=type==='vehicle';
        const source=vehicle?vehicles:drivers;
        const columns=vehicle?['Vehicle Name','Year','Make','Model','Vehicle Status','Last Known Driver']:['name','Driver Status'];
        const needle=query.value.trim().toLowerCase();
        const row=source.filter(item=>(!vehicle||!status.value||item['Vehicle Status']===status.value)&&
          columns.some(key=>String(item[key]??'').toLowerCase().includes(needle)))[Number(button.dataset.fleetRecord)];
        if(!row)return;
        const key=row.recordKey ?? (vehicle?row['Vehicle Identification Number (VIN)']?.toUpperCase():row.name.toLowerCase());
        const {files}=await api('/api/fleet-record?kind='+type+'&key='+encodeURIComponent(key||''));
        const statusField=vehicle?'Vehicle Status':'Driver Status';
        const disabled=row[statusField]==='Disabled';
        const facts=vehicle?['Year','Make','Model','Vehicle Identification Number (VIN)','Last Known Driver']:[];
        modal('<article class="fleet-record-card"><header><span class="source-card-icon">'+icon(vehicle?'car':'users')+'</span><div><small>'+ (vehicle?'Vehicle':'Driver')+
          '</small><h2>'+esc(row[columns[0]])+'</h2></div></header>'+
          (files.photo?'<img class="fleet-record-photo" alt="Vehicle photo" src="'+esc(files.photo)+'">':'')+
          (facts.length?'<dl>'+facts.map(field=>'<div><dt>'+esc(field==='Vehicle Identification Number (VIN)'?'VIN':field)+'</dt><dd>'+esc(row[field]||'—')+'</dd></div>').join('')+'</dl>':'')+
          ['license','contract'].filter(name=>files[name]).map(name=>'<p><a download="driver-'+name+(files[name].startsWith('data:application/pdf')?'.pdf':files[name].startsWith('data:image/png')?'.png':files[name].startsWith('data:image/webp')?'.webp':'.jpg')+'" href="'+esc(files[name])+'">Download '+name+'</a></p>').join('')+
          '<footer><span class="badge '+(disabled?'danger':'online')+'" id="fleet-record-status">'+(disabled?'Disabled':'Enabled')+'</span><button class="btn '+(disabled?'primary':'danger-text')+'" id="change-fleet-record-status">'+(disabled?'Enable ':'Disable ')+type+'</button></footer><p id="fleet-record-feedback" role="status"></p></article>');
        const toggle=$('#change-fleet-record-status');
        toggle.onclick=async()=>{
          toggle.disabled=true;
          try {
            const result=await api('/api/fleet-record/status',{kind:type,key,disabled:row[statusField]!=='Disabled'});
            row[statusField]=result.status;
            const inactive=result.status==='Disabled';
            $('#fleet-record-status').textContent=result.status;
            $('#fleet-record-status').className='badge '+(inactive?'danger':'online');
            toggle.textContent=(inactive?'Enable ':'Disable ')+type;
            toggle.className='btn '+(inactive?'primary':'danger-text');
            recordPage=1;
            show();
            $('#fleet-record-feedback').textContent='Status saved.';
          } catch (error) { $('#fleet-record-feedback').textContent=error.message; }
          finally { toggle.disabled=false; }
        };
      });
    };
    pager.onclick = event => {
      const button = event.target.closest('[data-record-step]');
      if (!button || button.disabled) return;
      recordPage += Number(button.dataset.recordStep);
      show();
      message.scrollIntoView({block:'nearest'});
    };
    kind.onchange = status.onchange = limit.onchange = query.oninput = () => { recordPage=1; show(); };
    show();
  }).catch(error=>{message.textContent=error.message;});
}
const mongoOwnerFleet = location.port === '4783' && location.pathname === '/owner/';
function mongoLiveReplay() { return !!config.mongoReplay || mongoOwnerFleet && !new URLSearchParams(location.search).has('acceptance'); }
let fleetPageTab = mongoOwnerFleet ? 'records' : 'live';
function driversPage() {
  const tabs = '<nav class="fleet-page-tabs filter-tabs" aria-label="Drivers and vehicles views">'+
    [['live',mongoOwnerFleet ? 'Acceptance test roster' : 'Live roster'],['records','Fleet records']].map(([key,label])=>
      '<button type="button" data-fleet-page-tab="'+key+'" aria-pressed="'+(fleetPageTab===key)+'" class="'+(fleetPageTab===key?'selected':'')+'">'+label+'</button>').join('')+'</nav>';
  const title = heading('YOUR TEAM','Drivers &amp; vehicles','Availability, vehicles, and current work in one place.');
  if (fleetPageTab === 'records') return title+tabs+importedFleetPanel();
  const roster = ProLiftBoard.fleet(state,lastSnapshotAt || Date.now()).filter(({driver})=>!driver.demoRunId); return title + tabs + `<section class="panel fleet-roster"><h2>Live dispatch roster</h2><div class="dispatch-roster-counts"><span><strong>${roster.length}</strong> Drivers</span><span><strong>${roster.filter(({status,driver})=>status==='available'&&!driver.driverDisabled&&!driver.vehicleDisabled).length}</strong> Available</span><span><strong>${roster.filter(({driver})=>driver.status==='busy').length}</strong> On ride</span><span><strong>${roster.filter(({driver})=>driver.status==='offline').length}</strong> Offline</span></div><label>Find a driver or vehicle <input id="fleet-roster-search" type="search"></label><p id="fleet-roster-empty" hidden>No matching drivers.</p><div class="fleet-roster-list">${roster.map(item => { const {driver:d,trip:t} = item; return `<details class="fleet-roster-row" data-live-roster-id="${esc(d.id)}"><summary>${fleetDriverAvatar(d)}<strong>${esc(d.name)}</strong><span>${esc([d.vehicle,d.plate].filter(Boolean).join(' · '))}</span>${badge(d.driverDisabled||d.vehicleDisabled?'disabled':d.status)}<small>${esc(dutyLocation(item))}${t?' · '+esc(t.reference):''}</small></summary><div class="fleet-roster-detail"><div class="specs"><span>${d.seats} passenger seats</span><button class="btn small" data-capacity="${d.id}">Vehicle requirements</button><span>${d.capabilities.length ? 'Wheelchair accessible' : 'Standard vehicle'}</span></div><div class="driver-assignment">${t ? `<small>CURRENT TRIP</small><button class="text-btn" data-detail="${t.id}">${esc(t.reference)} ${icon('arrow')}</button><p>${esc(t.pickup)}</p>` : '<small>NO ACTIVE TRIP</small><p>No ride assigned.</p>'}</div><small class="muted">Last location ${Number.isFinite(d.lastLocationAt) ? time(d.lastLocationAt) : "unavailable"}</small><button class="btn small" data-driver-day="${esc(d.id)}">Driver day</button><button class="btn small" data-driver-documents="${esc(d.id)}">Driver documents</button>${user.role === 'owner' ? ['driver','vehicle'].map(kind=>`<button class="btn small" data-fleet-kind="${kind}" data-fleet-driver="${esc(d.id)}" data-fleet-disabled="${!d[kind+'Disabled']}">${d[kind+'Disabled']?'Enable':'Disable'} ${kind}</button>`).join('') : ''}</div></details>`; }).join('')}</div></section>`; }
function activityPage() { return heading('ACCOUNTABILITY', 'Activity log', 'Assignments, driver drops, trip updates, and import activity.') + `<section class="panel">${state.events.length ? state.events.slice(0, 100).map(e => `<div class="activity-row">${icon(e.type.includes('reassignment') ? 'flag' : 'clock')}<div><strong>${esc(e.type.replace(/[._]/g, ' '))}</strong><span>${esc(e.reference || '')} · ${esc(e.actor)}</span><small>${esc(e.detail)}</small></div><time>${date(e.at)} · ${time(e.at)}</time></div>`).join('') : '<div class="empty"><p>Activity appears as your team works.</p></div>'}</section>`; }
function pairedRideLabel(trip) {
  if (!trip.lgtc?.pairedReference) return '';
  const paired = state.trips.find(other => other.customerPhone === trip.customerPhone &&
    other.lgtc?.reference === trip.lgtc.pairedReference && other.lgtc?.pairedReference === trip.lgtc.reference &&
    other.lgtc.program === trip.lgtc.program && other.lgtc.serviceDate === trip.lgtc.serviceDate);
  return '<p class="help"><strong>' + esc(trip.lgtc.direction) + ' ride</strong> · ' +
    (paired && user.role === 'customer' ? '<button type="button" class="text-btn" data-customer-paired-ride="' + esc(paired.id) +
      '">Open paired ride ' + esc(trip.lgtc.pairedReference) + '</button>' : 'Paired ride ' + esc(trip.lgtc.pairedReference)) + '</p>';
}
function dropOffDetails(t) {
  return [Number.isFinite(t.completedAt) ? time(t.completedAt) : '', t.confirmedDriver?.name].filter(Boolean).join(' · ');
}
function cancellationAudit(t) {
  return [Number.isFinite(t.cancelledAt) ? time(t.cancelledAt) : '', t.cancelledBy].filter(Boolean).join(' · ');
}
function offerSecondsRemaining(expiresAt) {
  const elapsed = Math.max(0, performance.now() - snapshotReceivedAt);
  return Math.max(0, Math.ceil((expiresAt - lastSnapshotAt - elapsed) / 1000));
}
function tripCard(t, showHistoryDetails = false) {
  const cancellationDetails = cancellationAudit(t);
  const driver = state.drivers.find(d => d.id === t.driverId) || (t.status==='completed'?t.confirmedDriver:null), offer = state.offers.find(o => o.tripId === t.id && o.status === 'pending' && o.expiresAt > lastSnapshotAt);
  return `<article class="panel trip-card ${t.redFlag ? 'flagged-card' : ''}"><div class="trip-card-head">${showHistoryDetails && user.role === 'customer' ? `<button type="button" class="text-btn trip-ref" data-history-ride="${esc(t.id)}" aria-label="Open ride ${esc(t.reference)}">${esc(t.reference)}</button>` : `<strong>${esc(t.reference)}</strong>`}${badge(t.status, t.redFlag)}</div>${showHistoryDetails && user.role === 'customer' && t.status === 'cancelled' && t.cancellationReason ? `<p class="notice"><strong>Cancellation reason:</strong> ${esc(t.cancellationReason)}${cancellationDetails ? ' · ' + esc(cancellationDetails) : ''}</p>` : ''}${showHistoryDetails && user.role === 'customer' && t.status === 'completed' && Number.isFinite(t.completedAt) ? '<p class="notice"><strong>Drop-off:</strong> ' + esc(dropOffDetails(t)) + '</p>' : ''}${pairedRideLabel(t)}<div class="trip-card-time"><strong>${time(t.pickupAt)}</strong><span>${date(t.pickupAt)} · ${t.passengers} passenger${t.passengers > 1 ? 's' : ''}</span></div><div class="journey"><div><span class="journey-dot"></span><small>PICKUP</small><strong>${esc(t.pickup)}</strong></div><div><span class="journey-dot end"></span><small>DESTINATION</small><strong>${esc(t.destination)}</strong></div></div>${t.isSharedRun?'<section class="shared-run-preview notice"><strong>Shared run · '+t.passengers+' passengers · '+(t.collectedStops||0)+' / '+t.sharedStops.length+' pickups collected</strong><ol>'+t.sharedStops.map((x,i)=>'<li>'+time(x.plannedAt)+' · '+esc(x.pickup)+' · '+x.passengers+' passenger(s)'+(i<(t.collectedStops||0)?' · Onboard':i===(t.collectedStops||0)?' · NEXT':'')+'</li>').join('')+'</ol></section>':''}${user.role === 'driver' ? `<div class="trip-customer">${icon('users')} ${esc(t.customerName)}${t.isSharedRun?' · Follow pickup order':' · '+esc(t.customerPhone)}</div>` : driver ? `<div class="trip-customer">${icon('car')} ${esc(driver.name)} · ${esc(driver.vehicle)} · ${esc(driver.plate)}</div>` : '<p class="muted">Dispatch will confirm your driver.</p>'}${offer && user.role === 'driver' ? `<div class="offer-note"><span data-offer-countdown="${offer.expiresAt}">${offerSecondsRemaining(offer.expiresAt)} seconds to respond</span> · ${offer.etaSource==='road'?'Road':'Simulated'} pickup ETA ${offer.eta} min</div><div class="card-actions"><button class="btn primary" data-trip="${t.id}" data-action="accept" data-offer="${offer.id}">Accept trip</button><button class="btn" data-trip="${t.id}" data-action="decline" data-offer="${offer.id}">Decline</button></div>` : `${user.role==='customer'&&t.confirmedDriver&&active(t)?'<div class="confirmed-driver"><strong>Your confirmed driver: '+esc(t.confirmedDriver.name)+'</strong><span>'+esc(t.confirmedDriver.vehicle)+' · '+esc(t.confirmedDriver.plate)+'</span><span>Driver phone: '+esc(t.confirmedDriver.phone||'Contact dispatch')+'</span></div>':''}<div class="card-actions">${user.role === 'driver' ? driverButtons(t) : active(t) ? `<button class="btn primary" data-detail="${t.id}">${icon('map')} Track trip</button>${!t.poolParentId?`<button class="btn" data-trip="${t.id}" data-action="cancel">Cancel trip</button>`:''}` : t.status === 'completed' ? t.rating ? `<span class="rating">${'★'.repeat(t.rating)} · Your rating</span>` : `<button class="btn" data-rate="${t.id}">Rate your ride</button>` : ''}</div>`}${offer&&user.role==='driver'?'':rideExplanation(t)}${rideExtras(t)}</article>`;
}
function driverButtons(t) { const next = { accepted: ['depart', 'Head to pickup'], heading_to_pickup: ['arrive', 'I have arrived'], arrived: ['pickup', 'Passenger onboard'], onboard: ['complete', 'Complete trip'] }[t.status]; return next ? `<button class="btn primary" data-trip="${t.id}" data-action="${next[0]}">${icon('check')} ${t.isSharedRun&&next[0]==='pickup'?'Confirm this pickup · '+((t.collectedStops||0)+1)+' / '+t.sharedStops.length:next[1]}</button>${['accepted', 'heading_to_pickup', 'arrived'].includes(t.status)&&!(t.collectedStops>0) ? `<button class="btn danger-text" data-release="${t.id}">Drop trip</button>` : ''}<button class="btn" data-detail="${t.id}">Details</button>` : ''; }
let scheduleManagementDate = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
function scheduleManagementPage() {
  const drivers = state.drivers.filter(driver => !driver.demoRunId);
  const rows = drivers.map(driver => {
    const shift = driver.availability?.[scheduleManagementDate];
    const hours = shift?.unavailable ? 'Unavailable' : shift ? lgtcInputTime(shift.start) + '–' + lgtcInputTime(shift.end) + ' ET' : 'No shift entered';
    return '<tr><td><strong>' + esc(driver.name) + '</strong></td><td>' + esc(driver.vehicle) +
      ' · ' + driver.seats + ' seats</td><td>' + esc(hours) + '</td><td>' + badge(driver.status) +
      '</td><td><button type="button" class="btn small" data-edit-shift="' + esc(driver.id) + '">Edit shift</button></td></tr>';
  }).join('');
  return heading('FLEET','Schedule Management','Set driver hours before building the route plan.') +
    '<section class="panel"><label>Service date<input type="date" id="schedule-management-date" value="' +
    esc(scheduleManagementDate) + '"></label><div class="table-scroll"><table><thead><tr><th>Driver</th><th>Vehicle</th><th>Shift</th><th>Live status</th><th></th></tr></thead><tbody>' +
    rows + '</tbody></table></div></section>';
}
function driverAvailabilityModal(driverId = user.driverId, selectedDate) {
  const driver = state.drivers.find(item => item.id === driverId);
  const availability = driver.availability || {};
  const today = new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  const dates = Object.keys(availability).filter(day => day >= today).sort().slice(0,7);
  const timeValue = minutes => String(Math.floor(minutes/60)).padStart(2,'0') + ':' + String(minutes%60).padStart(2,'0');
  modal('<h2>' + (user.role === 'owner' ? esc(driver.name) + ' · Shift' : 'My availability') +
    '</h2><p>Shift times are Eastern. Live offers also depend on online status.</p>' +
    (dates.length ? '<p><strong>Upcoming availability</strong></p><ul>' + dates.map(day => {
      const shift = availability[day];
      const label = shift.unavailable ? 'Unavailable' : timeValue(shift.start) + '–' + timeValue(shift.end) + ' ET';
      return '<li><button type="button" class="text-btn" data-driver-shift-date="' + day + '">' + day + ' · ' + label + '</button></li>';
    }).join('') + '</ul>' : '') +
    '<form id="driver-availability-form"><label>Date<input type="date" name="serviceDate" required value="' + esc(selectedDate || today) + '"></label>' +
    '<label>Availability<select name="selection"><option value="hours">Available during these hours</option>' +
    '<option value="unavailable">Unavailable that day</option><option value="clear">Clear saved availability</option></select></label>' +
    '<div class="form-grid" id="driver-availability-hours"><label>Start (ET)<input type="time" name="start"></label>' +
    '<label>End (ET)<input type="time" name="end"></label></div><button class="btn primary" type="submit">Save availability</button></form>');
  const form = $('#driver-availability-form');
  const { serviceDate, selection, start, end } = form.elements;
  const toggleHours = () => {
    const show = selection.value === 'hours';
    $('#driver-availability-hours').hidden = !show;
    start.required = end.required = show;
  };
  const loadDate = () => {
    const shift = availability[serviceDate.value];
    selection.value = shift?.unavailable ? 'unavailable' : 'hours';
    start.value = shift && !shift.unavailable ? timeValue(shift.start) : '';
    end.value = shift && !shift.unavailable ? timeValue(shift.end) : '';
    toggleHours();
  };
  document.querySelectorAll('[data-driver-shift-date]').forEach(button => button.onclick = () => {
    serviceDate.value = button.dataset.driverShiftDate;
    loadDate();
  });
  serviceDate.onchange = loadDate;
  selection.onchange = toggleHours;
  loadDate();
  form.onsubmit = event => {
    event.preventDefault();
    run(async () => {
      const submit = event.submitter;
      submit.disabled = true;
      try {
        await api('/api/driver/availability',{ ...Object.fromEntries(new FormData(form)), driverId });
        $('#modal').close();
        await refresh();
        toast('Availability saved.');
      } finally { submit.disabled = false; }
    });
  };
}
let driverTripPeriod='today', driverTripSearch='', driverDropoffs=false, driverCompleted=false;
function driverMobileTrips(trips){
 const zone={timeZone:'America/New_York'};
 const day=value=>new Date(value).toLocaleDateString('en-CA',zone);
 const today=day(lastSnapshotAt||Date.now());
 const visible=trips.filter(t=>(driverTripPeriod==='future'?day(t.pickupAt)>today:day(t.pickupAt)<=today)
  && (!driverDropoffs||t.status==='onboard') && (driverCompleted||t.status!=='completed')
  && [t.reference,t.customerName,t.pickup,t.destination].some(value=>String(value||'').toLowerCase().includes(driverTripSearch.toLowerCase())));
 return `<section class="driver-mobile-trips"><h2>Trips</h2>
 <div class="driver-period">${['today','future'].map(p=>`<button data-driver-period="${p}" aria-pressed="${driverTripPeriod===p}">${p==='today'?'Today':'Future'}</button>`).join('')}</div>
 <input id="driver-trip-search" type="search" placeholder="Search trips" aria-label="Search trips" value="${esc(driverTripSearch)}">
 <div class="driver-filters"><label><input id="driver-dropoffs" type="checkbox" ${driverDropoffs?'checked':''}> Pending drop-off</label><button id="driver-completed" aria-pressed="${driverCompleted}">${driverCompleted?'Hide completed':'Show completed'}</button></div>
 <p class="driver-swipe-hint">Swipe either way or tap Ride actions.</p>
 <div id="driver-mobile-list">${visible.map(t=>{
 const offer=state.offers.find(o=>o.tripId===t.id&&o.status==='pending');
 const stop=(kind,label,address,at)=>`<div class="driver-stop ${kind}"><span><strong>${label}</strong><small>${at?new Date(at).toLocaleTimeString([], {...zone,hour:'numeric',minute:'2-digit'}):'Time pending'}</small></span><div><strong>${esc(t.customerName)}</strong><small>${esc(t.lgtc?.reference||t.reference)}</small><div>${esc(address)}</div></div></div>`;
 return `<article class="driver-route" data-driver-route="${esc(t.id)}"><div class="driver-route-head"><strong>${new Date(t.pickupAt).toLocaleDateString([], {...zone,month:'short',day:'numeric'})}</strong> ${badge(t.status)}<button data-driver-ride-actions aria-expanded="false">Ride actions</button></div>${stop('pickup','PU',t.pickup,t.pickupAt)}${stop('dropoff','DO',t.destination,t.completedAt||t.plannedEndAt)}<div class="card-actions driver-route-actions" hidden>${offer?`<button class="btn primary" data-trip="${t.id}" data-action="accept" data-offer="${offer.id}">Accept trip</button><button class="btn" data-trip="${t.id}" data-action="decline" data-offer="${offer.id}">Decline</button>`:driverButtons(t)}${!offer?`<button class="btn" data-detail="${t.id}">View ride</button>`:''}</div></article>`;
 }).join('')||'<p>No trips match these filters.</p>'}</div></section>`;
}
function bindDriverMobileTrips(){
 const screen=document.querySelector('.driver-mobile-trips');
 if(!screen)return;
 screen.querySelectorAll('[data-driver-period]').forEach(button=>button.onclick=()=>{driverTripPeriod=button.dataset.driverPeriod;render();});
 $('#driver-completed').onclick=()=>{driverCompleted=!driverCompleted;if(driverCompleted)driverDropoffs=false;render();};
 $('#driver-dropoffs').onchange=event=>{driverDropoffs=event.target.checked;render();};
 $('#driver-trip-search').onchange=event=>{driverTripSearch=event.target.value;render();};
 for(const card of screen.querySelectorAll('[data-driver-route]')){
  const button=card.querySelector('[data-driver-ride-actions]');
  const actions=card.querySelector('.driver-route-actions');
  const id=card.dataset.driverRoute;
  const show=open=>{
    actions.hidden=!open;
    button.setAttribute('aria-expanded',String(open));
    if(open)expandedDriverRides.add(id);
    else expandedDriverRides.delete(id);
  };
  show(expandedDriverRides.has(id));
  button.onclick=()=>show(actions.hidden);
  let start;
  card.addEventListener('pointerdown',e=>{if(e.isPrimary&&e.button===0&&!e.target.closest('button'))start=[e.pointerId,e.clientX,e.clientY];});
  card.addEventListener('pointercancel',()=>{start=null;});
  card.addEventListener('pointerup',e=>{
   if(!start||start[0]!==e.pointerId)return;
   const dx=e.clientX-start[1],dy=e.clientY-start[2];
   start=null;
   if(Math.abs(dx)>=48&&Math.abs(dx)>Math.abs(dy)*1.5)show(true);
  });
 }
}
async function openDriverDocuments(id){
  const path='/api/driver-documents?driver='+encodeURIComponent(id);
  const {documents}=await api(path);
  const driver=state.drivers.find(d=>d.id===id);
  modal('<h2>Documents · '+esc(driver?.name||user.name)+'</h2>'+
    ['license','contract'].map(kind=>{
      const doc=documents[kind];
      return '<section class="panel"><h3>'+(kind==='license'?'Driver license':'Contract')+'</h3><p>'+esc(doc?.status||'Missing')+'</p>'+
        (doc?.expiresOn?'<p>License expires '+esc(doc.expiresOn)+'</p>':'')+(doc?.reason?'<p>'+esc(doc.reason)+'</p>':'')+
        (doc?'<a download="driver-'+kind+(doc.file.startsWith('data:application/pdf')?'.pdf':doc.file.startsWith('data:image/png')?'.png':doc.file.startsWith('data:image/webp')?'.webp':'.jpg')+'" href="'+esc(doc.file)+'">Download '+kind+'</a>':'')+
        '<form data-document="'+kind+'"><label>Upload '+kind+'<input type="file" required accept="image/jpeg,image/png,image/webp'+(kind==='contract'?',application/pdf':'')+'"></label>'+(kind==='license'?'<label>License expiration date<input type="date" name="expiresOn" required></label>':'')+'<button class="btn">Submit '+kind+'</button></form>'+
        (doc&&user.role==='owner'?'<form data-review-document="'+kind+'"><label>Correction reason<input maxlength="500"></label><button class="btn" value="approve">Approve '+kind+'</button><button class="btn" value="correct">Request correction</button></form>':'')+'</section>';
    }).join(''));
  for(const form of document.querySelectorAll('[data-document],[data-review-document]'))form.onsubmit=event=>{
    event.preventDefault();
    run(async()=>{
      const button=event.submitter;
      button.disabled=true;
      try{
        const input=form.querySelector('input');
        const kind=form.dataset.document||form.dataset.reviewDocument;
        const data={kind,action:button.value||'upload'};
        if(data.action==='upload'){
          if(input.files[0].size>2000000)throw Error('Files must be 2 MB or smaller.');
          if(kind==='license')data.expiresOn=form.elements.expiresOn.value;
          data.file=await new Promise((resolve,reject)=>{
            const reader=new FileReader();
            reader.onload=()=>resolve(reader.result);
            reader.onerror=()=>reject(Error('Could not read the file.'));
            reader.readAsDataURL(input.files[0]);
          });
        }else data.reason=input.value;
        await api(path,data);
        $('#modal').close();
        await openDriverDocuments(id);
      }finally{button.disabled=false;}
    });
  };
}
function driverVehiclePage(){
  const driver=state.drivers.find(item=>item.id===user.driverId);
  return heading('DRIVER WORKSPACE','Vehicle','Your assigned vehicle and location sharing.')+
    '<section class="panel trip-card"><h2>'+esc(driver.vehicle||'Vehicle pending')+'</h2><p>'+
    esc(driver.plate||'Plate pending')+' · '+esc(driver.seats)+' passenger seats</p>'+
    (driver.capabilities?.includes('wheelchair')?'<p>Wheelchair accessible</p>':'')+'</section>'+
    '<button class="btn" data-driver-documents="'+esc(driver.id)+'">Profile &amp; documents</button>'+phoneTrackingPanel(driver);
}
function driverPage() {
  const d = state.drivers.find(d => d.id === user.driverId), trips = state.trips.filter(t=>active(t)&&(t.driverId===user.driverId||state.offers.some(o=>o.tripId===t.id&&o.status==='pending')));
  return driverMobileTrips(state.trips.filter(t=>t.driverId===user.driverId||trips.includes(t))) + heading('DRIVER WORKSPACE', `Let’s get moving, ${esc(user.name.split(' ')[0])}.`, 'Accept an offer, follow your pickup, and keep dispatch updated.', `<button class="btn ${d.status === 'online' ? 'primary' : ''}" id="toggle-status" ${d.status === 'busy' ? 'disabled' : ''}>${icon('bolt')} ${d.status === 'offline' ? 'Go online' : d.status === 'busy' ? 'On a trip' : 'Online · go offline'}</button>`) + '<p><button type="button" class="btn" id="driver-availability">My availability</button></p><section class="mobile-status panel"><span class="status-orb '+d.status+'">'+icon('car')+'</span><div><strong>'+(d.status==='busy'?'You have an active ride':d.status==='online'?'You’re available':'You’re offline')+'</strong><p>'+(d.status==='busy'?'Follow the next step on your ride card.':d.status==='online'?'Eligible pickup offers appear here automatically.':'Go online when you’re ready for pickups.')+'</p></div></section>' + (d.status==='busy'?`<section class="panel last-ride"><strong>${d.finishThenOffline?'You will go offline after this ride.':'Keep receiving rides after this trip?'}</strong><button class="btn" id="last-ride">${d.finishThenOffline?'Keep accepting rides':'Go offline after this ride'}</button></section>`:'') + `<div class="trip-card-grid driver-desktop-trips">${trips.length ? trips.map(trip => tripCard(trip)).join('') : `<section class="panel empty">${icon('car')}<h2>${d.status === 'offline' ? 'You’re offline.' : 'Ready for the next trip.'}</h2><p>${d.status === 'offline' ? 'Go online to receive offers.' : 'New offers will appear here automatically.'}</p></section>`}</div>`;
}
var selectedCustomerTrip=null;
let customerHistoryReturn = null;
let highlightedHistoryRide = null;
function customerTracking(t,d,j){
 const from=config.places.find(p=>p.name===t.pickup),to=config.places.find(p=>p.name===t.destination);if(!from||!to)return '<div class="rider-map-unavailable">Pickup map is unavailable. Your addresses are shown below.</div>';
 const points=[from,to,...(j.location==='available'?[d]:[])],latMin=Math.min(...points.map(p=>p.lat)),latMax=Math.max(...points.map(p=>p.lat)),lngMin=Math.min(...points.map(p=>p.lng)),lngMax=Math.max(...points.map(p=>p.lng));
 const xy=p=>({x:55+(p.lng-lngMin)/Math.max(.008,lngMax-lngMin)*250,y:195-(p.lat-latMin)/Math.max(.008,latMax-latMin)*135}),start=xy(from),end=xy(to),car=j.location==='available'?xy(d):null;
 return '<div class="rider-tracking"><div class="tracking-caption"><span>'+icon('map')+' '+(j.location!=='available'?'Pickup & destination':j.source==='device'?'Device location':'Demo tracking')+'</span><span>'+(['offline','reconnecting','connecting'].includes(connectionMode)?'Updates paused':car?'Updated '+j.ageSeconds+'s ago':'Driver location unavailable')+'</span></div><svg viewBox="0 0 360 250" role="img" aria-label="Schematic showing pickup, destination'+(car?' and driver location':'')+'. Lines are not road routes."><defs><pattern id="rider-grid" width="30" height="30" patternUnits="userSpaceOnUse"><path d="M30 0H0V30" fill="none" stroke="#dce5f0" stroke-width="1"/></pattern></defs><rect width="360" height="250" fill="#f0f5fc"/><rect width="360" height="250" fill="url(#rider-grid)"/><path d="M'+start.x+' '+start.y+' L'+end.x+' '+end.y+'" stroke="#9cb2d8" stroke-width="3" stroke-dasharray="5 6"/>'+(car?'<path d="M'+car.x+' '+car.y+' L'+start.x+' '+start.y+'" stroke="#2b63dd" stroke-width="3" stroke-dasharray="5 5"/>':'')+'<circle cx="'+start.x+'" cy="'+start.y+'" r="9" fill="#fff" stroke="#245cdb" stroke-width="4"/><text x="'+start.x+'" y="'+(start.y+27)+'" text-anchor="middle" fill="#30517d" font-size="11">Pickup</text><rect x="'+(end.x-7)+'" y="'+(end.y-7)+'" width="14" height="14" rx="3" fill="#122c50"/><text x="'+end.x+'" y="'+(end.y-17)+'" text-anchor="middle" fill="#30517d" font-size="11">Destination</text>'+(car?'<g transform="translate('+car.x+' '+car.y+')"><circle r="23" fill="#2c65e5" opacity=".15"/><circle r="16" fill="#285fda" stroke="white" stroke-width="3"/><text text-anchor="middle" y="4" fill="white" font-size="11">CAR</text></g>':'')+'</svg><div class="tracking-footnote">'+(j.source==='simulated'?'Simulated driver position · ':'')+'Schematic, not a road map. Your phone location is not shared.</div></div>';
}
setInterval(()=>{if(user?.role==='customer'&&tab==='mytrips'&&!$('dialog[open]')&&!document.activeElement?.closest('form')&&!['SELECT','INPUT','TEXTAREA'].includes(document.activeElement?.tagName))render();},15000);
function customerPage(){
 const trips=state.trips.filter(active).sort((a,b)=>Number(!!b.driverId)-Number(!!a.driverId)||a.pickupAt-b.pickupAt);
 const viewed=state.trips.find(t=>t.id===selectedCustomerTrip);
 if(viewed&&!active(viewed)){
  const complete=viewed.status==='completed';
  return heading('YOUR JOURNEY',complete?'Ride completed':'Ride cancelled',complete?(dropOffDetails(viewed) ? 'Drop-off: '+esc(dropOffDetails(viewed)) : 'Your driver marked the drop-off complete.'):viewed.cancellationReason ? 'Cancellation reason: '+esc(viewed.cancellationReason)+(cancellationAudit(viewed) ? ' · '+esc(cancellationAudit(viewed)) : '') : 'This booking is closed.')+
   '<div class="trip-card-grid">'+tripCard(viewed)+'</div><div class="card-actions">'+
   (trips.length?'<button class="btn primary" id="next-customer-ride">View upcoming ride</button>':'<button class="btn primary" id="book-trip">Plan a trip</button>')+
   '<button class="btn" id="back-to-trip-history">Back to Trip history</button></div>';
 }
 const t=viewed||trips[0];
 if(!t)return '<section class="rider-welcome"><span class="eyebrow">EASYRIDE RIDES</span><h1>Your next journey starts here.</h1><p>Book a pickup and follow every step in one place.</p><button class="btn primary" id="book-trip">Plan a trip</button>'+(state.trips.length?' <button class="btn" data-go="history">Trip history</button>':'')+'</section>';
 selectedCustomerTrip=t.id;
 const d=state.drivers.find(d=>d.id===t.driverId),j=ProLiftRider.journey(t,d,lastSnapshotAt||Date.now()),identity=t.confirmedDriver;
 return '<section class="rider-journey"><header class="rider-header"><div><span class="eyebrow">YOUR JOURNEY</span><h1>'+esc(j.title)+'</h1><p>'+esc(j.description)+'</p></div></header>'+
 (trips.length>1?'<label class="rider-switch">Viewing ride<select id="customer-ride-choice">'+trips.map(x=>'<option value="'+x.id+'" '+(x.id===t.id?'selected':'')+'>'+esc(x.pickup)+' → '+esc(x.destination)+' · '+date(x.pickupAt)+' '+time(x.pickupAt)+'</option>').join('')+'</select></label>':'')+
 (j.late?'<div class="rider-warning"><strong>Your pickup time has passed</strong><span>Please check with your driver or send a help request. The app has no verified new arrival time.</span></div>':'')+
 '<div class="rider-layout">'+customerTracking(t,d,j)+'<section class="rider-sheet"><div class="rider-time"><span>Pickup '+date(t.pickupAt)+'</span><strong>'+time(t.pickupAt)+'</strong><span>'+esc(t.reference)+'</span></div>'+pairedRideLabel(t)+'<div class="rider-stops"><div><i></i><span>MEET HERE<strong>'+esc(t.pickup)+'</strong></span></div><div><i></i><span>GOING TO<strong>'+esc(t.destination)+'</strong></span></div></div><ol class="rider-steps">'+['Booked','Driver confirmed','At pickup','On your way'].map((label,i)=>'<li class="'+(i<=j.step?'reached':'')+'" '+(i===j.step?'aria-current="step"':'')+'><i>'+ (i<j.step?'✓':i+1)+'</i><span>'+label+'</span></li>').join('')+'</ol>'+
 (identity?'<div class="rider-identity"><span class="avatar large">'+esc(identity.name.split(' ').map(x=>x[0]).join('').slice(0,2))+'</span><div><strong>'+esc(identity.name)+'</strong><span>'+esc(identity.vehicle)+'</span><b>'+esc(identity.plate)+'</b></div></div>':'<div class="rider-unassigned">Driver and car details will appear here after acceptance.</div>')+
 '<div class="rider-main-action">'+(identity?.phone?'<a class="btn primary" href="tel:'+esc(identity.phone)+'">'+icon('users')+' Call driver</a>':'<button class="btn primary" data-help-trip="'+t.id+'">Ask about my pickup</button>')+'</div><div class="rider-secondary">'+(identity?.phone?'<button class="text-btn" data-help-trip="'+t.id+'">Get help</button>':'')+(t.status!=='onboard'?'<button class="text-btn" data-trip="'+t.id+'" data-action="cancel">Cancel ride</button>':'')+'</div></section></div><button class="btn rider-book" id="book-trip">'+icon('plus')+' Book another ride</button></section>';
}
function historyPage() { const trips = state.trips.filter(t => !active(t)); return driverPayPanel()+heading('TRIP RECORDS', 'Trip history', 'Completed and cancelled rides.') + `<div class="trip-card-grid">${trips.length ? trips.map(trip => tripCard(trip, true) + (user.role === 'driver' ? '<button class="btn history-ride-details" data-detail="'+esc(trip.id)+'">View ride details</button>' : '')).join('') : '<section class="panel empty"><h2>No past trips yet.</h2><p>Completed and cancelled trips appear here.</p></section>'}</div>`; }
function render() {
  if (!user || !state) return;
  const pages = {shifts:scheduleManagementPage,manage:managePage,"lgtc-settings":lgtcSettingsPage,customers:regularCustomersPage,readiness:readinessPage,scheduled:scheduledPage,help:()=>helpPage(user.role==='owner'?'Support requests':'Help requests'), overview, reports:reportsPage, messages:messagesPage, settings:settingsPage,"fleet-import":fleetImportPage, schedule: schedulePageView, trips: tripsPage, fleet: fleetPage, imports: importsPage, "trip-sources": importsPage, drivers: driversPage, activity: activityPage, work: driverPage, vehicle:driverVehiclePage, "driver-messages":()=>helpPage("Messages"), mytrips: customerPage, history: historyPage };
  const workspaceView = new URLSearchParams(location.search).get('workspacePanel');
  const allowed = user.role === 'owner'
    ? Object.keys(pages).filter(key=>!['work','vehicle','driver-messages','scheduled','mytrips','history'].includes(key))
    : user.role === 'driver' ? ['work','vehicle','driver-messages','scheduled','history'] : ['mytrips','help','messages','history'];
  if (allowed.includes(workspaceView)) tab = workspaceView;
  document.body.classList.remove('workspace-panel-window');
  const rosterSearch = tab === 'drivers' ? $('#fleet-roster-search')?.value : null;
  const openRoster = tab === 'drivers' ? new Set([...document.querySelectorAll('[data-live-roster-id][open]')].map(row=>row.dataset.liveRosterId)) : null;
  shell((pages[tab] || overview)()+(tab==='settings'?appearanceControl():''));
  if (openRoster) {
    document.querySelectorAll('[data-live-roster-id]').forEach(row=>row.open=openRoster.has(row.dataset.liveRosterId));
    const searchRoster = $('#fleet-roster-search');
    if (searchRoster && rosterSearch) {
      searchRoster.value = rosterSearch;
      searchRoster.dispatchEvent(new Event('input'));
    }
  }
  if (tab !== 'overview') bindWorkspacePanels(workspaceView === tab);
  bindMissedPickupDemo();
  bindMongoTrips();
  bindDriverPay();
  if ($('#mongo-owner-review')) $('#mongo-owner-review').onclick=()=>run(async()=>{
    const {review}=await api('/api/lgtc-replay');
    modal('<h2>Owner review · '+review.length+' rides</h2><div class="table-scroll"><table><thead><tr><th>Ride</th><th>Reason</th></tr></thead><tbody>'+
      review.map(ride=>'<tr><td>'+esc(ride.reference)+'</td><td>'+esc(ride.reasons.join(', '))+'</td></tr>').join('')+
      '</tbody></table></div>');
  });
  if ($('#start-mongo-dispatch')) $('#start-mongo-dispatch').onclick=event=>run(async()=>{
    if (mongoDispatchStarting) return;
    mongoDispatchStarting=true;
    event.currentTarget.disabled=true;
    try {
      if (config.mongoReplay) await api('/api/lgtc-replay',{});
      else {
        const response=await fetch('/owner/dispatch-plan?view=dashboard',{method:'POST'});
        if (!response.ok) throw Error(await response.text());
      }
      await refresh();
    } finally {
      mongoDispatchStarting=false;
      if ($('#start-mongo-dispatch')) $('#start-mongo-dispatch').disabled=!!state.lgtcReplay?.running;
    }
  });
  if($('#start-live-284'))$('#start-live-284').onclick=event=>run(async()=>{
    const button=event.currentTarget;
    button.disabled=true;
    try{
      const response=await fetch('/owner/run-284',{method:'POST'});
      if(!response.ok)throw Error(await response.text());
      await refresh();
    }finally{button.disabled=false;}
  });
  updateConnection();
}
function bindWorkspacePanels(detached) {
  const page = $('#main-content > .page-content');
  if (!page) return;
  const regions = [...page.querySelectorAll(':scope > section, :scope > article, :scope > div > section')]
    .filter(panel=>panel.querySelector('h2,h3'));
  if (!regions.length) {
    const body = document.createElement('section');
    body.append(...page.childNodes);
    page.append(body);
    regions.push(body);
  }
  const candidates = regions;
  const url = new URL(location.href);
  const picked = url.searchParams.get('section');
  const occurrences = new Map();
  if (detached) document.body.classList.add('workspace-panel-window');
  else document.body.classList.remove('workspace-panel-window');
  for (const panel of candidates) {
    const heading = panel.querySelector('h2,h3') || page.querySelector('h1');
    const title = heading?.textContent.trim() || panel.querySelector('h1')?.textContent.trim() || 'Workspace';
    const label = (panel.id || [...panel.classList].join('.') || 'page').replaceAll(' ','-');
    const occurrence = (occurrences.get(label) || 0) + 1;
    occurrences.set(label,occurrence);
    const id = label+'-'+occurrence;
    const key = 'royalcab.workspace-panel.'+user.role+'.'+tab+'.'+id;
    let preferences = {};
    try { preferences = JSON.parse(localStorage.getItem(key) || '{}'); } catch {}
    const tools = document.createElement('div');
    tools.className = 'workspace-panel-controls';
    tools.setAttribute('role','group');
    tools.setAttribute('aria-label',title+' panel controls');
    const content = document.createElement('div');
    content.className = 'workspace-panel-content';
    panel.before(tools);
    panel.before(content);
    content.append(panel);
    const frame = document.createElement('div');
    frame.className = 'workspace-adjustable-panel';
    tools.before(frame);
    frame.append(tools,content);
    if (detached && picked === id) {
      if (!panel.matches('#main-content > .page-content')) {
        page.dataset.detachedSection = 'true';
        frame.dataset.detachedTarget = 'true';
      }
    }
    if (!detached) {
      const handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'fleet-panel-resize';
      handle.setAttribute('aria-label','Resize '+title+' vertically');
      const resize = value => {
        preferences.height = Math.round(Math.max(90,Math.min(1200,value)));
        content.style.minHeight = preferences.height+'px';
      };
      handle.onpointerdown = event => {
        if (event.button !== 0) return;
        const start = event.clientY, height = content.getBoundingClientRect().height;
        handle.setPointerCapture(event.pointerId);
        handle.onpointermove = move => resize(height+move.clientY-start);
        handle.onlostpointercapture = () => { handle.onpointermove=null; save(); };
      };
      handle.onkeydown = event => {
        if (!['ArrowUp','ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        resize(content.getBoundingClientRect().height+(event.key==='ArrowDown'?40:-40));
        save();
      };
      frame.append(handle);
      if (Number.isFinite(preferences.height)) resize(preferences.height);
    }
    function add(label, action) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn small';
      button.textContent = label;
      button.onclick = action;
      tools.append(button);
      return button;
    }
    function apply() {
      content.hidden = !detached && Boolean(preferences.hidden);
      frame.classList.toggle('workspace-panel-expanded',!detached && Boolean(preferences.expanded));
      if (toggle) {
        toggle.textContent = preferences.hidden ? 'Show' : 'Hide';
        toggle.setAttribute('aria-expanded',String(!content.hidden));
        size.textContent = preferences.expanded ? 'Restore' : 'Expand';
        size.setAttribute('aria-pressed',String(Boolean(preferences.expanded)));
      }
    }
    function save() {
      try { localStorage.setItem(key,JSON.stringify(preferences)); } catch {}
      apply();
    }
    const toggle = detached ? null : add('Hide',()=>{preferences.hidden=!preferences.hidden; save();});
    const size = detached ? null : add('Expand',()=>{preferences.expanded=!preferences.expanded; preferences.hidden=false; save();});
    add(detached?'Pop in':'Pop out',()=>{
      if (detached) {
        if (window.opener && !window.opener.closed) { window.opener.focus(); window.close(); return; }
        url.searchParams.delete('workspacePanel');
        url.searchParams.delete('section');
        location.assign(url);
        return;
      }
      url.searchParams.set('workspacePanel',tab);
      url.searchParams.set('section',id);
      if (!window.open(url,'royalcab-'+tab+'-'+id,'popup,width=960,height=760')) toast('Allow pop-ups for EASYRIDE to open this panel.',true);
    });
    {
      const summary = document.createElement('span');
      summary.textContent = title;
      tools.prepend(summary);
    }
    apply();
  }
  if (detached && page.dataset.detachedSection) {
    const target = page.querySelector('[data-detached-target]');
    if (target) page.append(target);
  }
}
function accentFirstPopupCard(dialog) {
  dialog.querySelector('.ride-explanation, .fleet-inspector, .notice, .quick-nearest, .candidate-row, .fleet-record-card, .panel, .trip-card')
    ?.classList.add('popup-feature-card');
}
function modal(content, {compact=false} = {}) { const el = $('#modal'); el.innerHTML = `<div class="modal-top"><span class="eyebrow">EASYRIDE</span><button class="icon-btn" id="close-modal" aria-label="Close dialog">×</button></div>${content}`; accentFirstPopupCard(el); el.classList.remove('workspace-dialog-expanded','workspace-dialog-hidden','workspace-dialog-floating'); el.style.removeProperty('--dialog-height'); el.classList.toggle('vehicle-details-dialog',compact); if (!el.open) el.showModal(); else if (!el.matches(':modal')) { el.close(); el.showModal(); } if (!compact) bindDialogLayout(el); $('#close-modal').onclick = () => { el.close(); render(); }; el.oncancel = () => setTimeout(() => { if (!el.open) render(); }); }
function bindDialogLayout(dialog) {
  const header = dialog.querySelector('.modal-top');
  const controls = document.createElement('div');
  controls.className = 'workspace-panel-controls';
  for (const [label, reverse, className] of [
    ['Hide','Show','workspace-dialog-hidden'],
    ['Expand','Restore','workspace-dialog-expanded']
  ]) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn small';
    button.textContent = label;
    button.onclick = () => {
      const changed = dialog.classList.toggle(className);
      button.textContent = changed ? reverse : label;
    };
    controls.append(button);
  }
  const float = document.createElement('button');
  float.type = 'button';
  float.className = 'btn small';
  float.textContent = 'Float';
  float.onclick = () => {
    const floating = dialog.classList.toggle('workspace-dialog-floating');
    dialog.close();
    if (floating) dialog.show(); else dialog.showModal();
    float.textContent = floating ? 'Dock' : 'Float';
    if (!floating) dialog.style.removeProperty('--dialog-height');
  };
  controls.append(float);
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'dialog-resize';
  handle.setAttribute('aria-label','Resize dialog vertically');
  const resize = height => dialog.style.setProperty('--dialog-height',Math.max(120,Math.min(innerHeight*.88,height))+'px');
  handle.onpointerdown = event => {
    if (event.button !== 0) return;
    const start = event.clientY, height = dialog.getBoundingClientRect().height;
    handle.setPointerCapture(event.pointerId);
    handle.onpointermove = move => resize(height+move.clientY-start);
    handle.onlostpointercapture = () => { handle.onpointermove=null; };
  };
  handle.onkeydown = event => {
    if (!['ArrowUp','ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    resize(dialog.getBoundingClientRect().height+(event.key==='ArrowDown'?40:-40));
  };
  header.prepend(controls);
  dialog.append(handle);
}
function tripDetail(id) {
  const t = state.trips.find(t => t.id === id), driver = state.drivers.find(d => d.id === t.driverId);
  modal(`<h2>${esc(t.reference)}</h2><p>${esc(t.customerName)} · ${date(t.pickupAt)} at ${time(t.pickupAt)}</p>${badge(t.status, t.redFlag)}${pairedRideLabel(t)}${rideExplanation(t)}<div class="detail-route">${esc(t.pickup)} ${icon('arrow')} ${esc(t.destination)}</div>${t.isSharedRun?'<section class="notice"><strong>Shared pickup order · '+t.passengers+' passengers total</strong><ol>'+t.sharedStops.map((x,i)=>'<li>'+esc(x.reference)+' · '+esc(x.pickup)+' · '+x.passengers+' passenger(s) · '+(i<(t.collectedStops||0)?'Onboard':i===(t.collectedStops||0)?'Next pickup':'Waiting')+'</li>').join('')+'</ol></section>':''}${tripFacts(t,driver)}<p>${driver ? `<strong>${esc(driver.name)}</strong> · ${esc(driver.vehicle)} · ${esc(driver.plate)}<br><small>Location updated ${time(driver.lastLocationAt)} · ${driver.locationSource==='device'?'Phone GPS':'Simulated GPS'}</small>` : 'No driver assigned yet.'}</p>${t.dispatchError ? `<p class="validation-error">${esc(t.dispatchError)}</p>` : ''}<h3>Trip timeline</h3><div class="timeline">${state.events.filter(e => e.tripId === t.id).slice(0, 10).map(e => `<div><strong>${esc(e.type.replace(/[._]/g, ' '))}</strong><small>${time(e.at)} · ${esc(e.actor)} · ${esc(e.detail)}</small></div>`).join('') || '<p class="muted">Awaiting first update.</p>'}</div>${user.role === 'owner' && t.demoRunId !== 'mongo-lgtc-replay' && active(t) && t.status !== 'onboard' && !t.poolParentId && !(t.collectedStops>0) ? `<button class="btn danger-text" id="detail-cancel">Cancel trip</button>` : ''}`);
  $('#modal h2').dataset.tripDetailId = id;
  if (t.demoRunId === 'mongo-lgtc-replay') return;
  const actions = document.createElement('div');
  actions.className = 'trip-detail-actions';
  actions.setAttribute('role','group');
  actions.setAttribute('aria-label','Ride actions');
  if (user.role === 'owner' && tab !== 'overview' && canShowInDispatch(t)) {
    const button = document.createElement('button');
    button.className = 'btn primary'; button.textContent = 'Show in Dispatch';
    button.onclick = () => focusDispatchRide(t.id); actions.append(button);
  }
  if(user.role==='owner'&&t.poolParentId){const b=document.createElement('button');b.className='btn primary';b.textContent='Open shared car run';b.onclick=()=>tripDetail(t.poolParentId);actions.append(b);}
  if(user.role==='owner'&&t.isSharedRun&&!t.driverId){const b=document.createElement('button');b.className='btn';b.textContent='Split back into separate bookings';b.onclick=()=>run(()=>sendAction(t.id,'unpool'));actions.append(b);}
  if(user.role==='owner'){const button=document.createElement('button');button.className='btn';button.textContent='Review driver selection';button.onclick=()=>reviewDispatch(id);actions.append(button);}
  if(user.role==='owner'&&['awaiting_driver','needs_reassignment','offered'].includes(t.status)){const b=document.createElement('button');b.className='btn primary';b.textContent='Choose driver';b.onclick=()=>run(()=>chooseDriver(id));actions.append(b);}
  if(user.role==='owner'&&canReplaceConfirmed(t)){const b=document.createElement('button');b.className='btn danger-text';b.textContent='Replace driver';b.onclick=()=>replaceConfirmed(t.id);actions.append(b);}
  if(user.role==='owner'&&!t.isSharedRun){const b=document.createElement('button');b.className='btn';b.textContent=t.preferredDriver?'Regular driver: '+t.preferredDriver.name:'Set regular driver';b.onclick=()=>regularDriverModal(t.id);actions.append(b);}
  const cancel = document.querySelector('#detail-cancel');
  if (cancel) {
    cancel.onclick = () => confirmAction(t.id, 'cancel');
    actions.append(cancel);
  }
  if (user.role === 'owner' && ['awaiting_driver', 'needs_reassignment'].includes(t.status)) {
    const button = document.createElement('button'); button.className = 'btn'; button.textContent = 'Retry driver search';
    button.onclick = () => run(() => sendAction(t.id, 'retry')); actions.append(button);
  }
  if (actions.childElementCount) document.querySelector('#modal h2').after(actions);
}
function canReplaceConfirmed(trip) {
  return !!trip.driverId&&!trip.poolParentId&&!trip.collectedStops&&['accepted','heading_to_pickup','arrived'].includes(trip.status);
}
function replaceConfirmed(id) {
  const trip=state.trips.find(t=>t.id===id);
  if(!trip||!canReplaceConfirmed(trip)){toast('This assignment has changed. Review the current ride status.',true);return;}
  const driver=state.drivers.find(d=>d.id===trip.driverId);
  modal('<h2>Replace confirmed driver</h2><p>'+esc(trip.reference)+' · '+esc(driver?.name||'Current driver')+
    '</p><p>This will withdraw the assignment, take the driver offline, and return the booking to Needs Attention.</p>'+
    '<form id="replace-confirmed-form"><label>Reason<select name="reason"><option>Driver unreachable</option><option>Vehicle issue</option><option>Driver requested replacement</option><option>Dispatch correction</option></select></label>'+
    '<button class="btn primary" type="submit">Withdraw assignment</button></form>');
  $('#replace-confirmed-form').onsubmit=e=>{
    e.preventDefault();
    const reason=e.currentTarget.elements.reason.value;
    run(()=>sendAction(id,'release',{driverId:trip.driverId,reason}));
  };
}
async function sendAction(id, action, extra = {}) {
  const openedDialog = $('dialog[open]');
  const dialogContent = openedDialog?.firstElementChild;
  await api(`/api/trips/${id}/action`, { action, ...extra }, requestId());
  if (openedDialog?.open && openedDialog.firstElementChild === dialogContent) openedDialog.close();
  await refresh(); toast(action === 'offer' ? 'Offer sent. Waiting for the driver to accept.' : action === 'release' ? 'Trip reopened with a red flag. Replacement dispatch will retry automatically.' : 'Trip updated.');
}
function confirmRideComplete(id) {
  const trip = state.trips.find(t=>t.id===id);
  if (user.role !== 'driver' || !trip || trip.driverId !== user.driverId || trip.status !== 'onboard') return;
  const key = requestId();
  modal('<section class="complete-ride-dialog"><span class="completion-icon">' + icon('check') +
    '</span><h2>Finish this ride?</h2><p>' + esc(trip.reference) + ' · Drop-off at <strong>' + esc(trip.destination) +
    '</strong></p><p>Tap Done after all passengers have been dropped off.</p><p class="validation-error" id="complete-ride-error" role="alert"></p>' +
    '<div class="card-actions"><button class="btn primary" id="complete-ride-done">Done</button><button class="btn" id="complete-ride-back">Keep ride open</button></div></section>');
  const dialog = $('#modal'), done = $('#complete-ride-done'), back = $('#complete-ride-back'), close = $('#close-modal');
  back.onclick = () => close.click();
  const cancel = dialog.oncancel;
  dialog.oncancel = event => { if (done.disabled) event.preventDefault(); else cancel(); };
  done.onclick = async () => {
    done.disabled = back.disabled = close.disabled = true;
    done.textContent = 'Saving…';
    try {
      await api('/api/trips/' + encodeURIComponent(id) + '/action', { action:'complete' },key);
    } catch (error) {
      if (dialog.open && done.isConnected) {
        $('#complete-ride-error').textContent = error.message;
        done.textContent = 'Done';
        done.disabled = back.disabled = close.disabled = false;
      }
      return;
    }
    if (done.isConnected) dialog.close();
    await run(refresh);
    toast('Ride completed. Dispatch has been updated.');
  };
}
function confirmAction(id, action, offerId) {
  if (action === 'decline') reasonModal(id, 'decline', offerId);
  else if (action === 'complete') confirmRideComplete(id);
  else if (action === 'cancel') { modal('<h2>Cancel this trip?</h2><p>The trip will leave the active dispatch queue.</p><button class="btn red-btn" id="confirm-action">Confirm cancellation</button>'); $('#confirm-action').onclick = () => run(() => sendAction(id, action)); }
  else run(() => sendAction(id, action, { offerId }));
}
function reasonModal(id, action, offerId) {
  const release = action === 'release', reasons = release ? config.releaseReasons : config.declineReasons;
  modal(`<h2>${release ? 'Drop this trip?' : 'Decline this offer?'}</h2><p>${release ? 'The trip will reopen with a red reassignment flag.' : 'Dispatch will offer this trip to another eligible driver.'} Choose a reason—no typing needed.</p><div class="notice">Respond only when safely stopped. You can leave an offer unanswered; it will expire automatically.</div><div class="reason-options">${reasons.map(reason => `<button class="btn ${release ? 'danger-text' : ''}" data-reason="${esc(reason)}">${esc(reason)} ${icon('arrow')}</button>`).join('')}</div><p class="help">Tapping a reason ${release ? 'drops the trip and notifies' : 'declines the offer and informs'} dispatch.</p>`);
  document.querySelectorAll('[data-reason]').forEach(el => el.onclick = () => run(async () => {
    document.querySelectorAll('[data-reason]').forEach(button => { button.disabled = true; });
    try { await sendAction(id, action, { offerId, reason: el.dataset.reason }); }
    finally { document.querySelectorAll('[data-reason]').forEach(button => { button.disabled = false; }); }
  }));
}
function fleetImportPage(){
  return ownerPageHeading('Fleet data upload','Import vehicle records or a driver list from Excel.')+
    '<section class="panel upload-panel"><form id="fleet-import-form"><label>Fleet workbook (.xlsx)<input type="file" name="file" accept=".xlsx" required></label><p>For older .xls files, save a copy as .xlsx first. Vehicle sheets require a VIN column. Driver sheets require Driver Name.</p><button class="btn primary">Import fleet records</button></form><p id="fleet-import-status" role="status"></p></section><section class="panel upload-panel"><h2>Validate completed roster</h2><form id="roster-validate"><label>Completed roster (.xlsx)<input type="file" name="roster" accept=".xlsx" required></label><button class="btn primary" value="validate">Validate roster</button> <button class="btn" value="apply">Apply roster</button></form><p id="roster-result" role="status"></p><ol id="roster-issues"></ol></section>';
}
const appearanceOptions = [['default','Royal Blue'],['teal','Teal'],['violet','Violet'],['light','Light']];
try {
  document.documentElement.dataset.appearance = localStorage.getItem('royalcab.appearance') || 'default';
} catch {}
function appearanceControl() {
  return '<section class="panel settings-panel"><h2>Appearance</h2><label>App colors<select id="app-appearance">'+
    appearanceOptions.map(([value,label])=>'<option value="'+value+'" '+(document.documentElement.dataset.appearance===value?'selected':'')+'>'+label+'</option>').join('')+
    '</select></label></section>';
}
function driverPaySettingsPanel() {
  if (!config.driverPay) return '';
  return '<section class="panel settings-panel"><form id="driver-pay-rates"><h2>Driver pay rates</h2>'+
    '<label>Driver<select name="driverId" required><option value="">Choose a driver</option></select></label>'+
    '<label>Rate type<select name="basis"><option value="mile">Per mile</option><option value="hour">Per hour</option></select></label>'+
    '<label>Rate (USD)<input name="rate" type="number" min="0.01" max="1000" step="0.01" required></label>'+
    '<button type="submit" class="btn primary" disabled>Save rate</button><p role="status">Loading drivers…</p></form></section>';
}
let driverPayDate='';
const payMoney = cents => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(cents/100);
function driverPayPanel() {
  if (!config.driverPay || user.role!=='driver') return '';
  return '<section class="panel settings-panel" id="driver-pay-history"><h2>Trip earnings</h2>'+
    '<label>Pay date (ET)<input type="date" value="'+esc(driverPayDate)+'"></label>'+
    '<p role="status">Loading trip earnings…</p><div data-pay-rides></div></section>';
}
function bindDriverPay() {
  const form=$('#driver-pay-rates');
  if (form) {
    const {driverId,basis,rate}=form.elements;
    const status=form.querySelector('[role=status]');
    const save=form.querySelector('button');
    let rates=[];
    const selectRate=()=>{
      const selected=rates.find(driver=>driver.id===driverId.value);
      basis.value=selected?.basis||'mile';
      rate.value=selected?.rateCents==null?'':(selected.rateCents/100).toFixed(2);
      save.disabled=!selected;
    };
    driverId.onchange=selectRate;
    api('/api/driver-pay/rates').then(result=>{
      if(!form.isConnected) return;
      rates=result.drivers;
      driverId.append(...rates.map(driver=>new Option(driver.name,driver.id)));
      status.textContent='Rates apply when a trip is completed. Hourly pay covers pickup through drop-off.';
    }).catch(error=>{status.textContent=error.message;});
    form.onsubmit=async event=>{
      event.preventDefault();
      const selected=rates.find(driver=>driver.id===driverId.value);
      if(!selected || !form.reportValidity()) return;
      const values={driverId:selected.id,basis:basis.value,rateCents:Math.round(Number(rate.value)*100)};
      save.disabled=true;
      try {
        await api('/api/driver-pay/rates',values);
        Object.assign(selected,values);
        status.textContent='Rate saved for '+selected.name+'.';
      } catch(error) { status.textContent=error.message; }
      finally { save.disabled=!driverId.value; }
    };
  }
  const panel=$('#driver-pay-history');
  if (!panel) return;
  const date=panel.querySelector('input');
  const status=panel.querySelector('[role=status]');
  const result=panel.querySelector('[data-pay-rides]');
  let sequence=0;
  const load=async()=>{
    const request=++sequence;
    status.textContent='Loading trip earnings…';
    result.replaceChildren();
    try {
      const summary=await api('/api/driver-pay/day'+(date.value?'?date='+encodeURIComponent(date.value):''));
      if(request!==sequence || !panel.isConnected) return;
      date.value=driverPayDate=summary.date;
      const pending=summary.rides.filter(ride=>ride.amountCents===null).length;
      status.textContent=payMoney(summary.totalCents)+' calculated total'+(pending?' · '+pending+' pending calculation':'');
      result.innerHTML=summary.rides.length?'<div class="table-scroll"><table><thead><tr><th>Trip</th><th>Basis</th><th>Amount</th></tr></thead><tbody>'+
        summary.rides.map(ride=>'<tr><td>'+esc(ride.reference)+'</td><td>'+
          esc(ride.basis && ride.rateCents!==null ? payMoney(ride.rateCents)+' / '+ride.basis : 'Rate missing')+'</td><td>'+
          (ride.amountCents===null?'Pending calculation':payMoney(ride.amountCents))+'</td></tr>').join('')+
        '</tbody></table></div>':'<p>No completed trips recorded for this date.</p>';
    } catch(error) { if(request===sequence&&panel.isConnected)status.textContent=error.message; }
  };
  date.onchange=()=>{driverPayDate=date.value;void load();};
  void load();
}
function settingsPage(){
  const s=state.settings||{};
  return heading('OPERATIONS SETTINGS','Dispatch settings','These settings apply to automatic assignment and one-time customer reminders.')+driverPaySettingsPanel()+
    '<section class="panel settings-panel"><form id="operations-settings"><h2>Automatic driver offers</h2><p>Start looking for the nearest eligible driver this many minutes before pickup.</p><div class="timing-presets"><button type="button" class="btn" data-timing="10" data-timing-field="dispatch-lead">10 minutes</button><button type="button" class="btn" data-timing="15" data-timing-field="dispatch-lead">15 minutes</button></div><label>Driver-offer lead time (minutes)<input id="dispatch-lead" type="number" min="1" max="180" step="1" required value="'+(s.dispatchLeadMinutes||15)+'"></label><h2>Urgent pickup recovery</h2><p>After a declined or expired offer, alert a small group when pickup is close. The first acceptance wins.</p><label class="checkbox-label"><input id="urgent-enabled" type="checkbox" '+(s.urgentGroupEnabled?'checked':'')+'> Enable urgent group offers</label><label>Urgent window (minutes before pickup)<input id="urgent-minutes" type="number" min="1" max="30" required value="'+(s.urgentGroupMinutes||5)+'"></label><label>Drivers per group<select id="urgent-size"><option value="2" '+(s.urgentGroupSize===2?'selected':'')+'>2 drivers</option><option value="3" '+(s.urgentGroupSize!==2?'selected':'')+'>3 drivers</option></select></label><h2>Customer pickup reminder</h2><p>Send once before pickup, after a driver has confirmed. If confirmation happens inside this window, the confirmation message covers the reminder.</p><label class="checkbox-label"><input id="reminders-enabled" type="checkbox" '+(s.customerRemindersEnabled?'checked':'')+'> Enable customer pickup reminders</label><div class="timing-presets"><button type="button" class="btn" data-timing="10" data-timing-field="reminder-lead">10 minutes</button><button type="button" class="btn" data-timing="15" data-timing-field="reminder-lead">15 minutes</button></div><label>Customer reminder lead time (minutes)<input id="reminder-lead" type="number" min="1" max="180" step="1" required value="'+(s.customerReminderMinutes||10)+'"></label><h2>Confirmation message</h2><p>Queued immediately when the driver accepts. Includes pickup time, driver name and phone, car model, plate and destination.</p><label>Company name<input id="company-name" required maxlength="80" value="'+esc(s.companyName||'EASYRIDE')+'"></label><label>Message timezone<input id="message-timezone" required value="'+esc(s.timezone||'America/New_York')+'"></label><div class="notice">'+icon('bell')+' Demo delivery: messages are saved in Messages and the customer app. No SMS leaves this computer.</div><button class="btn primary" type="submit">Save settings</button></form></section>';
}
function messagesPage(){
  const messages=(state.customerMessages||[]).slice(0,100);
  return heading(user.role==='owner'?'CUSTOMER COMMUNICATION':'RIDE UPDATES',user.role==='owner'?'Customer updates':'Your ride updates.','Confirmation, pickup reminders, and assignment changes.')+
    '<div class="notice">'+icon('bell')+' Demo messages only. A real SMS service has not been connected; none of these messages were sent as texts.</div><section class="panel message-list">'+(messages.length?messages.map(m=>'<article class="customer-message '+(m.superseded?'superseded':'')+'"><div class="record-main"><strong>'+esc(({stage_depart:'Driver on the way',stage_arrive:'Driver arrived',stage_pickup:'Ride underway',stage_complete:'Ride completed',confirmed:'Ride confirmed',pickup_reminder:'Pickup reminder',released:'Driver replacement',cancelled:'Ride cancelled'})[m.type]||m.type)+'</strong><span class="badge '+(m.superseded?'cancelled':'offered')+'">'+(m.superseded?'Old details — replaced':'Demo · not sent')+'</span></div><p class="message-meta">'+esc(m.reference)+' · '+esc(m.customerName)+' · '+esc(m.recipient)+' · '+date(m.createdAt)+' '+time(m.createdAt)+'</p><p class="message-body">'+esc(m.text)+'</p></article>').join(''):'<div class="empty"><h3>No customer messages yet</h3><p>A confirmation is created when a driver accepts a ride.</p></div>')+'</section><p class="help">Showing the latest '+messages.length+' messages. Confirmation and reminder entries are deduplicated per driver assignment.</p>';
}
function localInputDate(d){const date=new Date(d);date.setMinutes(date.getMinutes()-date.getTimezoneOffset());return date.toISOString().slice(0,10);}
function reportQuery(){
  const from=new Date(reportFrom+'T00:00:00'),to=new Date(reportTo+'T00:00:00');to.setDate(to.getDate()+1);
  if(!Number.isFinite(from.getTime())||!Number.isFinite(to.getTime())||from>=to)throw Error('Choose a valid report date range');
  return new URLSearchParams({group:reportGroup,from:from.toISOString(),to:to.toISOString()}).toString();
}
async function generateReport(keepVisible = false){
  const query=reportQuery(),requestId=++reportRequestId;
  if (!keepVisible) { reportData=null;reportLoading=true;render(); }
  try{const result=await api('/api/reports?'+query);if(requestId!==reportRequestId)return;reportData=result;reportData.generatedAt=Date.now();}
  finally{if(requestId===reportRequestId){reportLoading=false;if(tab==='reports')render();}}
}
function reportsPage(){
  if(!reportFrom){const first=new Date();first.setDate(1);reportFrom=localInputDate(first);reportTo=localInputDate(new Date());}
  const fields=reportGroup==='driver'?[['name','Driver'],['id','Driver ID'],['offered','Offers'],['declined','Declines'],['timedOut','Timeouts'],['assignments','Assignments'],['completed','Completed'],['released','Dropped'],['cancelled','Cancelled'],['active','Active'],['unrecorded','Outcome not recorded'],['onboardMinutes','Recorded minutes onboard']]:[['name','Plate'],['detail','Vehicle'],['assignments','Assignments'],['completed','Completed'],['released','Dropped'],['cancelled','Cancelled'],['active','Active'],['unrecorded','Outcome not recorded'],['onboardMinutes','Recorded minutes onboard']];
  return heading('FLEET REPORTING','Reports','Counts come from recorded offers and assignment history. No estimated revenue or distance is added.')+
    '<section class="panel"><form id="report-filters" class="report-filters"><div class="filter-tabs">'+[['driver','By driver'],['vehicle','By car']].map(([id,label])=>'<button type="button" data-report-group="'+id+'" class="'+(reportGroup===id?'selected':'')+'">'+label+'</button>').join('')+'</div><label>From<input id="report-from" type="date" required value="'+reportFrom+'"></label><label>Through<input id="report-to" type="date" required value="'+reportTo+'"></label><button class="btn primary" type="submit">Generate report</button></form>'+
    (reportData?'<div class="report-summary"><span><strong>'+reportData.summary.trips+'</strong> Scheduled trips</span><span><strong>'+reportData.summary.completedTrips+'</strong> Completed</span><span><strong>'+reportData.summary.cancelledTrips+'</strong> Cancelled</span><span><strong>'+reportData.summary.unassigned+'</strong> Unassigned</span><a class="btn" href="/api/reports.csv?'+esc(reportQuery())+'">Download CSV</a></div><div class="table-scroll"><table class="report-table"><thead><tr>'+fields.map(([,label])=>'<th>'+label+'</th>').join('')+'</tr></thead><tbody>'+reportData.rows.map(row=>'<tr>'+fields.map(([key,label])=>'<td data-label="'+esc(label)+'">'+esc(row[key]??'—')+'</td>').join('')+'</tr>').join('')+'</tbody></table></div>'+(reportData.rows.length?'':'<div class="empty"><p>No matching activity in this period.</p></div>')+'<div class="report-note">Generated '+time(reportData.generatedAt)+'. Date basis: scheduled pickup, in '+esc(Intl.DateTimeFormat().resolvedOptions().timeZone)+'. Reassignments count as separate assignments. Minutes include only recorded start/end times. '+(reportData.legacyTrips?reportData.legacyTrips+' older trip(s) lack assignment snapshots; missing cars are shown as Vehicle not recorded.':'Vehicle identity is preserved at acceptance.')+'</div>':reportLoading?'<div class="empty" role="status"><h3>Generating report…</h3></div>':'<div class="empty"><h3>Choose dates, then generate your report.</h3><p>Switch between driver and car totals and download either report as CSV.</p></div>')+'</section>';
}
function bindOperations(){
  if($('#workspace-navigation'))$('#workspace-navigation').onchange=e=>{tab=e.target.value;settingsDirty=false;search='';filter='all';render();};
  document.querySelectorAll('[data-timing]').forEach(button=>button.onclick=()=>{$('#'+button.dataset.timingField).value=button.dataset.timing;settingsDirty=true;});
  if($('#operations-settings'))$('#operations-settings').oninput=()=>{settingsDirty=true;};
  if($('#operations-settings'))$('#operations-settings').onsubmit=e=>{e.preventDefault();run(async()=>{
    await api('/api/settings',{urgentGroupEnabled:$('#urgent-enabled').checked,urgentGroupMinutes:+$('#urgent-minutes').value,urgentGroupSize:+$('#urgent-size').value,dispatchLeadMinutes:+$('#dispatch-lead').value,customerReminderMinutes:+$('#reminder-lead').value,customerRemindersEnabled:$('#reminders-enabled').checked,companyName:$('#company-name').value,timezone:$('#message-timezone').value});settingsDirty=false;await refresh();toast('Pickup timing saved. New offers and reminders use these settings.');
  });};
  if($('#report-filters'))$('#report-filters').onsubmit=e=>{e.preventDefault();run(async()=>{reportFrom=$('#report-from').value;reportTo=$('#report-to').value;await generateReport();});};
  document.querySelectorAll('[data-report-group]').forEach(button=>button.onclick=()=>run(async()=>{reportFrom=$('#report-from').value;reportTo=$('#report-to').value;reportGroup=button.dataset.reportGroup;reportData=null;await generateReport();}));
}
function dispatchLead(){return state?.settings?.dispatchLeadMinutes||15;}
function rideExplanation(t){const r=ProLiftRideExplanation.explain(state,t,user.role);return '<section class="ride-explanation '+(r.late?'late':'')+'"><strong>'+esc(r.title)+'</strong><p>'+esc(r.meaning)+'</p><small>NEXT STEP</small><p>'+esc(r.next)+'</p></section>';}
function tripFacts(t,driver) {
  const target=config.places.find(p=>p.name===(t.status==='onboard'?t.destination:t.pickup));
  const eta=driver&&target&&Number.isFinite(driver.lat)&&Number.isFinite(driver.lng)?Math.max(1,Math.ceil(Math.hypot((driver.lat-target.lat)*111,(driver.lng-target.lng)*84)*1.25/.5)):null;
  const started=state.events.find(e=>e.tripId===t.id&&e.type==='trip.onboard');
  const fields=[['Passenger',t.customerName],['Passenger mobile',t.isSharedRun?'See individual pickup bookings':t.customerPhone],['Scheduled pickup',date(t.pickupAt)+' · '+time(t.pickupAt)],['Passengers / vehicle needs',t.passengers+' · '+((t.requirements||[]).join(', ')||'Standard')],['Current stage',labels[t.status]||t.status],['Trip started',started?time(started.at):'Not picked up yet'],[t.status==='onboard'?'Drop-off ETA (demo)':'Pickup ETA (demo)',t.status==='arrived'?'At pickup':eta===null?'Not available':eta+' min · '+time(Date.now()+eta*60000)],['Driver mobile',driver?.phone||'—']];
  return '<dl class="trip-facts">'+fields.map(([name,value])=>'<div><dt>'+esc(name)+'</dt><dd>'+esc(value)+'</dd></div>').join('')+'</dl>';
}
function activeRideDetails(rides) {
  return '<section class="panel onride-details"><div class="panel-heading"><div><h2>Active ride details</h2><p>Select a ride for its full timeline and contacts.</p></div></div><div class="active-ride-cards">'+(rides.length?rides.map(t=>{const d=state.drivers.find(d=>d.id===t.driverId);return '<article><div class="record-main"><h3>'+esc(d?.name||'Driver')+'</h3>'+badge(t.status)+'</div><p><strong>'+esc(t.reference)+'</strong> · '+esc(t.customerName)+'</p><p>'+esc(t.pickup)+' → '+esc(t.destination)+'</p><small>Pickup '+date(t.pickupAt)+' '+time(t.pickupAt)+' · '+esc(d?.vehicle||'')+' · '+esc(d?.plate||'')+'</small><button class="btn full" data-detail="'+t.id+'">Full ride details</button></article>';}).join(''):'<div class="empty"><p>No rides currently active.</p></div>')+'</div></section>';
}
function scheduleRideCard(t, now) {
  const driver=state.drivers.find(d=>d.id===t.driverId);
  const offer=state.offers.find(o=>o.tripId===t.id&&o.status==='pending'&&o.expiresAt>now);
  const candidate=offer&&state.drivers.find(d=>d.id===offer.driverId);
  const planned=state.drivers.find(d=>d.id===t.plannedDriverId);
  const opens=t.pickupAt-dispatchLead()*60000;
  const issue=ProLiftBoard.attentionReason(t,now,dispatchLead());
  const late=t.pickupAt<now&&!['arrived','onboard'].includes(t.status);
  const stage={accepted:'Confirmed',heading_to_pickup:'En route to pickup',arrived:'At pickup',onboard:'Onboard'}[t.status];
  const name=driver?.name||candidate?.name||t.reservedDriverName||planned?.name||'Unassigned';
  const assignment=driver?(stage||'Confirmed'):offer?'Offer awaiting acceptance':t.reservedDriverId?'Provisional reservation':
    planned?'Planned driver':opens>now?'Offers open '+date(opens)+' at '+time(opens):'No confirmed driver';
  const label=late?'Pickup overdue':issue?(t.redFlag?'Replacement needed':'Needs review'):stage||
    (offer?'Offer pending':t.reservedDriverId?'Reserved':opens>now?'Scheduled':'Finding driver');
  const tone=late||issue?'warning':t.status==='onboard'?'onboard':driver?'confirmed':offer?'pending':'planned';
  const test=t.demoRunId||t.testData||t.lgtc?.test;
  const titleId='schedule-title-'+t.id;
  return '<article class="schedule-ride schedule-'+tone+'" role="listitem" aria-labelledby="'+esc(titleId)+'">'+
    '<div class="schedule-time-tile"><span>Pickup</span><strong>'+time(t.pickupAt)+'</strong><small>'+date(t.pickupAt)+'</small></div>'+
    '<div class="schedule-rider"><h3 id="'+esc(titleId)+'">'+esc(t.customerName)+'</h3><p>'+esc(t.reference)+' · '+t.passengers+' '+(t.passengers===1?'rider':'riders')+
    (test?' <span class="schedule-test-label">Test</span>':'')+'</p></div>'+
    '<div class="schedule-route" aria-label="Ride route"><div><i></i><span><small>Pickup</small><strong>'+esc(t.pickup)+'</strong></span></div>'+
    '<div><i></i><span><small>Drop-off</small><strong>'+esc(t.destination)+'</strong></span></div></div>'+
    '<div class="schedule-assignment"><strong>'+esc(name)+'</strong><small>'+esc(assignment)+'</small></div>'+
    '<div class="schedule-action"><span class="schedule-status">'+esc(label)+'</span><button class="btn small '+(issue||late?'schedule-review':'')+'" data-detail="'+esc(t.id)+'" aria-label="'+
    (issue||late?'Review ride ':'View ride ')+esc(t.reference)+'">'+(issue||late?'Review ride':'View details')+'</button></div></article>';
}
function schedulePageView() {
  const now=lastSnapshotAt||Date.now();
  const view=ProLiftBoard.schedule(state.trips,{now,period:schedulePeriod,search:scheduleSearch,page:schedulePage});
  schedulePage=view.page;
  return heading('DISPATCH SCHEDULE','Upcoming rides','Current rides, overdue pickups, and upcoming bookings.')+
    '<section class="panel schedule-board"><div class="table-toolbar schedule-toolbar"><div class="filter-tabs" aria-label="Pickup period">'+
    [['priority','Current & next hour'],['today','Today'],['tomorrow','Tomorrow'],['week','Next 7 days'],['all','All upcoming']].map(([id,label])=>
      '<button data-schedule-period="'+id+'" aria-pressed="'+(schedulePeriod===id)+'" class="'+(schedulePeriod===id?'selected':'')+'">'+label+'</button>').join('')+
    '</div><label class="search">'+icon('search')+'<input id="schedule-search" type="search" placeholder="Find a ride" aria-label="Search upcoming rides" value="'+esc(scheduleSearch)+'"></label></div>'+
    (view.rows.length?'<div class="schedule-ride-list" role="list" aria-label="Scheduled rides">'+view.rows.map(t=>scheduleRideCard(t,now)).join('')+'</div>':
      '<div class="empty"><h3>No rides in this period</h3><p>Choose another period, change your search, or import a schedule.</p></div>')+
    '<div class="pagination"><span>'+view.start+'–'+view.end+' of '+view.total+' rides</span><button class="btn small" data-schedule-page="'+(view.page-1)+'" '+(view.page===1?'disabled':'')+
    '>Previous</button><span>Page '+view.page+' of '+view.pages+'</span><button class="btn small" data-schedule-page="'+(view.page+1)+'" '+(view.page===view.pages?'disabled':'')+
    '>Next</button></div></section><p class="help">Times shown in '+esc(Intl.DateTimeFormat().resolvedOptions().timeZone)+'. Automatic offers open '+dispatchLead()+' minutes before pickup.</p>';
}
function bindMapControls() {
  const svg=$('#live-fleet-map');if(!svg)return;
  const points=new Map();let last=null,lastDistance=0,wheelTimer;
  function draw(){svg.setAttribute('viewBox',[mapCamera.x,mapCamera.y,mapCamera.width,mapCamera.height].join(' '));if($('#map-zoom'))$('#map-zoom').textContent=Math.round(800/mapCamera.width*100)+'%';}
  function anchoredZoom(factor,clientX,clientY){const p=svg.createSVGPoint();p.x=clientX;p.y=clientY;const world=p.matrixTransform(svg.getScreenCTM().inverse());mapCamera=ProLiftMapCamera.zoom(mapCamera,factor,(world.x-mapCamera.x)/mapCamera.width,(world.y-mapCamera.y)/mapCamera.height);draw();}
  document.querySelectorAll('[data-map-control]').forEach(button=>button.onclick=()=>{
    const command=button.dataset.mapControl;
    if(command==='fit'){mapBounds=null;mapCamera=ProLiftMapCamera.create();render();return;}
    if(command==='driver'){const id=selectedDriverId||$('.fleet-chip.selected')?.dataset.fleetDriver;const pin=[...svg.querySelectorAll('.fleet-map-pin')].find(pin=>pin.dataset.fleetDriver===id);if(!pin){toast('Select a driver visible on this map first.');return;}const m=pin.transform.baseVal.consolidate().matrix;mapCamera=ProLiftMapCamera.center(mapCamera,m.e,m.f);}
    else mapCamera=ProLiftMapCamera.zoom(mapCamera,command==='in'?.75:1/.75);
    draw();
  });
  svg.addEventListener('wheel',e=>{e.preventDefault();mapInteracting=true;anchoredZoom(e.deltaY<0?.85:1/.85,e.clientX,e.clientY);clearTimeout(wheelTimer);wheelTimer=setTimeout(()=>{mapInteracting=false;},250);},{passive:false});
  svg.onpointerdown=e=>{if(e.button!==0&&e.pointerType==='mouse')return;points.set(e.pointerId,{x:e.clientX,y:e.clientY});mapInteracting=true;last={x:e.clientX,y:e.clientY};mapMoved=false;if(points.size===2){const p=[...points.values()];lastDistance=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);}};
  svg.onpointermove=e=>{
    if(!points.has(e.pointerId))return;points.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(points.size===2){const p=[...points.values()],distance=Math.hypot(p[0].x-p[1].x,p[0].y-p[1].y);if(lastDistance&&distance>0)anchoredZoom(lastDistance/distance,(p[0].x+p[1].x)/2,(p[0].y+p[1].y)/2);lastDistance=distance;mapMoved=true;}
    else if(last){const dx=e.clientX-last.x,dy=e.clientY-last.y;if(mapMoved||Math.abs(dx)+Math.abs(dy)>3){mapMoved=true;const m=svg.getScreenCTM();mapCamera=ProLiftMapCamera.pan(mapCamera,-dx/m.a,-dy/m.d);draw();svg.classList.add('dragging');svg.setPointerCapture(e.pointerId);}}
    last={x:e.clientX,y:e.clientY};
  };
  function release(e){points.delete(e.pointerId);if(svg.hasPointerCapture(e.pointerId))svg.releasePointerCapture(e.pointerId);lastDistance=0;last=null;if(!points.size){mapInteracting=false;svg.classList.remove('dragging');setTimeout(()=>{mapMoved=false;},100);}}
  svg.onpointerup=release;svg.onpointercancel=release;
  svg.onkeydown=e=>{const moves={ArrowLeft:[-.1,0],ArrowRight:[.1,0],ArrowUp:[0,-.1],ArrowDown:[0,.1]};if(moves[e.key]){e.preventDefault();mapCamera=ProLiftMapCamera.pan(mapCamera,moves[e.key][0]*mapCamera.width,moves[e.key][1]*mapCamera.height);}else if(['+','=','-'].includes(e.key)){e.preventDefault();mapCamera=ProLiftMapCamera.zoom(mapCamera,e.key==='-'?1/.75:.75);}else return;draw();};
}

var scheduledData=null,scheduledPageNumber=1;
function rideExtras(t){
 const stage={awaiting_driver:'Scheduled — waiting for a driver',offered:'Finding your driver — acceptance pending',accepted:'Driver confirmed',heading_to_pickup:'Your driver is on the way',arrived:'Your driver has arrived at pickup',onboard:'Ride in progress',completed:'You have arrived',cancelled:'Ride cancelled',needs_reassignment:'Finding a replacement driver'}[t.status];
 return '<div class="ride-progress" role="status"><strong>'+esc(stage)+'</strong><div class="progress-steps">'+['Scheduled','Confirmed','Pickup','Completed'].map((label,i)=>'<span class="'+(i<=({accepted:1,heading_to_pickup:1,arrived:2,onboard:2,completed:3}[t.status]||0)?'done':'')+'">'+label+'</span>').join('')+'</div></div><div class="card-actions"><button class="btn" data-help-trip="'+t.id+'">Get trip help</button>'+(t.status==='completed'?'<a class="btn" href="/api/trips/'+t.id+'/summary.txt">Download ride summary</a>':'')+'</div>';
}
function scheduledPage(){return heading('PLAN YOUR WORK','Scheduled rides','Reserve a future pickup. Go online before dispatch opens and accept the live offer to confirm it.')+'<div class="notice">Reservations are provisional. Unavailable drivers are replaced automatically. Routes and travel times are simulated.</div><button class="btn" id="load-scheduled">Refresh scheduled rides</button>'+(scheduledData?'<div class="trip-card-grid">'+scheduledData.trips.map(t=>'<article class="panel trip-card"><strong>'+esc(t.reference)+'</strong><h2>'+date(t.pickupAt)+' · '+time(t.pickupAt)+'</h2><p>'+esc(t.pickup)+' → '+esc(t.destination)+'</p><p>'+t.passengers+' passenger(s) · '+esc(t.requirements.join(', ')||'Standard vehicle')+'</p><p>Be online by '+time(t.window.startsAt)+'. Acceptance required.</p>'+(t.reservation?'<span class="badge accepted">Reserved by you</span><button class="btn" data-unreserve="'+t.id+'">Release reservation</button>':'<button class="btn primary" data-reserve="'+t.id+'" '+(!t.suitable?'disabled':'')+'>Reserve pickup</button>')+'</article>').join('')+'</div><div class="pagination"><button class="btn" data-scheduled-page="'+(scheduledData.page-1)+'" '+(scheduledData.page<=1?'disabled':'')+'>Previous</button><span>'+scheduledData.total+' rides · Page '+scheduledData.page+' / '+scheduledData.pages+'</span><button class="btn" data-scheduled-page="'+(scheduledData.page+1)+'" '+(scheduledData.page>=scheduledData.pages?'disabled':'')+'>Next</button></div>':'<section class="panel empty"><h2>Find work for the next 7 days.</h2><p>Select Refresh scheduled rides to load available pickups.</p></section>');}
function helpPage(title='Help requests'){return heading('TRIP SUPPORT',title,'Send a request from the ride card. Replies from your fleet owner appear here.')+'<div class="notice">Local demo inbox. Requests are saved for the owner; this is not a staffed emergency service.</div><div class="trip-card-grid">'+((state.supportRequests||[]).length?(state.supportRequests||[]).map(r=>'<article class="panel trip-card"><div class="trip-card-head"><strong>'+esc(r.reference)+'</strong>'+badge(r.status)+'</div><h2>'+esc(r.category.replaceAll('_',' '))+'</h2><p>'+esc(r.details)+'</p><small>'+date(r.createdAt)+' · '+time(r.createdAt)+'</small>'+(r.ownerReply?'<p><strong>Owner reply:</strong> '+esc(r.ownerReply)+'</p>':'')+(user.role==='owner'?'<button class="btn" data-help-review="'+r.id+'">Review request</button>':'')+'</article>').join(''):'<section class="panel empty"><h2>No help requests.</h2><p>Use Get trip help on a ride to start a request.</p></section>')+'</div>';}
setInterval(()=>document.querySelectorAll('[data-offer-countdown]').forEach(el=>{const seconds=offerSecondsRemaining(Number(el.dataset.offerCountdown));el.textContent=seconds?seconds+' seconds to respond':'Offer expired — waiting for dispatch';}),1000);
function bindRideFeatures(){
 const load=()=>run(async()=>{scheduledData=await api('/api/driver/scheduled?page='+scheduledPageNumber);render();});
 if($('#load-scheduled'))$('#load-scheduled').onclick=load;
 document.querySelectorAll('[data-scheduled-page]').forEach(el=>el.onclick=()=>{scheduledPageNumber=+el.dataset.scheduledPage;load();});
 document.querySelectorAll('[data-reserve]').forEach(el=>el.onclick=()=>run(async()=>{await api('/api/trips/'+el.dataset.reserve+'/reserve',{});scheduledData=await api('/api/driver/scheduled?page='+scheduledPageNumber);await refresh();toast('Pickup reserved provisionally. Be online before dispatch opens.');}));
 document.querySelectorAll('[data-unreserve]').forEach(el=>el.onclick=()=>{modal('<h2>Release reserved pickup</h2><div class="reason-options">'+config.releaseReasons.map(r=>'<button class="btn" data-reservation-reason="'+esc(r)+'">'+esc(r)+'</button>').join('')+'</div>');document.querySelectorAll('[data-reservation-reason]').forEach(b=>b.onclick=()=>run(async()=>{await api('/api/trips/'+el.dataset.unreserve+'/release-reservation',{reason:b.dataset.reservationReason});$('#modal').close();scheduledData=await api('/api/driver/scheduled');await refresh();}));});
 if($('#last-ride'))$('#last-ride').onclick=()=>run(async()=>{const d=state.drivers.find(d=>d.id===user.driverId);await api('/api/driver/last-ride',{enabled:!d.finishThenOffline});await refresh();});
 document.querySelectorAll('[data-help-trip]').forEach(el=>el.onclick=()=>{modal('<h2>Get trip help</h2><p>Your request goes to the fleet owner.</p><form id="help-form"><label>Reason<select id="help-category"><option value="late_pickup">Driver is late</option><option value="booking_question">Booking question</option><option value="vehicle_issue">Vehicle issue</option><option value="lost_item">Lost item after completed ride</option></select></label>'+(user.role==='driver'?'<p>No typing required. Your selected reason will be sent.</p>':'<label>Details<textarea id="help-details" required minlength="5" maxlength="1000"></textarea></label>')+'<button class="btn primary">Send request</button></form>');$('#help-form').onsubmit=e=>{e.preventDefault();run(async()=>{await api('/api/support',{tripId:el.dataset.helpTrip,category:$('#help-category').value,details:$('#help-details')?.value});$('#modal').close();tab='help';await refresh();toast('Request saved for the fleet owner.');});};});
 document.querySelectorAll('[data-help-review]').forEach(el=>el.onclick=()=>{const r=state.supportRequests.find(r=>r.id===el.dataset.helpReview);modal('<h2>Review '+esc(r.reference)+'</h2><form id="review-help"><label>Status<select id="help-status"><option value="reviewing">Reviewing</option><option value="resolved">Resolved</option></select></label><label>Reply<textarea id="help-reply" maxlength="1000">'+esc(r.ownerReply)+'</textarea></label><button class="btn primary">Save reply</button></form>');$('#review-help').onsubmit=e=>{e.preventDefault();run(async()=>{await api('/api/support/'+r.id,{status:$('#help-status').value,reply:$('#help-reply').value});$('#modal').close();await refresh();});};});
}


var readinessData=null,readinessLoading=false,readinessRevision=-1,readinessFilter='all',readinessPageNumber=1;
function readinessPage(){
 const d=readinessData,filters=[['all','All active'],['attention','Needs attention'],['searching','Searching'],['reply','Awaiting reply'],['confirmed','Confirmed'],['on_trip','On trip'],['planned','Later']];
 const rows=(d?.rows||[]).filter(r=>readinessFilter==='all'||r.level===readinessFilter),pages=Math.max(1,Math.ceil(rows.length/25));readinessPageNumber=Math.min(readinessPageNumber,pages);
 return heading('DISPATCH READINESS','Pickup readiness','Review late pickups, driver replies and future work in one place.','<button class="btn" id="refresh-readiness">Refresh</button><button class="btn primary" data-go="schedule">Plan pickups</button>')+
 '<div class="readiness-counts">'+[['attention','Needs attention'],['reply','Awaiting reply'],['confirmed','Confirmed'],['planned','Scheduled later']].map(([key,label])=>'<button class="panel readiness-count '+(key==='attention'&&d?.counts[key]?'risk':'')+'" data-readiness-filter="'+key+'"><strong>'+(d?.counts[key]||0)+'</strong><span>'+label+'</span></button>').join('')+'</div><div class="notice">Automatic dispatch runs while this server is running. A proposed driver is not confirmed until they accept. Travel times and notifications remain simulated.</div><section class="panel"><div class="filter-tabs readiness-filters">'+filters.map(([key,label])=>'<button class="'+(readinessFilter===key?'selected':'')+'" data-readiness-filter="'+key+'">'+label+'</button>').join('')+'</div>'+
 (!d?'<div class="empty" role="status">Loading pickup readiness…</div>':!rows.length?'<div class="empty"><h2>Nothing in this group.</h2><p>Choose another group to review your active pickups.</p></div>':'<div class="readiness-list">'+rows.slice((readinessPageNumber-1)*25,readinessPageNumber*25).map(r=>'<article class="readiness-row '+(r.level==='attention'?'risk':'')+'"><div><small>'+date(r.pickupAt)+' · '+time(r.pickupAt)+'</small><h3>'+esc(r.reference)+' · '+esc(r.customerName)+'</h3><p>'+esc(r.pickup)+' → '+esc(r.destination)+'</p><strong>'+esc(r.reason)+'</strong><p>Driver: '+esc(r.driverName||'Not confirmed')+'</p></div><div class="card-actions"><button class="btn" data-detail="'+r.id+'">Ride details</button><button class="btn primary" data-dispatch-review="'+r.id+'">Why this driver?</button></div></article>').join('')+'</div>')+
 '<div class="pagination"><button class="btn" data-readiness-page="'+(readinessPageNumber-1)+'" '+(readinessPageNumber===1?'disabled':'')+'>Previous</button><span>'+rows.length+' rides · '+readinessPageNumber+' / '+pages+'</span><button class="btn" data-readiness-page="'+(readinessPageNumber+1)+'" '+(readinessPageNumber>=pages?'disabled':'')+'>Next</button></div></section>'+(d?'<p class="help">Checked '+time(d.at)+'. Includes overdue rides; demo walkthrough trips are separate.</p>':'');
}
async function loadReadiness(){if(readinessLoading)return;readinessLoading=true;const revision=state.revision;try{const result=await api('/api/operations/readiness');if(user?.role==='owner'){readinessData=result;readinessRevision=revision;if(tab==='readiness')render();}}finally{readinessLoading=false;}}
function reviewDispatch(id){run(async()=>{
 const r=await api('/api/trips/'+id+'/dispatch-review');
 const description={closed:'This ride is closed. No new driver will be offered.',confirmed:'Driver accepted. The assignment is confirmed.',awaiting_reply:'Waiting for '+(r.pending?.driverName||'the driver')+' to accept or decline.',scheduled:'Dispatch opens '+date(r.opensAt)+' at '+time(r.opensAt)+'. Rankings below are a snapshot, not a booking.',searching:'Dispatch is searching. Only eligible drivers can receive an offer.'}[r.phase];
 modal('<h2>Driver selection · '+esc(r.reference)+'</h2><p>'+esc(description)+'</p><div class="notice">Rank 1 is the next eligible choice at this moment. The current queue rules rank eligible drivers. '+(r.etaSource==='road'?'Times use Google road ETAs.':'Times are simulated.')+'</div><h3>Available choices and skipped drivers</h3><div class="candidate-list">'+r.candidates.map(c=>'<article class="candidate-row"><div><strong>'+esc(c.name)+'</strong><small>'+esc(c.vehicle)+' · '+esc(c.plate)+'</small></div><span class="badge '+(c.eligible?'accepted':'cancelled')+'">'+(c.rank?'Choice '+c.rank:'Skipped')+'</span><p>'+(c.eta===null?'Location unavailable':c.eta+' min to pickup · '+(r.etaSource==='road'?'road ETA':'simulated'))+'</p><p>'+esc(c.reasons.join(' · ')||(c.driverId===r.chosenDriverId?'Current offer or confirmed driver':'Eligible for an offer'))+'</p></article>').join('')+'</div><h3>Offer history</h3>'+(r.attempts.length?'<ol class="dispatch-attempts">'+r.attempts.map(a=>'<li><strong>'+esc(a.driver)+'</strong> · '+esc(a.status)+(a.reason?' · '+esc(a.reason):'')+'</li>').join('')+'</ol>':'<p>No offers have been sent.</p>'));
 });}
function bindDispatchReview(){
 if(tab==='readiness'&&(!readinessData||readinessRevision!==state.revision))run(loadReadiness);
 if($('#refresh-readiness'))$('#refresh-readiness').onclick=()=>run(loadReadiness);
 document.querySelectorAll('[data-readiness-filter]').forEach(el=>el.onclick=()=>{readinessFilter=el.dataset.readinessFilter;readinessPageNumber=1;render();});
 document.querySelectorAll('[data-readiness-page]').forEach(el=>el.onclick=()=>{readinessPageNumber=+el.dataset.readinessPage;render();});
 document.querySelectorAll('[data-dispatch-review]').forEach(el=>el.onclick=()=>reviewDispatch(el.dataset.dispatchReview));
}

var mapPriorityFilter="now",geoPriorityLayer=null;
var geoMap=null,geoMarkers=null,geoTrail=null,geoScenarioRoutes=null,gpsWatch=null,gpsHeartbeat=null,gpsGeneration=0,gpsMessage='Location sharing is off.';
let googleFleetProvider, googleFleetLoading, googleFleetFailed = false;
const fleetMapProvider = () => googleFleetProvider || window.L;
function googleFleetFallback() {
  if (googleFleetFailed) return;
  googleFleetFailed = true;
  if (googleFleetProvider && geoMap) {
    geoMap.remove();
    geoMap = geoMarkers = null;
    mapInteracting = false;
  }
  googleFleetProvider = undefined;
  if (user?.role === 'owner' && $('#geo-fleet-map')) bindGeographicMap();
}
function phoneTrackingPanel(d){
  if (config.publicDemo) return '<section class="phone-tracking panel"><h2>'+icon('map')+' Simulated location</h2><p>The owner can follow sample vehicle movement on the dispatch map.</p></section>';
  return '<section class="phone-tracking panel"><h2>'+icon('map')+' Share phone location</h2><p>Send this phone’s GPS to the owner while you are online and this browser stays open. Stop sharing at any time. Locked-screen/background tracking is not supported here.</p><div class="tracking-state" id="phone-tracking-state" role="status">'+esc(gpsMessage)+'</div><button class="btn '+(gpsWatch===null?'primary':'')+'" id="phone-location-toggle" '+(d.status==='offline'?'disabled':'')+'>'+(gpsWatch===null?'Start sharing location':'Stop sharing location')+'</button><small>Phone permission is required. '+(config.dispatchMode==='road'?'Fresh phone GPS is required for road dispatch.':'This demo uses simulated pickup times.')+'</small></section>';
}
function clearPhoneTracking(message) {
  gpsGeneration++;
  if (gpsWatch!==null) navigator.geolocation.clearWatch(gpsWatch);
  clearInterval(gpsHeartbeat);
  gpsWatch=gpsHeartbeat=null;
  requestFreshGps=null;
  gpsMessage=message;
}
async function stopPhoneTracking() {
  clearPhoneTracking('Location sharing stopped.');
  await api('/api/driver/tracking',{enabled:false});
}
function bindPhoneTracking() {
  if (gpsWatch!==null && (!user || user.role!=='driver' || state.drivers.find(d=>d.id===user.driverId)?.status==='offline')) {
    clearPhoneTracking('Location sharing stopped because you are offline.');
  }
  const button=$('#phone-location-toggle');
  if (!button) return;
  button.onclick=()=>run(async()=>{
    if (gpsWatch!==null) { await stopPhoneTracking();await refresh();return; }
    if (!navigator.geolocation || !window.isSecureContext) throw Error('Phone location requires HTTPS or localhost and a browser with GPS support.');
    button.disabled=true;
    try {
      await api('/api/driver/tracking',{enabled:true});
      gpsMessage='Waiting for phone permission and a GPS reading…';
      const generation=++gpsGeneration;
      const options={enableHighAccuracy:true,maximumAge:0,timeout:15000};
      let busy=false,lastSent=0;
      const showMessage=()=>{
        const el=$('#phone-tracking-state');
        if (el) el.textContent=gpsMessage;
        const toggle=$('#phone-location-toggle');
        if (toggle) toggle.textContent=gpsWatch===null?'Start sharing location':'Stop sharing location';
      };
      const success=async position=>{
        if (generation!==gpsGeneration || user?.role!=='driver' || !navigator.onLine || busy || Date.now()-lastSent<5000) return;
        busy=true; lastSent=Date.now();
        try {
          const reading={id:requestId(),latitude:position.coords.latitude,longitude:position.coords.longitude,
            accuracy:position.coords.accuracy,capturedAt:Math.round(position.timestamp)};
          const result=await api('/api/driver/location',{points:[reading]},undefined,AbortSignal.timeout(10000));
          if(generation!==gpsGeneration) return;
          gpsMessage=result.accepted.length?'Sharing with owner · accuracy '+Math.round(reading.accuracy)+' m · '+time(Date.now()):
            result.rejected[0]?.reason==='duplicate_or_older'?gpsMessage:'Reading not used: '+(result.rejected[0]?.reason||'Try again outdoors');
        } catch(error) {
          if(generation===gpsGeneration) gpsMessage='Not sent: '+error.message;
        } finally { busy=false;if(generation===gpsGeneration) showMessage(); }
      };
      const failure=error=>{
        if (generation!==gpsGeneration) return;
        if (error.code===1) {
          clearPhoneTracking('Location permission denied. Enable it in your phone settings.');
          api('/api/driver/tracking',{enabled:false}).catch(()=>{});
        } else gpsMessage=error.code===2?'Location unavailable. Waiting for a better GPS signal.':'GPS reading timed out. Waiting for another reading.';
        showMessage();
      };
      gpsWatch=navigator.geolocation.watchPosition(success,failure,options);
      // Some phones stop emitting watch events while stationary. Request a fresh fix, never retimestamp an old one.
      requestFreshGps=()=>navigator.geolocation.getCurrentPosition(success,failure,options);
      gpsHeartbeat=setInterval(requestFreshGps,30000);
      await refresh();
    } finally { button.disabled=false; }
  });
}
const fleetPanelLayout = { collapsed: new Set(), expanded: '', heights: {} };
try {
  const saved = JSON.parse(localStorage.getItem('royalcab.fleet-panel-layout') || '{}');
  fleetPanelLayout.collapsed = new Set(Array.isArray(saved.collapsed) ? saved.collapsed : []);
  fleetPanelLayout.expanded = saved.expanded || '';
  fleetPanelLayout.heights = saved.heightVersion === 1 ? saved.heights || {} : {};
} catch {}
const fleetPanelWindows = new Map();
const fleetPanelView = new URLSearchParams(location.search).get('fleetPanel');
function bindFleetPanelLayout() {
  const dashboard = $('.live-dashboard');
  if (!dashboard) return;
  const panels = [
    ['map','#fleet-map','.dispatch-map-title','Fleet map'],
    ['queue','#ride-queue','header','Ride queue'],
    ['drivers','#driver-duty','.driver-duty-heading','Vehicles and driver duty'],
    ['trips','.live-active-board','h2','Active trips']
  ];
  if (panels.some(([key])=>key===fleetPanelView)) dashboard.dataset.panelWindow = fleetPanelView;
  function saveLayout() {
    try {
      localStorage.setItem('royalcab.fleet-panel-layout',JSON.stringify({
        ...fleetPanelLayout, heightVersion:1, collapsed:[...fleetPanelLayout.collapsed]
      }));
    } catch {}
  }
  function changeLayout() {
    dashboard.dataset.expandedPanel = fleetPanelLayout.expanded;
    for (const [key, selector] of panels) {
      const panel = dashboard.querySelector(selector);
      if (!panel) continue;
      const collapsed = fleetPanelView !== key && fleetPanelLayout.collapsed.has(key);
      panel.dataset.collapsed = String(collapsed);
      const toggle = panel.querySelector('[data-panel-collapse="'+key+'"]');
      const expand = panel.querySelector('[data-panel-expand="'+key+'"]');
      toggle.textContent = collapsed ? 'Show' : 'Hide';
      toggle.setAttribute('aria-expanded', String(!collapsed));
      expand.textContent = fleetPanelLayout.expanded === key ? 'Restore' : 'Expand';
      expand.setAttribute('aria-pressed',String(fleetPanelLayout.expanded === key));
    }
    requestAnimationFrame(()=>geoMap?.invalidateSize({pan:false}));
  }
  for (const [key, selector, header, title] of panels) {
    const panel = dashboard.querySelector(selector);
    const heading = panel?.querySelector(header);
    if (!heading) continue;
    const controls = document.createElement('span');
    controls.className = 'live-panel-controls';
    controls.innerHTML = '<button type="button" data-panel-collapse="'+key+'" aria-label="Show or hide '+title+'"></button>'+
      '<button type="button" data-panel-expand="'+key+'" aria-label="Expand or restore '+title+'"></button>';
    if (key === 'drivers' || key === 'trips') {
      const content = panel.querySelector(key === 'drivers' ? '#driver-duty-roster' : '.live-active-scroll, .live-active-board > p');
      if (content) {
        const resize = document.createElement('button');
        resize.type = 'button';
        resize.className = 'fleet-panel-resize';
        resize.setAttribute('aria-label','Resize '+title+' vertically. Use up and down arrows.');
        resize.title = 'Drag down to show more rows';
        const setHeight = height => {
          const value = Math.round(Math.max(90, Math.min(1200,height)));
          fleetPanelLayout.heights[key] = value;
          panel.style.setProperty('--fleet-panel-height',value+'px');
        };
        if (Number.isFinite(fleetPanelLayout.heights[key])) setHeight(fleetPanelLayout.heights[key]);
        resize.onpointerdown = event => {
          if (event.button !== 0) return;
          const startY = event.clientY, startHeight = content.getBoundingClientRect().height;
          resize.setPointerCapture(event.pointerId);
          resize.onpointermove = move => setHeight(startHeight+move.clientY-startY);
          resize.onlostpointercapture = () => {
            resize.onpointermove = null;
            saveLayout();
          };
        };
        resize.onkeydown = event => {
          if (!['ArrowUp','ArrowDown'].includes(event.key)) return;
          event.preventDefault();
          setHeight(content.getBoundingClientRect().height+(event.key==='ArrowDown'?40:-40));
          saveLayout();
        };
        panel.append(resize);
      }
    }
    const pop = document.createElement('button');
    pop.type = 'button';
    pop.textContent = fleetPanelView === key ? 'Pop in' : 'Pop out';
    pop.setAttribute('aria-label',pop.textContent+' '+title);
    pop.onclick = () => {
      if (fleetPanelView === key) {
        if (window.opener && !window.opener.closed) {
          window.opener.focus();
          window.close();
        } else {
          const url = new URL(location.href);
          url.searchParams.delete('fleetPanel');
          location.assign(url);
        }
        return;
      }
      const existing = fleetPanelWindows.get(key);
      if (existing && !existing.closed) { existing.focus(); return; }
      const url = new URL(location.href);
      url.hash = '';
      url.searchParams.set('fleetPanel',key);
      const popup = window.open(url,'royalcab-fleet-'+key,'popup,width=960,height=760');
      if (popup) fleetPanelWindows.set(key,popup);
      else toast('Allow pop-ups for EASYRIDE to open this panel.',true);
    };
    controls.append(pop);
    heading.append(controls);
    controls.onclick = event => {
      if (event.target.hasAttribute('data-panel-collapse')) {
        if (!fleetPanelLayout.collapsed.delete(key)) {
          fleetPanelLayout.collapsed.add(key);
          if (fleetPanelLayout.expanded === key) fleetPanelLayout.expanded = '';
        }
      } else if (event.target.hasAttribute('data-panel-expand')) {
        fleetPanelLayout.expanded = fleetPanelLayout.expanded === key ? '' : key;
        fleetPanelLayout.collapsed.delete(key);
      } else return;
      saveLayout();
      changeLayout();
    };
  }
  changeLayout();
}
function bindGeographicMap(){
 bindFleetPanelLayout();
 const mapThemes = document.querySelectorAll('[data-map-theme-choice]');
 function showMapTheme() {
   const map = $('#geo-fleet-map');
   if (map) map.dataset.mapTheme = fleetMapTheme;
   mapThemes.forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.mapThemeChoice===fleetMapTheme)));
 }
 mapThemes.forEach(button=>button.onclick=()=>{
   fleetMapTheme=button.dataset.mapThemeChoice;
   try { localStorage.setItem('royalcab.map-theme',fleetMapTheme); } catch {}
   showMapTheme();
 });
 showMapTheme();
 document.querySelectorAll('[data-fleet-photo]').forEach(button=>button.onclick=()=>editFleetProfilePhoto(state.drivers.find(d=>d.id===button.dataset.fleetPhoto)));
 document.querySelectorAll('[data-map-priority]').forEach(b=>b.onclick=()=>{mapPriorityFilter=b.dataset.mapPriority;render();fitPriorityMap();});
 document.querySelectorAll('[data-scenario-action]').forEach(el=>el.onclick=()=>run(async()=>{await api('/api/demo/charlotte-fleet',{action:el.dataset.scenarioAction});fleetSource='scenario';fleetFilter='all';selectedScenarioTrip=null;selectedDriverId=null;if(geoMap){geoMap.remove();geoMap=null;geoMarkers=null;}await refresh();}));
 document.querySelectorAll('[data-follow-scenario]').forEach(el=>el.onclick=()=>{selectedScenarioTrip=el.dataset.followScenario;const t=state.trips.find(t=>t.id===selectedScenarioTrip),o=state.offers.find(o=>o.tripId===t.id&&o.status==='pending');selectedDriverId=t.driverId||o?.driverId||null;render();});

 document.querySelectorAll('[data-replay-action]').forEach(el=>el.onclick=()=>run(async()=>{await api('/api/demo/tracking-replay',{action:el.dataset.replayAction});fleetSource='replay';fleetFilter='all';selectedDriverId='tracking-test-driver';if(el.dataset.replayAction==='start'&&geoMap){geoMap.remove();geoMap=null;geoMarkers=null;}await refresh();}));

 document.querySelectorAll('[data-fleet-source]').forEach(el=>el.onclick=()=>{fleetSource=el.dataset.fleetSource;selectedDriverId=null;fleetFilter='all';if(geoMap){geoMap.remove();geoMap=null;geoMarkers=null;}render();});
 const node=$('#geo-fleet-map');if(!node)return;
 const status = $('#geo-map-status');
 if (config.map?.googleKey && !googleFleetProvider && !googleFleetFailed) {
  status.textContent = 'Loading Google Maps…';
  googleFleetLoading ||= ProLiftGoogleFleetMap.load(config.map.googleKey, googleFleetFallback)
    .then(provider => {
      if (googleFleetFailed) return;
      googleFleetProvider = provider;
      if (user?.role === 'owner' && $('#geo-fleet-map')) bindGeographicMap();
    })
    .catch(googleFleetFallback);
  return;
 }
 if (!fleetMapProvider()) { status.textContent = 'Map unavailable. Driver coordinates remain visible in the fleet list.'; return; }
 status.textContent = googleFleetProvider ? 'Google Maps' : googleFleetFailed ? 'Google Maps unavailable · Showing OpenStreetMap' : 'OpenStreetMap';
 const identity = fleetIdentity(fleetSource);
 const items=ProLiftBoard.fleet(state,fleetNow()).filter(i=>matchesFleetSource(i.driver)&&(fleetFilter==='all'||i.status===fleetFilter)&&(tab!=='overview'||fleetRowMatches(i))),located=items.filter(i=>i.hasLocation);
 let initial=false;
 if(!geoMap){initial=true;geoMap=fleetMapProvider().map(node,{zoomControl:true,scrollWheelZoom:true,zoomAnimation:false}).setView(config.map?.center||[35.2271,-80.8431],config.map?.zoom||13);geoMarkers=fleetMapProvider().layerGroup().addTo(geoMap);geoPriorityLayer=fleetMapProvider().layerGroup().addTo(geoMap);geoFocusedRoute=null;geoScenarioRoutes=fleetMapProvider().layerGroup().addTo(geoMap);geoTrail=fleetMapProvider().polyline([],{color:'#285fda',weight:4}).addTo(geoMap);if (!googleFleetProvider) L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).on('tileerror',()=>{const el=$('#geo-map-status');if(el)el.textContent='Street tiles could not load. Vehicle coordinates are still available.';}).addTo(geoMap);geoMap.on('dragstart zoomstart',()=>{mapInteracting=true;});geoMap.on('moveend zoomend',()=>{mapInteracting=false;});geoMap.on('dragstart',stopVehicleFollow);}
 geoMarkers.clearLayers();
 for(const item of located){const d=item.driver,stopped=d.locationSource==='device'&&d.trackingEnabled===false,age=Math.max(0,Math.floor(((fleetNow())-d.lastLocationAt)/1000)),label=d.locationSource==='device'?(stopped?'Sharing stopped':age>120?'Location stale':'Phone GPS'):d.locationSource==='replay'?'TEST · dummy coordinates':d.locationSource==='scenario'?'CHARLOTTE FLEET TEST':'SAMPLE';
  const priorityRide=item.trip||state.trips.find(t=>t.id===item.offer?.tripId),carPriority=priorityRide?ProLiftBoard.priority(priorityRide,fleetNow()):'later';
  const minutesToDropoff = (item.trip?.plannedEndAt - fleetNow()) / 60000;
  const markerStatus = stopped ? 'offline' : item.status === 'onride' && item.trip?.status === 'onboard' &&
    minutesToDropoff >= 0 && minutesToDropoff <= 5 ? 'finishing' : item.status;
  const carIcon=fleetMapProvider().divIcon({className:'fleet-car-marker fleet-theme-'+identity.theme+' priority-car-'+carPriority+' ' +markerStatus+ (selectedDriverId===d.id?' chosen':''),iconSize:[44,44],iconAnchor:[22,22],html:'<span class="fleet-car-disc"><svg viewBox="0 0 56 40" aria-hidden="true"><ellipse cx="29" cy="33" rx="24" ry="5" fill="#020911" opacity=".55"/><path d="M4 25 7 19 16 16 22 8 38 6 46 10 50 16 53 21 51 28 47 31 11 34 5 30Z" fill="currentColor" stroke="#153024"/><path d="m16 16 7-7 15-2 8 4-5 6-18 3Z" fill="#fff" opacity=".26"/><path d="m17 17 6-7 5 7-5 4Zm13 1 13-3 3 4-14 4Z" fill="#0d1927"/><path d="m7 26 8-1 3 2-10 2Z" fill="#eaffef"/><path d="m48 21 4-1-1 4-4 1Z" fill="#ff7284"/><circle cx="16" cy="31" r="5" fill="#121b25"/><circle cx="43" cy="28" r="5" fill="#121b25"/><circle cx="16" cy="31" r="2" fill="#a8b5c0"/><circle cx="43" cy="28" r="2" fill="#a8b5c0"/></svg><span class="fleet-marker-code">'+identity.code+'</span></span>'});const marker=fleetMapProvider().marker([d.lat,d.lng],{icon:carIcon,title:d.name+' · '+identity.label+' · '+label,alt:d.name,keyboard:true,riseOnHover:true}).addTo(geoMarkers);
  marker.bindTooltip(d.locationSource==='replay'?'TEST CAR · dummy GPS':d.locationSource==='scenario'?esc(d.name)+' · '+({available:'Available',onride:'On ride',offered:'Offer pending',stale:'Location old',offline:'Offline'}[item.status]||item.status):esc(d.name)+' · '+label,{direction:'bottom',permanent:selectedDriverId===d.id,offset:[0,20],className:'fleet-car-label'});marker.bindPopup('<strong>'+esc(d.name)+'</strong><br>'+esc(d.vehicle)+' · '+esc(d.plate)+'<br>'+label+' · '+age+' seconds ago<br>'+d.lat.toFixed(5)+', '+d.lng.toFixed(5)+(Number.isFinite(d.locationAccuracy)?'<br>Accuracy '+Math.round(d.locationAccuracy)+' m':''));
  marker.on('click',()=>{if(tab==='overview'){chooseFleetVehicle(d.id);return;}if(item.trip){focusDispatchRide(item.trip.id);return;}if(item.offer){focusDispatchRide(item.offer.tripId);return;}modal('<h2>Driver details</h2>'+fleetDetails(item,{available:'Available',onride:'On ride',offered:'Awaiting reply',offline:'Offline',stale:'Location old'}));return;});
 }
 if(fleetSource==='replay'&&state.trackingReplay){geoTrail.setLatLngs(state.trackingReplay.trail.map(p=>[p.lat,p.lng]));}else geoTrail.setLatLngs([]);
 drawScenarioRoutes();drawPriorityMarkers();
 const fit=()=>{if(fleetSource==='test:'+state.lgtcReplay?.runId){const points=located.map(({driver})=>[driver.lat,driver.lng]);for(const ride of state.trips.filter(ride=>ride.demoRunId===state.lgtcReplay.runId)){for(const name of [ride.pickup,ride.destination]){const stop=config.places.find(place=>place.name===name);if(stop)points.push([stop.lat,stop.lng]);}}if(points.length)geoMap.fitBounds(points,{padding:[45,45],maxZoom:15,animate:false});return;}if(fleetSource==='scenario'&&state.fleetScenario){const points=located.map(i=>[i.driver.lat,i.driver.lng]);for(const t of scenarioTrips()){for(const name of [t.pickup,t.destination]){const p=config.places.find(p=>p.name===name);if(p)points.push([p.lat,p.lng]);}}if(points.length)geoMap.fitBounds(points,{padding:[65,65],maxZoom:15,animate:false});return;}if(fleetSource==='replay'&&state.trackingReplay){geoMap.fitBounds(state.trackingReplay.route.map(p=>[p.lat,p.lng]),{padding:[70,70],maxZoom:15,animate:false});return;}if(located.length)geoMap.fitBounds(located.map(i=>[i.driver.lat,i.driver.lng]),{padding:[45,45],maxZoom:15,animate:false});};
 if($('#fit-priority-map'))$('#fit-priority-map').onclick=fitPriorityMap;
 if(initial && !fitFocusedRide()) { if(vehicleFocusId) centerFleetVehicle(); else fit(); }
 if($('#fit-geo-fleet')) $('#fit-geo-fleet').onclick=()=>{stopVehicleFollow();fit();};
 if(followedVehicleId){
   const item=located.find(i=>i.driver.id===followedVehicleId);
   if(!vehicleCanFollow(item)) stopVehicleFollow();
   else {
     const point=[item.driver.lat,item.driver.lng], key=point.join(',');
     if(key!==lastFollowPosition){lastFollowPosition=key;geoMap.panTo(point,{animate:false});}
   }
 }
 requestAnimationFrame(()=>geoMap?.invalidateSize());
}

function bindActions() {
  document.querySelectorAll('[data-live-total]').forEach(button=>button.onclick=()=>{
    const kind = button.dataset.liveTotal;
    if (kind==='attention') { openAttentionRides(); return; }
    const driverFilter = kind==='available' ? 'online' : kind==='riding' ? 'busy' : '';
    const panel = driverFilter ? 'drivers' : 'queue';
    const selector = driverFilter ? '[data-duty-filter="'+driverFilter+'"]' :
      '[data-dispatch-view="'+'later'+'"]';
    const collapsed = document.querySelector('[data-panel-collapse="'+panel+'"][aria-expanded="false"]');
    collapsed?.click();
    document.querySelector(selector)?.click();
    const target = document.querySelector(selector);
    target?.scrollIntoView({block:'center'});
    target?.focus({preventScroll:true});
  });
  const appearance = document.querySelector('#app-appearance');
  if (appearance) appearance.onchange = () => {
    document.documentElement.dataset.appearance = appearance.value;
    try { localStorage.setItem('royalcab.appearance',appearance.value); } catch {}
  };
  document.querySelectorAll('[data-fleet-page-tab]').forEach(button=>button.onclick=()=>{
    fleetPageTab=button.dataset.fleetPageTab;
    render();
    document.querySelector('[data-fleet-page-tab="'+fleetPageTab+'"]')?.focus({preventScroll:true});
  });
  document.querySelectorAll('[data-workbench-section]').forEach(button=>button.onclick=()=>{
    const day = $('#lgtc-tab-day');
    if (!day) {
      const schedule = $('#lgtc-history');
      schedule?.scrollIntoView({block:'center'});
      schedule?.querySelector('button')?.focus({preventScroll:true});
      toast('Open a saved schedule first.');
      return;
    }
    day.click();
    if (button.dataset.workbenchSection === 'approve') {
      const review = $('#lgtc-dispatch-review');
      if (review) { review.click(); return; }
      toast('Build or open a day plan to review rides for dispatch.');
    }
    $('#lgtc-tab-day')?.scrollIntoView({block:'center'});
  });
  const sourceName=$('#additional-source-name');
  if(sourceName){
    sourceName.value=localStorage.getItem('royalcab.additionalSourceName')||'';
    sourceName.onchange=()=>localStorage.setItem('royalcab.additionalSourceName',sourceName.value.trim());
    if(sourceName.value)sourceName.closest('details').querySelector('summary').textContent='＋ '+sourceName.value;
  }
  document.querySelectorAll('[data-driver-documents]').forEach(button=>button.onclick=()=>run(()=>openDriverDocuments(button.dataset.driverDocuments)));
  const rosterSearch=$('#fleet-roster-search');
  if(rosterSearch)rosterSearch.oninput=()=>{
    const query=rosterSearch.value.trim().toLowerCase();
    const rows=[...document.querySelectorAll('.fleet-roster-row')];
    for(const row of rows)row.hidden=!row.querySelector('summary').textContent.toLowerCase().includes(query);
    $('#fleet-roster-empty').hidden=rows.some(row=>!row.hidden);
  };
  bindDriverMobileTrips();
  const bulkRows = [...document.querySelectorAll('[data-bulk-trip]:enabled')];
  const bulkActions = [...document.querySelectorAll('[data-bulk-action]')];
  const bulkAll = $('#bulk-trip-all');
  const updateBulkSelection = () => {
    const count = bulkRows.filter(input => input.checked).length;
    $('#bulk-trip-count').textContent = count + ' selected';
    bulkAll.checked = count > 0 && count === bulkRows.length;
    bulkAll.indeterminate = count > 0 && count < bulkRows.length;
    bulkActions.forEach(button => button.disabled = count === 0);
  };
  if (bulkAll) {
    bulkAll.disabled = !bulkRows.length;
    bulkAll.onchange = () => { bulkRows.forEach(input => input.checked = bulkAll.checked); updateBulkSelection(); };
    bulkRows.forEach(input => input.onchange = updateBulkSelection);
    bulkActions.forEach(button => button.onclick = () => openBulkTripAction(button.dataset.bulkAction));
  }
  const refreshTrips = $('#refresh-trip-list');
  if (refreshTrips) refreshTrips.onclick = () => run(async () => {
    const selected = new Set(Array.from(document.querySelectorAll('[data-bulk-trip]:checked'), input => input.value));
    await refresh();
    if (tab !== 'trips') return;
    document.querySelectorAll('[data-bulk-trip]').forEach(input => { input.checked = selected.has(input.value); });
    updateBulkSelection();
    toast('Trip list refreshed.');
  });
  const exportTrips = $('#export-trip-list');
  if (exportTrips) exportTrips.onclick = () => {
    const csv = filteredTripsCsv();
    if (!csv) return;
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = '/owner/export-filtered.csv';
    const field = document.createElement('input');
    field.type = 'hidden';
    field.name = 'csv';
    field.value = csv;
    form.append(field);
    document.body.append(form);
    form.submit();
    form.remove();
  };
  const roster = $('#roster-validate');
  if (roster) roster.onsubmit = event => {
    event.preventDefault();
    const file = roster.elements.roster.files[0], result = $('#roster-result'), issues = $('#roster-issues');
    const button = event.submitter;
    issues.replaceChildren();
    if (!file || file.size > 5*1024*1024) {result.textContent='Choose a workbook up to 5 MB.';return;}
    button.disabled=true;
    result.textContent='Checking roster…';
    const reader=new FileReader();
    reader.onerror=()=>{result.textContent='Could not read the workbook.';button.disabled=false;};
    reader.onload=async()=>{
      try {
        const report=await api('/api/fleet-roster/'+button.value,{filename:file.name,base64:reader.result.split(',')[1]});
        result.textContent=(button.value==='apply'?'Roster applied. ':'')+report.drivers+' driver rows · '+report.vehicles+' vehicle rows · '+report.eligibleLinks+' eligible links · '+report.issues.length+' issues';
        for(const issue of report.issues){
          const li=document.createElement('li');
          li.textContent=issue.sheet+' row '+issue.row+' — '+issue.message;
          issues.append(li);
        }
      } catch(error){result.textContent=error.message;}
      finally{button.disabled=false;}
    };
    reader.readAsDataURL(file);
  };
  const fleetImport = $('#fleet-import-form');
  if (fleetImport) {
    const status = $('#fleet-import-status');
    const showCounts = result => { status.textContent = result.counts.map(row => row.total+' '+row.kind+' records').join(' · ') || 'No fleet records imported yet.'; };
    api('/api/fleet-import').then(showCounts).catch(error => {status.textContent=error.message;});
    fleetImport.onsubmit = event => {
      event.preventDefault();
      const file = fleetImport.elements.file.files[0];
      const button = event.submitter;
      if (!file || file.size > 5*1024*1024) {status.textContent='Choose a file up to 5 MB.';return;}
      button.disabled = true;
      const reader = new FileReader();
      reader.onerror = () => {status.textContent='Could not read the workbook.';button.disabled=false;};
      reader.onload = async () => {
        try {showCounts(await api('/api/fleet-import',{filename:file.name,base64:reader.result.split(',')[1]}));}
        catch (error) {status.textContent=error.message;}
        finally {button.disabled=false;}
      };
      reader.readAsDataURL(file);
    };
  }
  bindTripPreferences();
  bindImportedFleet();
  document.querySelectorAll('[data-fleet-kind]').forEach(button => button.onclick = () => run(async () => {
    await api('/api/fleet/availability',{driverId:button.dataset.fleetDriver,kind:button.dataset.fleetKind,disabled:button.dataset.fleetDisabled==='true'});
    await refresh();
  }));
  document.querySelectorAll('[data-trip-field]').forEach(input => {
    input.oninput = () => { tripFilters[input.dataset.tripField] = input.value; };
    input.onchange = () => {
      tripFilters[input.dataset.tripField] = input.value;
      boardPage = 1;
      render();
    };
  });
  if ($('#reset-trip-filters')) $('#reset-trip-filters').onclick = () => {
    for (const key of Object.keys(tripFilters)) tripFilters[key] = '';
    search = '';
    filter = tripDataScope = 'all';
    bookingOrder = 'next';
    boardPage = 1;
    render();
  };
  document.querySelectorAll('[data-customer-paired-ride]').forEach(button => button.onclick = () => {
    selectedCustomerTrip = button.dataset.customerPairedRide;
    if ($('#modal[open]')) $('#modal').close();
    tab = 'mytrips';
    render();
  });
  if ($('#driver-availability')) $('#driver-availability').onclick = () => driverAvailabilityModal();
  if ($('#schedule-management-date')) $('#schedule-management-date').onchange = event => {
    if (!event.target.value) return;
    scheduleManagementDate = event.target.value;
    render();
  };
  document.querySelectorAll('[data-edit-shift]').forEach(button => button.onclick = () =>
    driverAvailabilityModal(button.dataset.editShift,scheduleManagementDate));
  document.querySelectorAll('[data-replace-confirmed]').forEach(b=>b.onclick=()=>replaceConfirmed(b.dataset.replaceConfirmed));
  if (user.role === 'owner') bindLgtc();
  if (user.role === 'owner') bindDriverDayButtons();
  document.querySelectorAll('[data-queue-review]').forEach(button => {
    button.onclick = () => run(async () => {
      button.disabled = true;
      try {
        await api('/api/demo/queue-review',{restart:button.dataset.queueReview==='restart'});
        await refresh();
        changeFleetSource('queue-review');
        tab = 'overview';
        render();
        window.scrollTo(0,0);
      } finally { button.disabled = false; }
    });
  });
  if ($('#dispatch-fleet-status')) $('#dispatch-fleet-status').onclick = showDispatchFleetStatus;
  document.querySelectorAll('[data-duty-filter]').forEach(button => {
    button.onclick = () => {
      stopVehicleFollow();
      dutyFilter = button.dataset.dutyFilter;
      if ($('#driver-duty-roster')) $('#driver-duty-roster').scrollTop = 0;
      render();
      document.querySelector('[data-duty-filter][aria-pressed="true"]')?.focus({preventScroll:true});
    };
  });
  if($('#fleet-vehicle-search')) $('#fleet-vehicle-search').onsubmit=e=>{
    e.preventDefault();
    stopVehicleFollow();
    fleetSearch=e.currentTarget.elements.query.value.trim();
    render();
    $('#fit-geo-fleet')?.click();
  };
  if($('#clear-fleet-search')) $('#clear-fleet-search').onclick=()=>{fleetSearch='';render();$('#fit-geo-fleet')?.click();};
  document.querySelectorAll('[data-vehicle-focus]').forEach(b=>b.onclick=()=>chooseFleetVehicle(b.dataset.vehicleFocus));
  document.querySelectorAll('[data-dispatch-fleet]').forEach(button => {
    button.onclick = () => {
      if (fleetSource === button.dataset.dispatchFleet) return;
      changeFleetSource(button.dataset.dispatchFleet);
      render();
      document.querySelector('[data-dispatch-fleet][aria-pressed="true"]')?.focus({ preventScroll:true });
    };
  });
  if($('#customer-ride-choice'))$('#customer-ride-choice').onchange=e=>{selectedCustomerTrip=e.target.value;render();};
  if($('#next-customer-ride'))$('#next-customer-ride').onclick=()=>{selectedCustomerTrip=null;render();};
  if($('#design-vehicle-plan'))$('#design-vehicle-plan').onclick=()=>run(showVehiclePlan);
  document.querySelectorAll('[data-capacity]').forEach(b=>b.onclick=()=>{const d=state.drivers.find(d=>d.id===b.dataset.capacity);modal('<h2>Vehicle passenger capacity</h2><p>'+esc(d.name)+' · '+esc(d.vehicle)+'. Seats exclude the driver. Only choose the actual passenger capacity.</p><label>Passenger seats<select id="car-capacity"><option value="4">4 seats</option><option value="7">7 seats</option></select></label><label>Wheelchair accessible<select id="car-accessible"><option value="no">No</option><option value="yes">Yes</option></select></label><button class="btn primary" id="save-capacity">Save vehicle requirements</button>');$('#car-capacity').value=String(d.seats===7?7:4);$('#car-accessible').value=d.capabilities.includes('wheelchair')?'yes':'no';$('#save-capacity').onclick=()=>run(async()=>{await api('/api/vehicle-capacity',{driverId:d.id,seats:+$('#car-capacity').value,accessible:$('#car-accessible').value==='yes'});$('#modal').close();await refresh();toast('Vehicle capacity updated.');});});
  document.querySelectorAll('[data-priority-page]').forEach(b=>b.onclick=()=>{priorityPages[b.dataset.priorityPage]=+b.dataset.page;render();});
  document.querySelectorAll('[data-dispatch-view]').forEach(b=>b.onclick=()=>{dispatchView=b.dataset.dispatchView;mapPriorityFilter=dispatchView;dispatchPage=1;render();fitPriorityMap();});
  if($('#dispatch-search')) $('#dispatch-search').onsubmit=e=>{
    e.preventDefault();
    dispatchSearch=e.currentTarget.elements.query.value.trim();
    const matches=visibleDispatchQueue(queueFor());
    if(dispatchSearch&&!matches[dispatchView].length){
      dispatchView=['attention','now','later'].find(key=>matches[key].length)||dispatchView;
    }
    mapPriorityFilter=dispatchView;
    dispatchPage=1;
    render();
    if(matches[dispatchView].length) fitPriorityMap();
    $('#ride-queue h2')?.focus({preventScroll:true});
  };
  if($('#clear-dispatch-search')) $('#clear-dispatch-search').onclick=()=>{dispatchSearch='';dispatchPage=1;render();fitPriorityMap();};
  if ($('#avl-status')) $('#avl-status').onchange = event => {
    dutyFilter = event.target.value;
    fleetFilter = 'all';
    stopVehicleFollow();
    vehicleFocusId = selectedDriverId = null;
    render();
    $('#avl-status')?.focus({preventScroll:true});
  };
  if ($('#avl-vehicle')) $('#avl-vehicle').onchange = event => {
    const id = event.target.value;
    dutyFilter = fleetFilter = 'all';
    fleetSearch = '';
    chooseFleetVehicle(id || null);
    $('#avl-vehicle')?.focus({preventScroll:true});
  };
  if ($('#avl-reset')) $('#avl-reset').onclick = () => {
    dispatchSearch = fleetSearch = '';
    dutyFilter = fleetFilter = 'all';
    dispatchView = mapPriorityFilter = 'now';
    dispatchPage = 1;
    chooseFleetVehicle(null);
    fitPriorityMap();
    $('#avl-reset')?.focus({preventScroll:true});
  };
  if($('#selected-ride-map')) $('#selected-ride-map').onclick=fitFocusedRide;
  if($('#review-attention-rides')) $('#review-attention-rides').onclick=()=>openAttentionRides();
  document.querySelectorAll('[data-dispatch-page]').forEach(b=>b.onclick=()=>{dispatchPage=+b.dataset.dispatchPage;render();});
  document.querySelectorAll('[data-focus-ride]').forEach(b=>{b.onclick=()=>focusDispatchRide(b.dataset.focusRide,!!b.closest('.fleet-inspector'));b.oncontextmenu=e=>{e.preventDefault();openQuickAssign(b.dataset.focusRide,{x:e.clientX,y:e.clientY});};b.onkeydown=e=>{if(e.key==='ContextMenu'||e.shiftKey&&e.key==='F10'){e.preventDefault();const r=b.getBoundingClientRect();openQuickAssign(b.dataset.focusRide,{x:r.left,y:r.top});}};});
  document.querySelectorAll('[data-quick-assign]').forEach(b=>b.onclick=()=>{const r=b.getBoundingClientRect();openQuickAssign(b.dataset.quickAssign,{x:r.left,y:r.top});});
  if($('#clear-focused-ride'))$('#clear-focused-ride').onclick=()=>{focusedRideId=null;render();};
  if ($('#booking-order')) $('#booking-order').onchange = e => { bookingOrder = e.target.value; boardPage = 1; render(); };
  if($('#booking-status'))$('#booking-status').onchange=e=>{filter=e.target.value;boardPage=1;render();};
  if($('#regular-customer-search'))$('#regular-customer-search').onsubmit=e=>{e.preventDefault();regularCustomerSearch=$('#regular-customer-query').value;render();};
  document.querySelectorAll('[data-regular-customer]').forEach(b=>b.onclick=()=>regularDriverModal(b.dataset.regularCustomer));
  if($('#manage-demo'))$('#manage-demo').onclick=()=>run(startAutomaticDemo);
  if($('#manage-volume'))$('#manage-volume').onclick=()=>run(loadVolumeDemo);
  if($('#trip-data-scope'))$('#trip-data-scope').onchange=e=>{tripDataScope=e.target.value;filter='all';search='';boardPage=1;render();};
  if($('#browse-volume-demo'))$('#browse-volume-demo').onclick=()=>run(()=>showVolumeData());
  if($('#watch-auto-dispatch'))$('#watch-auto-dispatch').onclick=()=>run(startAutomaticDemo);
  if($('#dispatch-health'))$('#dispatch-health').onclick=showDispatchHealth;
  if ($('#dispatch-source')) $('#dispatch-source').onchange = e => {
    const source = e.target.value;
    if (source === 'volume' && !state.volumeDemo) { run(loadVolumeDemo); return; }
    changeFleetSource(source); tab = 'overview'; render();
  };
  if ($('#queue-bookings')) $('#queue-bookings').onclick = openQueueBookings;
  if($('#dispatch-more'))$('#dispatch-more').onclick=()=>{modal('<h2>Fleet tools</h2><button class="btn primary" id="load-volume-demo">Load / browse 500 test trips</button>'+scenarioControls()+trackingReplayControls());$('#load-volume-demo').onclick=()=>run(loadVolumeDemo);bindGeographicMap();};
  bindRideFeatures();
  bindPhoneTracking();
  bindGeographicMap();
  bindDispatchReview();
  bindOperations();
  bindMapControls();
  document.querySelectorAll('[data-schedule-period]').forEach(el=>el.onclick=()=>{schedulePeriod=el.dataset.schedulePeriod;schedulePage=1;render();});
  document.querySelectorAll('[data-schedule-page]').forEach(el=>el.onclick=()=>{schedulePage=+el.dataset.schedulePage;render();});
  if($('#schedule-search'))$('#schedule-search').oninput=e=>{scheduleSearch=e.target.value;schedulePage=1;render();$('#schedule-search').focus();};
  if($('#add-planned-ride'))$('#add-planned-ride').onclick=bookModal;
  if ($('#review-exhausted')) $('#review-exhausted').onclick=()=>{tab='trips';filter='attention';bookingOrder='next';boardPage=1;render();};
  document.querySelectorAll('[data-fleet-filter]').forEach(el => el.onclick = () => { fleetFilter = el.dataset.fleetFilter; selectedDriverId = null; mapBounds=null; mapCamera=ProLiftMapCamera.create(); render(); });
  document.querySelectorAll('[data-fleet-driver]').forEach(el => { el.onclick = () => { if(mapMoved)return; selectedDriverId = el.dataset.fleetDriver; const item = ProLiftBoard.fleet(state).find(item => item.driver.id === selectedDriverId); if (fleetFilter !== 'all' && item?.status !== fleetFilter) fleetFilter = 'all'; tab = 'overview'; render(); }; if (el.tagName.toLowerCase() === 'g') el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.onclick(); } }; });
  document.querySelectorAll('[data-board-page]').forEach(el => el.onclick = () => { boardPage = +el.dataset.boardPage; render(); });
  if ($('#start-dummy-trip')) $('#start-dummy-trip').onclick = () => run(async () => {
    $('#start-dummy-trip').disabled = true;
    try { await api('/api/demo/start-trip', {}); await refresh(); toast('Dummy trip created. The nearest driver has received the first offer.'); }
    finally { if ($('#start-dummy-trip')) $('#start-dummy-trip').disabled = false; }
  });
  const demoRespond = async (el, reason) => { await api('/api/demo/respond', { tripId: el.dataset.demoTrip, offerId: el.dataset.demoOffer || el.dataset.demoDecline, action: reason ? 'decline' : 'accept', reason }); if ($('#modal')?.open) $('#modal').close(); await refresh(); toast(reason ? 'Driver declined. The next nearest eligible driver now receives the offer.' : 'Driver accepted. Assignment confirmed.'); };
  document.querySelectorAll('[data-demo-response]').forEach(el => el.onclick = () => run(() => demoRespond(el)));
  document.querySelectorAll('[data-demo-decline]').forEach(el => el.onclick = () => {
    modal(`<h2>Driver declines: choose a reason</h2><p>No typing needed. Selecting a reason sends the response.</p><div class="reason-options">${config.declineReasons.map(reason => `<button class="btn" data-demo-reason="${esc(reason)}">${esc(reason)}</button>`).join('')}</div>`);
    document.querySelectorAll('[data-demo-reason]').forEach(button => button.onclick = () => run(() => demoRespond(el, button.dataset.demoReason)));
  });
  if ($('#start-auto-dispatch')) $('#start-auto-dispatch').onclick = () => run(async () => {
    $('#start-auto-dispatch').disabled = true;
    try { const result = await api('/api/dispatch/start', {}); await refresh(); toast('Automatic assignment started. Drivers receive offers; remaining rides stay in the queue.'); }
    finally { if ($('#start-auto-dispatch')) $('#start-auto-dispatch').disabled = false; }
  });
  const backToHistory = $('#back-to-trip-history');
  if (backToHistory) backToHistory.onclick = () => {
    const position = customerHistoryReturn;
    customerHistoryReturn = null;
    highlightedHistoryRide = position?.id ?? null;
    tab = 'history';
    render();
    if (!position) return;
    const cardButton = Array.from(document.querySelectorAll('[data-history-ride]'))
      .find(button => button.dataset.historyRide === position.id);
    cardButton?.focus({preventScroll:true});
    window.scrollTo({top:position.top, behavior:'instant'});
  };
  document.querySelectorAll('[data-history-ride]').forEach(button => {
    const openRide = () => {
      customerHistoryReturn = { id: button.dataset.historyRide, top: window.scrollY };
      selectedCustomerTrip = button.dataset.historyRide;
      tab = 'mytrips';
      render();
      window.scrollTo(0, 0);
    };
    button.onclick = openRide;
    const card = button.closest('article');
    card.classList.add('clickable-history-card');
    card.classList.toggle('returned-history-card', button.dataset.historyRide === highlightedHistoryRide);
    card.addEventListener('click', event => {
      if (event.target.closest('button, a, input, select, textarea, label')) return;
      openRide();
    });
  });
  document.querySelectorAll('[data-go]').forEach(el => el.onclick = () => { const previous=tab;tab = el.dataset.go; render(); if(user.role==='owner'&&previous!==tab) window.scrollTo(0,0);if (tab === 'imports') loadLgtcHistory(); if (tab === 'lgtc-settings') run(loadLgtcSettings); });
  document.querySelectorAll('[data-detail]').forEach(el => el.onclick = () => tripDetail(el.dataset.detail));
  document.querySelectorAll('[data-action]').forEach(el => el.onclick = () => { if (el.disabled) return; confirmAction(el.dataset.trip, el.dataset.action, el.dataset.offer); });
  document.querySelectorAll('[data-filter]').forEach(el => el.onclick = () => { filter = el.dataset.filter; boardPage = 1; render(); });
  if ($('#trip-search')) $('#trip-search').oninput = e => { search = e.target.value; boardPage = 1; const position = e.target.selectionStart; render(); const input = $('#trip-search'); input.focus(); if (input.type === 'text') input.setSelectionRange(position, position); };
  if ($('#import-file')) $('#import-file').onchange = e => run(async () => {
    const input = e.currentTarget;
    const file = input.files[0];
    if (!file) return;
    input.disabled = true;
    $('#upload-progress').textContent = 'Reading ' + file.name + '…';
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('Maximum file size is 5 MB');
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result.split(',')[1]);
        reader.onerror = () => reject(new Error('Could not read the selected file.'));
        reader.readAsDataURL(file);
      });
      batch = (await api('/api/import/preview', { filename: file.name, base64 })).batch;
      lgtcUpload = batch.kind === 'lgtc' ? { filename: file.name, base64 } : null;
      if (lgtcUpload) { tab = 'imports'; lgtcSelect(batch.dates[0]); render(); $('#lgtc-review')?.scrollIntoView({block:'start'}); }
      else await refresh();
      toast(batch.rows.length + ' rows read from ' + file.name + '. Review the preview before saving.');
    } catch (error) {
      if ($('#upload-progress')) $('#upload-progress').textContent = 'Could not load ' + file.name + '. ' + error.message;
      throw error;
    } finally {
      input.value = '';
      input.disabled = false;
    }
  });
  if ($('#confirm-import')) $('#confirm-import').onclick = () => run(async () => { const result = await api('/api/import/confirm', { batchId: batch.id }); batch.confirmed = true; tripDataScope = 'live'; bookingOrder = 'next'; filter = 'all'; search = ''; boardPage = 1; tab = 'trips'; await refresh(); toast(`${result.count} trips added to Bookings and the ordinary dispatch queue.`); });
  if ($('#toggle-status')) $('#toggle-status').onclick = () => run(async () => { const d = state.drivers.find(d => d.id === user.driverId); if(d.status!=='offline'&&gpsWatch!==null)await stopPhoneTracking();await api('/api/driver/status', { status: d.status === 'offline' ? 'online' : 'offline' }); await refresh(); });
  document.querySelectorAll('[data-release]').forEach(el => el.onclick = () => reasonModal(el.dataset.release, 'release'));
  document.querySelectorAll('[data-rate]').forEach(el => el.onclick = () => {
    modal('<h2>How was your ride?</h2><form id="rating-form"><label>Your rating<select id="stars"><option value="5">★★★★★ · Excellent</option><option value="4">★★★★ · Good</option><option value="3">★★★ · Okay</option><option value="2">★★ · Needs improvement</option><option value="1">★ · Poor</option></select></label><button class="btn primary">Submit rating</button></form>');
    $('#rating-form').onsubmit = e => { e.preventDefault(); run(() => sendAction(el.dataset.rate, 'rate', { stars: +$('#stars').value })); };
  });
  if ($('#book-trip')) $('#book-trip').onclick = bookModal;
}
function bookModal() {
  const dt = new Date(Date.now() + 3600000); dt.setMinutes(dt.getMinutes() - dt.getTimezoneOffset());
  const options = config.places.map(p => `<option>${esc(p.name)}</option>`).join('');
  const enterCustomer = user.role === 'owner' && !config.publicDemo;
  modal(`<h2>${user.role==='owner'?'Add a planned ride':'Plan your next trip.'}</h2><p>${config.mode==='pilot'?'Choose verified stops for this ride.':'Choose a demo location. Dispatch will arrange your driver.'}</p><form id="booking-form">${enterCustomer?'<label>Customer name<input id="book-customer-name" required maxlength="100"></label><label>Customer mobile<input id="book-customer-phone" type="tel" required placeholder="+15550102001"></label>':''}<label>Pickup<select id="book-pickup">${options}</select></label><label>Destination<select id="book-destination">${options}</select></label><label>Pickup date & time<input id="book-time" type="datetime-local" required value="${dt.toISOString().slice(0, 16)}"></label><p class="help">Time zone: ${esc(Intl.DateTimeFormat().resolvedOptions().timeZone)}</p><div class="form-grid"><label>Passengers<select id="book-passengers">${[1, 2, 3, 4, 5, 6, 7].map(n => `<option>${n}</option>`).join('')}</select></label><label>Vehicle needs<select id="book-requirements"><option value="">Standard</option><option value="wheelchair">Wheelchair access</option></select></label></div><button class="btn primary full">${user.role==='owner'?'Save planned ride':'Request planned trip'}</button></form>`);
  $('#book-destination').selectedIndex = 1;
  const bookingKey = requestId();
  $('#booking-form').onsubmit = e => {
    e.preventDefault();
    run(async () => {
      const { tripId } = await api('/api/book', {
        pickup: $('#book-pickup').value, destination: $('#book-destination').value,
        pickupAt: new Date($('#book-time').value).toISOString(), passengers: $('#book-passengers').value,
        requirements: $('#book-requirements').value,
        ...(enterCustomer ? { customerName: $('#book-customer-name').value, customerPhone: $('#book-customer-phone').value } : {})
      }, bookingKey);
      $('#modal').close();
      if (user.role === 'customer') selectedCustomerTrip=tripId;
      await refresh();
      if (user.role === 'owner') focusDispatchRide(tripId);
      toast('Your planned trip is in the dispatch queue.');
    });
  };
}
run(async () => {
  config = await api('/api/config');
  if (config.mode === 'demo' && ['owner', 'driver', 'customer'].includes(demoLoginRole)) loginTab = demoLoginRole;
  user = (await api('/api/session')).user;
  if (user) await enter(user);
  else renderLogin();
});

async function chooseDriver(id){
 const r=await api('/api/trips/'+id+'/dispatch-review'),available=r.candidates.filter(c=>c.eligible);
 modal('<h2>Choose a driver</h2><p>'+esc(r.reference)+' · The driver must accept before this ride is confirmed. Sending replaces any current offers.</p><label>Dispatch reason<select id="override-reason">'+['Urgent pickup','Driver contacted by dispatch','Replacement requested','Owner reviewed availability'].map(x=>'<option>'+x+'</option>').join('')+'</select></label><div class="reason-options">'+available.map(c=>'<article class="panel"><strong>#'+c.rank+' · '+esc(c.name)+'</strong><p>'+esc(c.vehicle)+' · '+esc(c.plate)+' · '+c.eta+' min simulated pickup estimate</p><button class="btn primary" data-select-driver="'+esc(c.driverId)+'">Send offer</button></article>').join('')+'</div>'+(!available.length?'<p>No eligible drivers. Review availability, vehicle suitability and location freshness.</p>':'<button class="btn" id="offer-group">Offer to nearest '+(state.settings.urgentGroupSize||3)+' available drivers</button>')+'<p class="help">Only available, suitable drivers are listed. No assignment is forced.</p>');
 document.querySelectorAll('[data-select-driver]').forEach(b=>b.onclick=()=>run(()=>sendAction(id,'manual_offer',{driverId:b.dataset.selectDriver,reason:$('#override-reason').value})));
 if($('#offer-group'))$('#offer-group').onclick=()=>run(()=>sendAction(id,'group_offer',{reason:$('#override-reason').value}));
}

async function showVehiclePlan(){
 const runId = tab === 'overview' ? queueRun(fleetSource) : undefined;
 const p=await api('/api/vehicle-plan',{action:'preview',runId});
 modal('<h2>Smart car schedule</h2><p>Next 24 hours · '+p.summary.bookings+' bookings in '+p.summary.planned+' car runs · '+p.summary.carsUsed+' cars · '+p.summary.unplanned+' need review.</p><div class="notice">Shared runs combine pickups within 2 km, a 10-minute booking window and a common destination. Total passengers must fit the car. Pickup tolerance is 3 minutes. Seats exclude the driver. Travel estimates are simulated; allow a 5-minute drop-off buffer.</div>'+p.cars.map(c=>'<section class="panel"><h3>'+esc(c.name)+' · '+c.seats+' passenger seats</h3><p>'+esc(c.vehicle)+' · '+esc(c.plate)+'</p><ol>'+c.stops.map(t=>'<li>'+(t.sharedStops?.length>1?'<div class="notice shared-run-preview">SHARED RUN · '+t.members.length+' bookings<ol>'+t.sharedStops.map(x=>'<li>'+time(x.plannedAt)+' · '+esc(x.pickup)+' · '+x.passengers+' passenger(s)</li>').join('')+'</ol></div>':'')+'<strong>'+time(t.pickupAt)+' · '+esc(t.reference)+'</strong><p>'+esc(t.pickup)+' → '+esc(t.destination)+'</p><small>'+t.passengers+'/'+c.seats+' seats · '+t.deadheadMinutes+' min reposition · estimated drop-off + buffer '+time(t.endAt)+'</small></li>').join('')+'</ol></section>').join('')+(p.unplanned.length?'<h3>Needs owner review</h3>'+p.unplanned.map(t=>'<p><strong>'+esc(t.reference)+' · '+t.passengers+' passengers</strong><br>'+esc(t.reason)+'</p>').join(''):'')+(p.summary.planned?'<button class="btn primary" id="apply-vehicle-plan">Use this car schedule</button>':'<p>Existing shared runs remain in Upcoming rides. Add unplanned future bookings and available cars to design additional runs.</p>')+'<button class="btn" id="load-shared-example">Load Charlotte shared-ride example</button><p class="help">Applying recalculates with current availability. Preferred drivers receive offers only when eligible; acceptance is required and normal fallback remains active.</p>');
 if($('#load-shared-example'))$('#load-shared-example').onclick=()=>run(async()=>{await api('/api/demo/shared-plan',{});await refresh();await showVehiclePlan();});
 if ($('#apply-vehicle-plan')) $('#apply-vehicle-plan').onclick = () => run(async () => {
   const result = await api('/api/vehicle-plan', { action:'apply',runId });
   $('#modal').close();
   await refresh();
   const plannedRide = result.cars.flatMap(car => car.stops)
     .map(stop => state.trips.find(trip => trip.id === (stop.appliedTripId || stop.tripId)))
     .find(trip => trip && canShowInDispatch(trip));
   if (plannedRide) focusDispatchRide(plannedRide.id);
   toast(result.summary.planned + ' car runs planned. Drivers still need to accept each ride.');
 });
}

const priorityPages={current:1,hour:1,overdue:1};
function priorityPanel(){
 const now=Date.now(),rows=state.trips.filter(t=>!t.poolParentId&&active(t));
 return '<section class="priority-panel" aria-label="Current rides and next hour"><div class="panel-heading"><div><div class="eyebrow">LIVE PRIORITY</div><h2>Now & the next hour</h2><p>Current work first. Pickups through '+time(now+3600000)+'. Overdue bookings stay visible.</p></div></div><div class="priority-columns">'+[['current','Current rides'],['hour','Pickup within 1 hour'],['overdue','Overdue · review now']].map(([key,label])=>{
 const list=rows.filter(t=>ProLiftBoard.priority(t,now)===key).sort((a,b)=>a.pickupAt-b.pickupAt||a.reference.localeCompare(b.reference)),pages=Math.max(1,Math.ceil(list.length/4)),page=Math.min(priorityPages[key],pages);priorityPages[key]=page;
 return '<section class="priority-lane '+key+'"><h3>'+label+' <span>'+list.length+'</span></h3>'+list.slice((page-1)*4,page*4).map(t=>{const d=state.drivers.find(d=>d.id===t.driverId);return '<button class="priority-ride" data-detail="'+esc(t.id)+'"><span class="priority-time">'+(key==='hour'?'In '+Math.max(0,Math.ceil((t.pickupAt-now)/60000))+' min':key==='overdue'?priorityDelay(now-t.pickupAt)+' overdue':esc(labels[t.status]||t.status))+(t.demoRunId?' · TEST':'')+(key==='current'&&t.pickupAt<now&&!['onboard','arrived'].includes(t.status)?' · Pickup overdue':'')+'</span><strong>'+esc(t.reference)+' · '+esc(t.customerName)+'</strong><span>'+esc(t.pickup)+' → '+esc(t.destination)+'</span><small>'+time(t.pickupAt)+' · '+esc(d?.name||'Driver not confirmed')+' · '+t.passengers+' passenger(s)</small></button>';}).join('')+(!list.length?'<p class="muted priority-empty">'+(key==='current'?'No active rides':key==='hour'?'No pickups due within an hour':'No overdue bookings')+'</p>':'')+(pages>1?'<div class="priority-pagination"><button class="btn small" data-priority-page="'+key+'" data-page="'+(page-1)+'" '+(page===1?'disabled':'')+'>Previous</button><small>'+page+' / '+pages+'</small><button class="btn small" data-priority-page="'+key+'" data-page="'+(page+1)+'" '+(page===pages?'disabled':'')+'>Next</button></div>':'')+'</section>';
 }).join('')+'</div></section>';
}
// Refresh relative pickup priority even when no trip event arrives. Preserve forms and dialogs.
setInterval(()=>{if(user?.role==='owner'&&state&&['overview','trips','schedule'].includes(tab)&&!mapInteracting&&!$('dialog[open]')&&!document.activeElement?.closest('form')&&!['INPUT','SELECT','TEXTAREA'].includes(document.activeElement?.tagName))render();},30000);

function priorityDelay(ms){const m=Math.ceil(ms/60000);return m<60?m+' min':m<1440?Math.floor(m/60)+'h '+m%60+'m':Math.floor(m/1440)+'d '+Math.floor(m%1440/60)+'h';}

function mapPriorityData(){
 const now = Date.now();
 const rows = tab === 'overview' ? visibleDispatchQueue(queueFor(fleetSource, now))[dispatchView] : undefined;
 return ProLiftBoard.mapPriorities(state,config.places,[...state.drivers.filter(matchesFleetSource),...(['device','sample'].includes(fleetSource)?[{demoRunId:null}]:[])],now,mapPriorityFilter,rows);
}
function mapPriorityLegend(){return '<div class="dispatch-map-filters"><strong>Ride pins</strong><span class="map-key"><i class="dispatch-dot current"></i>Current</span><span class="map-key"><i class="dispatch-dot hour"></i>Next hour</span><span class="map-key"><i class="dispatch-dot overdue"></i>Overdue</span><details><summary aria-label="Map legend">ⓘ</summary><div>Queue tabs filter the ride pins.<br>C: current · H: next hour · !: overdue · L: later.<br>Numbers group rides at one place.<br>Car positions show location freshness.<br>Dashed line: selected trip, not road directions.</div></details></div>';}
function drawPriorityMarkers(){
 if(!geoPriorityLayer)return;geoPriorityLayer.clearLayers();const data=mapPriorityData(),letters={current:'C',hour:'H',overdue:'!',later:'L'},names={current:'Current ride',hour:'Pickup within 1 hour',overdue:'Overdue pickup',later:'Later pickup'};
 if(!geoFocusedRoute)geoFocusedRoute=fleetMapProvider().layerGroup().addTo(geoMap);geoFocusedRoute.clearLayers();const focused=state.trips.find(t=>t.id===focusedRideId);if(focused){const points=[focused.pickup,focused.destination].map(n=>config.places.find(p=>p.name===n)).filter(Boolean).map(p=>[p.lat,p.lng]);if(points.length){fleetMapProvider().circleMarker(points[0],{radius:8,color:'#fff',weight:3,fillColor:'#2563eb',fillOpacity:1}).addTo(geoFocusedRoute);}if(points.length>1){fleetMapProvider().polyline(points,{color:'#2563eb',weight:4,dashArray:'6 8',opacity:.8}).addTo(geoFocusedRoute).bindTooltip('Selected trip · schematic route');fleetMapProvider().circleMarker(points[points.length-1],{radius:7,color:'#fff',weight:3,fillColor:'#172f50',fillOpacity:1}).addTo(geoFocusedRoute).bindTooltip('Drop-off');}}
 for(const g of data.groups){const count=g.rides.length;const marker=fleetMapProvider().marker([g.lat,g.lng],{icon:fleetMapProvider().divIcon({className:'priority-map-marker '+g.kind+' offset-'+g.offset,iconSize:[38,44],iconAnchor:[19,42],html:'<span>'+letters[g.kind]+(count>1?'<b>'+count+'</b>':'')+'</span>'}),zIndexOffset:600,title:names[g.kind]+' · '+count+' ride(s) · '+g.name,keyboard:true}).addTo(geoPriorityLayer);marker.bindTooltip(letters[g.kind]+' · '+count+' '+(count===1?'ride':'rides'),{direction:'top',offset:[0,-38],permanent:false});marker.on('click',()=>{
  if(count===1){focusDispatchRide(g.rides[0].id,true);return;}
  modal('<h2>'+esc(g.name)+'</h2><p>'+count+' priority rides at this location.</p><div class="reason-options">'+g.rides.map(r=>{const t=state.trips.find(t=>t.id===r.id);return '<button class="btn" data-map-trip="'+esc(r.id)+'">'+esc(names[r.kind])+' · '+esc(t.reference)+' · '+time(t.pickupAt)+' · '+r.target+'</button>';}).join('')+'</div>');document.querySelectorAll('[data-map-trip]').forEach(b=>b.onclick=()=>{$('#modal').close();focusDispatchRide(b.dataset.mapTrip);});
 });}
}
function fitPriorityMap(){if(!geoMap)return;const points=mapPriorityData().groups.map(g=>[g.lat,g.lng]);if(points.length)geoMap.fitBounds(points,{padding:[55,55],maxZoom:15,animate:false});else toast('No mapped priority rides in this fleet and filter.');}

function openAttentionRides(page=1) {
 const now=lastSnapshotAt || Date.now(), rides=queueFor(fleetSource,now).attention, pageSize=6;
 const pages=Math.max(1,Math.ceil(rides.length/pageSize));
 page=Math.min(page,pages);
 modal('<h2>Rides needing attention</h2><p>'+rides.length+' '+(rides.length===1?'ride needs':'rides need')+' review in this fleet.</p>'+
  '<div class="attention-ride-list">'+rides.slice((page-1)*pageSize,page*pageSize).map(t=>{
   const reason=ProLiftBoard.attentionReason(t,now,dispatchLead())||'Check pickup status';
   return '<article><div><strong>'+esc(t.reference)+' · '+esc(t.pickup)+'</strong><small>'+date(t.pickupAt)+' '+time(t.pickupAt)+' · '+esc(reason)+'</small></div><button class="btn small" data-attention-ride="'+esc(t.id)+'">'+(t.driverId?'View ride':'Review drivers')+'</button></article>';
  }).join('')+'</div>'+
  (!rides.length?'<p class="notice">The attention queue is clear.</p>':'')+
  (pages>1?'<div class="pagination"><button class="btn small" data-attention-page="'+(page-1)+'" '+(page===1?'disabled':'')+'>Previous</button><small>'+page+' / '+pages+'</small><button class="btn small" data-attention-page="'+(page+1)+'" '+(page===pages?'disabled':'')+'>Next</button></div>':'')+
  '<button class="text-btn" id="open-attention-queue">Show attention queue on map</button>');
 $('#modal').querySelectorAll('[data-attention-page]').forEach(b=>b.onclick=()=>openAttentionRides(+b.dataset.attentionPage));
 $('#modal').querySelectorAll('[data-attention-ride]').forEach(b=>b.onclick=()=>{
  const id=b.dataset.attentionRide,t=state.trips.find(ride=>ride.id===id);
  if(!t){openAttentionRides(page);return;}
  if(t.driverId){tripDetail(id);return;}
  $('#modal').close();
  openQuickAssign(id,undefined,()=>openAttentionRides(page));
 });
 $('#open-attention-queue').onclick=()=>{dispatchView=mapPriorityFilter='attention';dispatchPage=1;focusedRideId=null;$('#modal').close();render();fitPriorityMap();};
}

function quickDriverCard(candidate, pickupAt, nearest) {
 const late=Math.max(0,Math.ceil((candidate.arrivalAt-pickupAt)/60000));
 return '<article class="quick-driver'+(nearest?' quick-nearest':'')+'"><div>'+
  (nearest?'<span class="quick-option">1 · Nearest available</span>':'')+
  '<strong>'+esc(candidate.name)+'</strong><small>'+esc(candidate.vehicle)+' · '+esc(candidate.plate)+' · '+candidate.seats+' seats</small>'+
  '<span class="quick-eta">'+candidate.eta+' min · arrives '+date(candidate.arrivalAt)+' '+time(candidate.arrivalAt)+'</span>'+
  '<small class="'+(late?'quick-late':'')+'">'+(late?priorityDelay(candidate.arrivalAt-pickupAt)+' after scheduled pickup':'By scheduled pickup')+'</small></div>'+
  '<button class="btn '+(nearest?'primary':'')+'" data-quick-driver="'+esc(candidate.driverId)+'" aria-label="Send offer to '+esc(candidate.name)+'">'+(nearest?'Offer nearest':'Send offer')+'</button></article>';
}

async function openQuickAssign(tripId,anchor,back){
 $('#quick-assign')?.remove();
 const menu=document.createElement('dialog');
 menu.id='quick-assign';
 menu.className='quick-assign';
 menu.setAttribute('aria-label','Review pickup drivers');
 document.body.append(menu);
 const lookup = new AbortController();
 const position=()=>{
  const r=menu.getBoundingClientRect();
  menu.style.left=Math.max(12,Math.min(anchor?.x??(innerWidth-r.width)/2,innerWidth-r.width-12))+'px';
  menu.style.top=Math.max(12,Math.min(anchor?.y??(innerHeight-r.height)/2,innerHeight-r.height-12))+'px';
 };
 const close=()=>{menu.close();menu.remove();};
 const header=(title,reference='')=>'<header><div>'+(reference?'<small>'+esc(reference)+'</small>':'')+'<strong>'+title+'</strong></div><button class="text-btn" id="quick-close" aria-label="Close assignment menu">×</button></header>';
 const footer='<footer>'+(back?'<button class="text-btn" id="quick-back">Back to attention rides</button>':'')+'<button class="text-btn" id="quick-refresh">Refresh ETAs</button></footer>';
 const paint=html=>{
  menu.innerHTML=html;
  accentFirstPopupCard(menu);
  menu.querySelector('#quick-close').onclick=close;
  const refreshButton=menu.querySelector('#quick-refresh');
  if(refreshButton) refreshButton.onclick=()=>openQuickAssign(tripId,anchor,back);
  const backButton=menu.querySelector('#quick-back');
  if(backButton) backButton.onclick=()=>{close();back();};
  position();
 };
 menu.onclose=()=>{lookup.abort();menu.remove();};
 menu.onclick=e=>{
  if(e.target!==menu) return;
  const r=menu.getBoundingClientRect();
  if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom) close();
 };
 menu.showModal();
 paint(header('Review pickup drivers')+'<p role="status">Checking live availability and pickup ETAs…</p>');
 const timeout = setTimeout(()=>lookup.abort(),10000);
 try {
  const r=await api('/api/trips/'+tripId+'/dispatch-review',undefined,undefined,lookup.signal);
  if(!menu.isConnected) return;
  const t=state.trips.find(ride=>ride.id===tripId);
  if(!t) throw Error('This ride is no longer available in the queue.');
  const [nearest,...others]=r.recoveryCandidates.filter(c=>c.eligible);
  const blocked={confirmed:'A driver already accepted this ride.',closed:'This ride is closed.',scheduled:'Driver offers open '+time(r.opensAt)+'.'}[r.phase];
  const pending=r.pending?'<p class="quick-recovery">Waiting for '+esc(r.pending.driverName||'a driver')+'. Sending a new offer replaces the current offer.</p>':'';
  const noCandidates='<p class="notice">No suitable driver can take this pickup right now.</p><div class="quick-unavailable">'+r.recoveryCandidates.slice(0,4).map(c=>'<p><strong>'+esc(c.name)+'</strong><small>'+esc(c.reasons.join(' · '))+'</small></p>').join('')+'</div>';
  const options=nearest?quickDriverCard(nearest,r.pickupAt,true)+
   (others.length?'<details class="quick-alternatives"><summary>Other available drivers ('+others.length+')</summary>'+others.map(c=>quickDriverCard(c,r.pickupAt,false)).join('')+'</details>':'<p class="help">No other suitable drivers are available.</p>'):noCandidates;
  paint(header('Review pickup drivers',r.reference)+'<p class="quick-route"><strong>'+esc(t.pickup)+'</strong><br>Pickup '+date(r.pickupAt)+' '+time(r.pickupAt)+' · '+t.passengers+' passenger(s)</p>'+
   (blocked?'<p class="notice">'+esc(blocked)+'</p>':pending+options+
   '<details class="quick-alternatives"><summary>How offers work</summary><p>'+(r.etaSource==='road'?'Road ETAs':'Simulated ETAs')+' checked at '+time(r.at)+'. Drivers have 45 seconds to accept. Dispatch tries the next eligible driver after a decline or timeout.</p></details>')+
   '<p id="quick-error" class="validation-error" role="alert"></p>'+footer);
  menu.querySelectorAll('[data-quick-driver]').forEach(button=>button.onclick=async()=>{
   menu.querySelectorAll('button').forEach(control=>control.disabled=true);
   try {
    await api('/api/trips/'+tripId+'/action',{action:'manual_offer',driverId:button.dataset.quickDriver,recovery:true,reason:'Owner reviewed availability'},requestId());
   } catch (e) {
    if(menu.isConnected){
     menu.querySelector('#quick-error').textContent=e.message;
     menu.querySelectorAll('button').forEach(control=>control.disabled=false);
    }
    return;
   }
   close();
   toast('Offer sent. Waiting for driver acceptance.');
   await run(refresh);
  });
 } catch(e) {
  if(menu.isConnected) paint(header('Could not load drivers')+'<p>'+esc(lookup.signal.aborted?'The driver lookup timed out. Select Refresh ETAs to try again.':e.message)+'</p>'+footer);
 } finally { clearTimeout(timeout); }
}

function dispatchIndicator() {
  const h=state.dispatchHealth, routing=h?.routing;
  let label = !connected ? 'Dispatch connection interrupted' : h?.lastError ? 'Dispatch needs attention' : 'Demo dispatch';
  if (connected && !h?.lastError && routing?.mode==='road') label = routing.status==='blocked' ? 'Road routing needs attention' :
    routing.status==='ready' ? 'Road ETA dispatch' : 'Waiting for road ETAs';
  const healthy = connected && h?.lastSuccessAt && Date.now()-h.lastSuccessAt<15000 && !h.lastError && routing?.status!=='blocked';
  return '<button class="dispatch-health ' + (healthy?'healthy':'unknown') + '" id="dispatch-health"><i></i>' + esc(label) + '</button>';
}
function showDispatchHealth() {
  const h=state.dispatchHealth, routing=h?.routing;
  const road = routing?.mode==='road';
  modal('<h2>Dispatch status</h2><p>' + (road ? 'Road ETA pilot · Offers require fresh phone GPS and a Google road estimate.' :
    'Local demo · Pickup estimates are simulated.') + '</p><p>Offers open ' + dispatchLead() +
    ' minutes before pickup. Drivers confirm by accepting an offer.</p>' +
    '<p><strong>Last scheduler check</strong> ' + (h?.lastSuccessAt ? time(h.lastSuccessAt) : 'Waiting for the first check') +
    '. The server checks every ' + (h?.intervalSeconds || 3) + ' seconds. An available driver can bring an eligible waiting ride forward for another attempt.</p>' +
    (routing?.lastError ? '<p class="validation-error">' + esc(routing.lastError) + '</p>' : '') +
    (road ? '<p>Last successful route matrix ' + (routing.lastMatrixAt ? time(routing.lastMatrixAt) : 'pending') +
      '.</p><small>Powered by Google, ©' + new Date().getFullYear() + ' Google</small>' : '') +
    (h?.lastError ? '<p class="validation-error">' + esc(h.lastError) + '</p>' : '') +
    (config.mode==='pilot' ? '<p>Customer SMS and background tracking are pending.</p>' : '<button class="btn primary" id="health-run-demo">Watch auto dispatch</button>'));
  if ($('#health-run-demo')) $('#health-run-demo').onclick=()=>run(async()=>{$('#modal').close();await startAutomaticDemo();});
}
async function startAutomaticDemo(){tab='overview';await api('/api/demo/charlotte-fleet',{action:'start'});fleetSource='scenario';localStorage.setItem('prolift-fleet-source','scenario');dispatchView='now';dispatchPage=1;mapPriorityFilter='now';focusedRideId=null;selectedScenarioTrip=null;selectedDriverId=null;if(geoMap){geoMap.remove();geoMap=null;geoMarkers=null;}await refresh();toast('Charlotte test started. Simulated drivers accept offers automatically; watch the queue update.');}

async function loadVolumeDemo(){await api('/api/demo/volume',{});fleetSource='volume';localStorage.setItem('prolift-fleet-source','volume');dispatchView='now';dispatchPage=1;mapPriorityFilter='now';focusedRideId=null;if(geoMap){geoMap.remove();geoMap=null;geoMarkers=null;}if($('#modal')?.open)$('#modal').close();await refresh();await showVolumeData();}
async function showVolumeData(page=1,search='',status=''){
 const query=new URLSearchParams({page,search,status}),r=await api('/api/demo/volume?'+query);
 modal('<h2>500-trip test dataset</h2><p>20 Charlotte cars · 4 / 7 passenger seats · dummy bookings only</p><form id="volume-search" class="report-filters"><label>Find a booking<input id="volume-query" maxlength="100" value="'+esc(search)+'" placeholder="LOAD-0500 or pickup"></label><label>Status<select id="volume-status"><option value="">All statuses</option>'+['awaiting_driver','offered','accepted','heading_to_pickup','onboard','needs_reassignment','completed','cancelled'].map(x=>'<option value="'+x+'" '+(status===x?'selected':'')+'>'+esc(labels[x]||x)+'</option>').join('')+'</select></label><button class="btn" type="submit">Search</button></form><p>'+r.total+' matching trips · Page '+r.page+' / '+r.pages+'</p><div class="table-scroll"><table class="volume-table"><thead><tr><th>Trip</th><th>Pickup</th><th>Passengers</th><th>Status</th></tr></thead><tbody>'+r.rows.map(t=>'<tr><td><button class="text-btn" data-volume-detail="'+esc(t.id)+'">'+esc(t.reference)+'</button><small>'+esc(t.customerName)+'</small></td><td>'+date(t.pickupAt)+' '+time(t.pickupAt)+'<small>'+esc(t.pickup)+' → '+esc(t.destination)+'</small></td><td>'+t.passengers+'</td><td>'+badge(t.status)+'</td></tr>').join('')+'</tbody></table></div><div class="dispatch-paging"><button class="btn" id="volume-prev" '+(r.page<=1?'disabled':'')+'>Previous</button><small>25 per page</small><button class="btn" id="volume-next" '+(r.page>=r.pages?'disabled':'')+'>Next</button></div><p class="help">Synthetic history and active fixtures for testing. This is a data-volume test, not 500 concurrent live rides.</p>');
 $('#volume-search').onsubmit=e=>{e.preventDefault();run(()=>showVolumeData(1,$('#volume-query').value,$('#volume-status').value));};$('#volume-prev').onclick=()=>run(()=>showVolumeData(r.page-1,search,status));$('#volume-next').onclick=()=>run(()=>showVolumeData(r.page+1,search,status));document.querySelectorAll('[data-volume-detail]').forEach(b=>b.onclick=()=>tripDetail(b.dataset.volumeDetail));
}

function regularDriverModal(id){const t=state.trips.find(t=>t.id===id),drivers=state.drivers.filter(d=>(d.demoRunId||null)===(t.demoRunId||null));modal('<h2>Regular customer driver</h2><p>'+esc(t.customerName)+' · '+esc(t.customerPhone)+'</p><label>Try this driver first<select id="regular-driver-choice"><option value="">'+(t.lgtc?'Use customer default':'No regular driver')+'</option>'+drivers.map(d=>'<option value="'+esc(d.id)+'" '+(t.preferredDriver?.id===d.id?'selected':'')+'>'+esc(d.name)+' · '+d.seats+' seats</option>').join('')+'</select></label><div class="notice">If this driver is unavailable, unsuitable, declines or times out, offer the closest suitable available driver by pickup ETA. Driver acceptance is always required.</div><p class="help">'+(t.lgtc?'Applies to LGTC bookings for this rider. Use customer default to clear the LGTC override.':'Applies to future offers for this mobile number in this fleet.')+' Existing reservations, offers already sent and confirmed assignments are kept.</p><button class="btn primary" id="save-regular-driver">Save regular driver</button>');$('#save-regular-driver').onclick=()=>run(async()=>{await api('/api/customer-preference',{tripId:id,driverId:$('#regular-driver-choice').value||null});$('#modal').close();await refresh();toast('Regular driver saved. Automatic fallback is enabled.');});}

const ownerGroups = [
 ['Transport',[['overview','Live Fleet'],['trips','Trips'],['trip-sources','Trip Sources'],['imports','Route Workbench'],['schedule','Upcoming rides'],['readiness','Pickup readiness']]],
 ['Activity',[['reports','Reports'],['activity','Activity log'],['messages','Customer updates'],['help','Support requests']]],
 ['Users & fleet',[['shifts','Schedule Management'],['drivers','Drivers & vehicles'],['customers','Regular riders']]],
 ['Settings',[['settings','Dispatch settings'],['fleet-import','Fleet data upload'],['lgtc-settings','LGTC dispatch settings'],['manage','Operations tools']]],
];
let ownerMenuOpen = !matchMedia('(max-width: 600px)').matches;
let ownerMenuGroup;
function ownerPageHeading(title, description, actions = '') {
  return '<section class="owner-page-heading"><div><h1>' + title + '</h1><p>' + description +
    '</p></div>' + (actions ? '<div class="heading-actions">' + actions + '</div>' : '') + '</section>';
}
function ownerShell(content,retainedMap){
 const dutyScroll = $('#driver-duty-roster')?.scrollTop || 0;
 const current = tab === 'fleet' ? 'overview' : tab;
 const group = ownerGroups.find(([,items])=>items.some(([id])=>id===current));
 const menu = ownerGroups.map(([name,items])=>'<details data-owner-group="'+esc(name)+'"'+
   ((ownerMenuGroup ?? group?.[0])===name?' open':'')+'><summary>'+esc(name)+'</summary>'+
   items.map(([id,label])=>'<button type="button" data-owner-nav="'+id+'"'+
     (current===id?' aria-current="page"':'')+'>'+esc(label)+'</button>').join('')+'</details>').join('');
 $('#app').innerHTML='<a class="skip-link" href="#main-content">Skip to main content</a><div class="simple-owner role-owner owner-portal">'+
   '<aside class="owner-sidebar"><button type="button" id="owner-menu-toggle" aria-label="Toggle navigation" aria-controls="owner-navigation" aria-expanded="'+ownerMenuOpen+'">☰</button>'+
   '<nav id="owner-navigation" aria-label="Main navigation"'+(ownerMenuOpen?'':' hidden')+'><button class="owner-sidebar-brand" data-owner-nav="overview">'+easyrideLogo+'</button>'+menu+'</nav></aside>'+
   '<div class="owner-portal-content"><header class="owner-portal-bar"><span>'+esc(group?.[0]||'EASYRIDE')+' / <strong>'+
   esc(group?.[1].find(([id])=>id===current)?.[1]||'Owner workspace')+'</strong></span><div class="owner-account"><span id="connection" class="connection">'+
   (connected?'Connected':'Reconnecting…')+'</span><button class="icon-btn" id="logout" aria-label="Sign out">'+icon('logout')+'</button></div></header>'+
   '<main id="main-content" tabindex="-1"><div class="page-content '+(tab==='overview'?'fleet-home':'')+'">'+content+'</div></main></div></div><dialog id="modal"></dialog>';
 $('#logout').onclick=signOut;
 $('#owner-menu-toggle').onclick=()=>{
   ownerMenuOpen=!ownerMenuOpen;
   $('#owner-navigation').hidden=!ownerMenuOpen;
   $('#owner-menu-toggle').setAttribute('aria-expanded',String(ownerMenuOpen));
   requestAnimationFrame(()=>geoMap?.invalidateSize());
 };
 document.querySelectorAll('[data-owner-group]').forEach(item=>item.querySelector('summary').onclick=event=>{
   event.preventDefault();
   ownerMenuGroup=item.open?'':item.dataset.ownerGroup;
   for(const sibling of document.querySelectorAll('[data-owner-group]')) sibling.open=sibling.dataset.ownerGroup===ownerMenuGroup;
 });
 document.querySelectorAll('[data-owner-nav]').forEach(button=>button.onclick=()=>{
   tab=button.dataset.ownerNav;
   ownerMenuGroup=undefined;
   if(matchMedia('(max-width: 760px)').matches) ownerMenuOpen=false;
   search=''; filter='all'; boardPage=1;
   render();
   if(['imports','trip-sources'].includes(tab)) loadLgtcHistory();
   if(tab==='lgtc-settings') run(loadLgtcSettings);
   window.scrollTo(0,0);
 });

 const node=$('#geo-fleet-map');if(retainedMap&&node&&geoMap)node.replaceWith(retainedMap);else if(geoMap){geoMap.remove();geoMap=null;geoMarkers=null;}bindActions();
 if ($('#driver-duty-roster')) $('#driver-duty-roster').scrollTop = dutyScroll;
}
function managePage(){return '<section class="simple-page-head"><div><h1>Operations tools</h1><p>Your team, customers and business settings.</p></div></section><div class="manage-grid">'+[['drivers','car','Drivers & cars','Availability, vehicles and passenger seats'],['customers','users','Regular customers','Save preferred drivers and fallback'],['lgtc-settings','upload','LGTC dispatch settings','Predefine regular drivers and day plans'],['reports','grid','Reports','Driver and vehicle activity'],['settings','clock','Settings','Pickup timing and customer reminders']].map(([id,i,title,detail])=>'<button class="manage-card" data-go="'+id+'"><span class="manage-card-icon">'+icon(i)+'</span><strong>'+title+'</strong><small>'+detail+'</small>'+icon('arrow')+'</button>').join('')+'</div><div class="manage-links"><button class="text-btn" data-go="help">Support requests</button><button class="text-btn" data-go="messages">Customer updates</button><button class="text-btn" data-go="activity">Activity log</button></div>' + (config.mode==='pilot'?'':'<details class="manage-advanced"><summary>Test data & tools</summary><div><label>Fleet data<select id="dispatch-source" aria-label="Fleet data source">'+[['device','Phone GPS'],['sample','Sample fleet'],['scenario','Charlotte test fleet'],['replay','GPS replay'],['volume','500-trip dataset']].map(([id,label])=>'<option value="'+id+'" '+(fleetSource===id?'selected':'')+'>'+label+'</option>').join('')+'</select></label><button class="btn" id="manage-demo">Watch auto dispatch</button><button class="btn" id="manage-volume">Browse 500 test trips</button><button class="btn" id="dispatch-more">More test tools</button></div></details>');}
var regularCustomerSearch='';
function regularCustomersPage(){
 const groups=new Map();for(const t of state.trips){if(t.isSharedRun||!t.customerPhone)continue;const key=(t.demoRunId||'ordinary')+':'+t.customerPhone,g=groups.get(key);if(g){g.count++;if(t.pickupAt>g.trip.pickupAt)g.trip=t;}else groups.set(key,{trip:t,count:1});}
 const needle=regularCustomerSearch.trim().toLowerCase(),rows=[...groups.values()].filter(g=>needle?[g.trip.customerName,g.trip.customerPhone,g.trip.preferredDriver?.name].join(' ').toLowerCase().includes(needle):g.trip.preferredDriver).sort((a,b)=>a.trip.customerName.localeCompare(b.trip.customerName));
 return '<section class="simple-page-head"><div><h1>Regular riders</h1><p>Find a customer by name or mobile to save their regular driver.</p></div></section><form id="regular-customer-search" class="customer-find"><input id="regular-customer-query" type="search" placeholder="Customer name or mobile" aria-label="Find customer" value="'+esc(regularCustomerSearch)+'"><button class="btn primary">Find customer</button></form><section class="bookings-panel customer-list">'+(rows.length?rows.slice(0,20).map(g=>{const t=g.trip;return '<article><div><strong>'+esc(t.customerName)+(t.demoRunId?' <small>TEST</small>':'')+'</strong><small>'+esc(t.customerPhone)+' · '+g.count+' booking(s)</small></div><div><span>'+esc(t.preferredDriver?.name||'No regular driver')+'</span><button class="btn" data-regular-customer="'+esc(t.id)+'">'+(t.preferredDriver?'Change driver':'Set driver')+'</button></div></article>';}).join(''):'<div class="dispatch-empty"><h3>'+(needle?'No matching customer':'No saved regular customers')+'</h3><p>Search an existing customer to choose their regular driver.</p></div>')+'</section>'+(rows.length>20?'<p class="help">Showing 20 of '+rows.length+' matches. Refine your search to find a specific customer.</p>':'');
}







window.addEventListener('royalcab-demo-open-ride', event => { if (user?.role === 'owner' && state?.trips.some(trip => trip.id === event.detail)) tripDetail(event.detail); });


























