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
let connectionMode='connecting', connectionTimer, fallbackRequest, lastStreamUpdate=0, lastSnapshotAt=0, requestFreshGps;
const STREAM_STALE_MS=22000, RECOVERY_INTERVAL_MS=4000;
const active = t => !['completed', 'cancelled'].includes(t.status);
const labels = { pooled:'Shared run planned', awaiting_driver: 'Awaiting driver', needs_reassignment: 'Needs reassignment', offered: 'Offer pending', accepted: 'Accepted', heading_to_pickup: 'To pickup', arrived: 'At pickup', onboard: 'Onboard', completed: 'Completed', cancelled: 'Cancelled', online: 'Available', busy: 'On trip', offline: 'Offline', valid: 'Validated', preview: 'Preview only', imported: 'Imported' };
const time = v => new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const date = v => new Date(v).toLocaleDateString([], { month: 'short', day: 'numeric' });
function badge(status, red = false) { return `<span class="badge ${red ? 'danger' : esc(status)}">${red ? icon('flag') : ''}${esc(red ? 'Needs reassignment' : labels[status] || status)}</span>`; }
function toast(message, error = false) { const el = $('#toast'); el.textContent = message; el.className = 'show' + (error ? ' error' : ''); clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.className = ''; }, 6500); }
async function api(url, body, key, signal) {
  const account=user;
  const res = await fetch(url, { signal, method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
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
function applySnapshot(r, explicit=false) {
    if (!user) return;
    if (state && (r.state.revision<state.revision ||
        r.state.revision===state.revision && r.at<lastSnapshotAt)) {
      if(explicit) render();
      return;
    }
    const previous=new Set((state?.offers||[]).filter(o=>o.status==='pending').map(o=>o.id));
    const previousTrips = user.role==='owner' && state ? new Map(state.trips.map(trip => [trip.id,trip.status])) : null;
    const driverRide=user.role==='driver'&&state?.trips.find(t=>t.driverId===user.driverId&&active(t));
    const previousDriver=state?.trips.find(t=>t.id===focusedRideId)?.driverId;
    state=r.state;
    if(user.role==='owner'&&focusedRideId){
      const driverId=state.trips.find(t=>t.id===focusedRideId)?.driverId;
      if(driverId!==previousDriver) selectedDriverId=driverId||null;
    }
    lastSnapshotAt=r.at;
    if(user.role==='owner'&&!fleetSourceInitialized){const savedSource=localStorage.getItem('prolift-fleet-source');fleetSource=initialFleetSource(savedSource);selectFirstQueue();fleetSourceInitialized=true;}
    if (user?.role === 'owner' && tab === 'imports') updateLgtcLiveStatus();
    if(user?.role==='driver'&&(state.offerUpdates||[]).some(o=>previous.has(o.id)))toast('This offer closed: another driver accepted or dispatch changed the offer.');
    if(driverRide&&!state.trips.some(t=>t.id===driverRide.id)) toast('This ride is no longer assigned to you. Check with dispatch before continuing.',true);
    if (previousTrips) {
      const completed = state.trips.filter(trip => trip.status === 'completed' && previousTrips.get(trip.id) !== 'completed');
      if (completed.length) updateOwnerAfterCompletion(completed);
    }
    // Preserve active form input and modal focus while updates continue in memory.
    if (explicit || !['imports','lgtc-settings'].includes(tab) && !mapInteracting && !(tab==='settings'&&settingsDirty) && !$('dialog[open], .dispatch-planning[open]') && !document.activeElement?.closest('form') && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) render();
}
async function refresh() {
  const account=user, r=await api('/api/state');
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
  stream?.close();
  lastStreamUpdate=Date.now();
  const source=stream=new EventSource('/api/events');
  source.onerror=()=>{
    if(stream!==source) return;
    if(connectionMode==='checking') return;
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
    if(connectionMode!=='checking') setConnection('reconnecting');
    startStream();
  }
  if(connected || fallbackRequest || connectionMode==='connecting') return;
  const request=fallbackRequest=new AbortController();
  const timeout=setTimeout(()=>request.abort(),RECOVERY_INTERVAL_MS);
  try {
    const r=await api('/api/state',undefined,undefined,request.signal);
    if(fallbackRequest!==request) return;
    if(!connected) setConnection('checking');
    applySnapshot(r);
  } catch {
    if(fallbackRequest===request && !connected) setConnection(navigator.onLine?'reconnecting':'offline');
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
}
function setConnection(mode) {
  connectionMode=mode;
  connected=mode==='live';
  updateConnection();
}
function updateConnection() {
  const el=$('#connection');
  if(!el) return;
  const label={live:'Live connection',connecting:'Connecting…',reconnecting:'Reconnecting · last known',offline:'Offline · last known',checking:'Live interrupted · refreshing'}[connectionMode];
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
function renderLogin() {
  if(config.mode==='pilot' && loginTab==='customer') loginTab='owner';
  $('#app').innerHTML = `<main class="login"><section class="login-brand"><a class="brand" href="/">${icon('bolt')} ProLift<span>TRANSPORT OPERATIONS</span></a><div class="login-message"><div class="eyebrow">EVERY TRIP. CONNECTED.</div><h1>A clear road <br>from plan <br>to pickup<span>.</span></h1><p>Your fleet, your drivers, and your customers.<br>One place to keep everything moving.</p><div class="login-line">${icon('map')} Plan. Assign. Track. Deliver.</div></div><small>ProLift · Built around your operation</small></section><section class="login-panel"><div class="demo-label">${config.mode==='pilot'?'CONTROLLED ROAD PILOT':'LOCAL DEMO · SIMULATED SERVICES'}</div><h2>Welcome to ProLift</h2><p class="muted">Choose your workspace to get started.</p><div class="role-tabs">${(config.mode==='pilot'?['owner','driver']:['owner','driver','customer']).map(r => `<button data-login-tab="${r}" class="${r === loginTab ? 'selected' : ''}">${esc(r[0].toUpperCase() + r.slice(1))}</button>`).join('')}</div><div id="login-content">${loginContent()}</div><div class="login-note">${icon('check')} One workspace for every part of your journey.<br>${config.mode==='pilot'?'Use the access code issued for your account.':'SMS, positions, and travel estimates are simulated in this build.'}</div></section></main>`;
  bindLogin();
}
function loginContent() {
  if (config.mode === 'pilot') return '<form id="pilot-login">' +
    (loginTab === 'driver' ? '<label>Driver ID<input name="driverId" maxlength="80" required autocomplete="username"></label>' : '') +
    '<label>Access code<input type="password" name="code" minlength="20" maxlength="150" required autocomplete="current-password"></label>' +
    '<button class="btn primary full">Sign in</button></form>';
  if (loginTab === 'owner') return `<div class="workspace-card">${icon('grid')}<h3>Your fleet command center</h3><p>Manage planned trips, dispatch drivers, and see your fleet in one view.</p></div><button class="btn primary full" id="owner-login">Open owner dashboard ${icon('arrow')}</button><p class="help">Demo access only. Production requires individual owner accounts and MFA.</p>`;
  if (loginTab === 'driver') return `<label>Demo driver<select id="driver-choice">${config.drivers.map(d => `<option value="${d.id}">${esc(d.name)} · ${esc(d.vehicle)}</option>`).join('')}</select></label><div class="workspace-card compact">${icon('car')} Accept offers, update trips, and keep dispatch informed.</div><button class="btn primary full" id="driver-login">Open driver app ${icon('arrow')}</button>`;
  return `<div class="workspace-card compact">${icon('users')} Try the sample customer, Alex Morgan.</div><button class="btn primary full" type="button" id="demo-customer-login">Open customer app ${icon('arrow')}</button><details class="help"${codeSent ? ' open' : ''}><summary>Test mobile verification</summary><form id="customer-login"><label>Your name<input id="customer-name" maxlength="100" autocomplete="name" value="${esc(loginName || 'Alex Morgan')}" required></label><label>Mobile number<input id="customer-phone" type="tel" autocomplete="tel" placeholder="+15550102001" value="${esc(loginPhone || '+15550102001')}" required></label><p class="help">Include the country code. The sample number has an existing planned trip.</p>${codeSent ? '<label>Verification code<input id="sms-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required></label>' : ''}<div id="sms-hint" class="sms-hint"></div><button class="btn primary full" type="submit">${codeSent ? 'Verify & continue' : 'Send verification code'} ${icon('arrow')}</button>${codeSent ? '<button class="btn quiet full" type="button" id="resend">Request another code</button>' : ''}</form></details>`;
}
async function enter(u) {stopConnection();state=null;lastSnapshotAt=0;fleetSourceInitialized=false; readinessData=null;readinessRevision=-1;readinessFilter='all';readinessPageNumber=1; scheduledData=null;scheduledPageNumber=1;selectedCustomerTrip=null;user = u; if(config.mode==='pilot') config=await api('/api/config'); tab = user.role === 'owner' ? 'overview' : user.role === 'driver' ? 'work' : 'mytrips'; await refresh(); listen(); if (u.role === 'owner') loadLgtcHistory(); }
function bindLogin() {
  document.querySelectorAll('[data-login-tab]').forEach(el => el.onclick = () => { loginTab = el.dataset.loginTab; codeSent = false; renderLogin(); });
  if ($('#owner-login')) $('#owner-login').onclick = () => run(async () => enter((await api('/api/demo-login', { role: 'owner' })).user));
  if ($('#driver-login')) $('#driver-login').onclick = () => run(async () => enter((await api('/api/demo-login', { role: 'driver', driverId: $('#driver-choice').value })).user));
  if ($('#demo-customer-login')) $('#demo-customer-login').onclick = () => run(async () => enter((await api('/api/demo-login', { role: 'customer' })).user));
  if ($('#customer-login')) $('#customer-login').onsubmit = e => { e.preventDefault(); run(async () => {
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
  const nav = owner ? [['overview', 'map', 'Live fleet'], ['readiness','check','Pickup readiness'], ['trips', 'car', 'All trips'], ['schedule', 'clock', 'Upcoming rides'], ['imports', 'upload', 'Import trips'], ['drivers', 'users', 'Drivers'], ['activity', 'clock', 'Activity'], ['reports','grid','Reports'], ['messages','bell','Messages'], ['help','bell','Help requests'], ['settings','grid','Settings']] : user.role === 'driver' ? [['work', 'car', 'My work'], ['scheduled','clock','Scheduled rides'], ['help','bell','Help requests'], ['history', 'clock', 'Trip history']] : [['mytrips', 'car', 'My trips'], ['help','bell','Help requests'], ['messages','bell','Ride updates'], ['history', 'clock', 'Trip history']];
  const titles = {readiness: 'Pickup readiness',scheduled:'Scheduled rides',help:'Help requests', overview: 'Live fleet', trips: 'All trips', schedule: 'Upcoming rides', fleet: 'Live fleet', imports: 'Import planned trips', drivers: 'Your drivers', activity: 'Activity log', work: 'Your driving day', mytrips: 'Your trips', history: 'Trip history', reports:'Reports', messages:'Customer messages', settings:'Settings' };
  $('#app').innerHTML = `<a class="skip-link" href="#main-content">Skip to main content</a><div class="app-layout role-${esc(user.role)}"><aside class="sidebar"><a class="brand" href="/">${icon('bolt')} ProLift</a><div class="workspace-label">${owner ? 'OWNER WORKSPACE' : user.role === 'driver' ? 'DRIVER WORKSPACE' : 'CUSTOMER WORKSPACE'}</div><nav>${nav.map(([id, i, label]) => `<button data-nav="${id}" class="nav-item ${tab === id ? 'active' : ''}" ${tab===id?'aria-current="page"':''}>${icon(i)}${label}${id === 'trips' && state.trips.some(t => t.redFlag) ? '<span class="nav-alert">!</span>' : ''}</button>`).join('')}</nav>${quickNavigation(nav)}<label class="mobile-navigation">Workspace<select id="workspace-navigation" aria-label="Open workspace section">${nav.map(([id,,label])=>`<option value="${id}" ${tab===id?'selected':''}>${label}</option>`).join('')}</select></label><div class="sidebar-bottom"><div class="simulation">${icon('bolt')}<div><strong>Demo environment</strong><span>Dummy GPS, SMS & routing</span></div></div><div class="profile"><span class="avatar">${esc(user.name[0])}</span><div><strong>${esc(user.name)}</strong><span>${owner ? 'Fleet owner' : user.role === 'driver' ? 'Driver' : 'Customer'}</span></div><button id="logout" class="icon-btn" title="Sign out" aria-label="Sign out">${icon('logout')}</button></div></div></aside><main class="main" id="main-content" tabindex="-1"><header class="topbar"><span>Workspace <span class="slash">/</span> <strong>${titles[tab]}</strong></span><div><span id="connection" class="connection">${connected ? 'Live connection' : 'Connecting…'}</span><span class="today">${new Date().toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })}</span></div></header><div class="page-content ${user.role === 'owner' && tab === 'overview' ? 'fleet-home' : ''}">${content}</div><footer>ProLift operations <span>PHONE GPS OPT-IN · SAMPLE FLEET SEPARATE · LOCAL DATA</span></footer></main></div><dialog id="modal"></dialog>`;
  document.querySelectorAll('[data-nav]').forEach(el => el.onclick = () => { tab = el.dataset.nav; search = ''; filter = 'all'; render(); });
  $('#logout').onclick = () => run(async () => { if(user.role==='driver'&&gpsWatch!==null)await stopPhoneTracking();await api('/api/logout', {}); stopConnection(); user = null; codeSent = false; renderLogin(); });
  const newMap=document.querySelector('#geo-fleet-map');if(retainedMap&&newMap&&geoMap){newMap.replaceWith(retainedMap);}else if(geoMap){geoMap.remove();geoMap=null;geoMarkers=null;}
  bindActions();
}
function quickNavigation(nav){const ids=user.role==='owner'?['overview','readiness','trips','schedule']:user.role==='driver'?['work','scheduled','history','help']:['mytrips','messages','history','help'];return '<div class="quick-nav" aria-label="Quick workspace navigation">'+nav.filter(([id])=>ids.includes(id)).map(([id,i,label])=>'<button data-nav="'+id+'" class="'+(tab===id?'active':'')+'" '+(tab===id?'aria-current="page"':'')+'>'+icon(i)+esc(label)+'</button>').join('')+'</div>';}

function scenarioTrips(){return state.fleetScenario?state.trips.filter(t=>t.demoRunId===state.fleetScenario.runId):[];}
function scenarioControls(){const r=state.fleetScenario,trips=scenarioTrips(),completed=trips.filter(t=>t.status==='completed').length;return '<section class="scenario-controls"><div><span class="eyebrow">CHARLOTTE FLEET SIMULATION</span><h2>4 cars. 6 trips. Watch dispatch work.</h2><p>'+(r?esc(r.status)+' · '+completed+' of 6 rides completed.':'Nearest eligible driver → offer → simulated acceptance → pickup → drop-off → available again.')+'</p><small>Dummy coordinates, automatic test-driver responses and accelerated travel. No real customers or SMS.</small></div><div class="card-actions"><button class="btn primary" data-scenario-action="start">'+(r?'Restart Charlotte fleet':'Run Charlotte fleet')+'</button>'+(r?.status==='running'?'<button class="btn" data-scenario-action="stop">Stop fleet test</button>':'')+'</div></section>';}
function scenarioRideBoard(){if(fleetSource!=='scenario'||!state.fleetScenario)return '';return '<section class="scenario-ride-board"><div class="panel-heading"><div><h2>Follow each Charlotte ride</h2><p>Choose a ride to highlight its car, pickup, destination and trail.</p></div></div><div class="scenario-cards">'+scenarioTrips().map(t=>{const o=state.offers.find(o=>o.tripId===t.id&&o.status==='pending'),d=state.drivers.find(d=>d.id===(t.driverId||o?.driverId)),e=ProLiftRideExplanation.explain(state,t,'owner');return '<article class="panel scenario-card '+(selectedScenarioTrip===t.id?'selected':'')+'"><div class="trip-card-head"><strong>'+esc(t.reference)+'</strong>'+badge(t.status)+'</div><p class="scenario-car">'+(d?esc(d.name)+' · '+esc(d.plate):'Waiting for an available car')+'</p><div class="scenario-route"><span><b>PICKUP</b>'+esc(t.pickup)+'</span><span><b>DROP-OFF</b>'+esc(t.destination)+'</span></div><p>'+esc(e.meaning)+'</p>'+(t.demoAssignmentReason?'<div class="scenario-reason">'+esc(t.demoAssignmentReason)+'</div>':'<div class="scenario-reason">Busy cars cannot take a second ride. A freed car will be considered automatically.</div>')+(t.demoCandidateRanking?'<details><summary>Driver choices when offered</summary><ol>'+t.demoCandidateRanking.slice(0,4).map(c=>'<li>'+esc(c.name)+' · '+c.eta+' min simulated ETA</li>').join('')+'</ol></details>':'')+'<div class="card-actions"><button class="btn primary" data-follow-scenario="'+t.id+'">Follow ride</button><button class="btn" data-detail="'+t.id+'">Details</button></div></article>';}).join('')+'</div></section>';}
function drawScenarioRoutes(){if(!geoScenarioRoutes)return;geoScenarioRoutes.clearLayers();if(fleetSource!=='scenario'||!state.fleetScenario)return;const run=state.fleetScenario,t=scenarioTrips().find(t=>t.id===selectedScenarioTrip),driver=t?.driverId||state.offers.find(o=>o.tripId===t?.id&&o.status==='pending')?.driverId||selectedDriverId;for(const [id,trail] of Object.entries(run.trails)){if(driver&&driver!==id)continue;fleetMapProvider().polyline(trail.map(p=>[p.lat,p.lng]),{color:driver?'#285fda':'#718bb8',weight:driver?5:2,opacity:.7}).addTo(geoScenarioRoutes);}if(!t)return;for(const [name,label,color] of [[t.pickup,'PICKUP','#14916b'],[t.destination,'DROP-OFF','#7754d5']]){const p=config.places.find(p=>p.name===name);if(p)fleetMapProvider().circleMarker([p.lat,p.lng],{radius:7,color:'#fff',weight:2,fillColor:color,fillOpacity:1}).addTo(geoScenarioRoutes).bindTooltip(label,{permanent:true,direction:'top'});}}

function trackingReplayControls(){const r=state.trackingReplay,active=r&&['running','paused'].includes(r.status);return '<section class="tracking-test-panel"><div><span class="eyebrow">TRACKING TEST · NO PHONE REQUIRED</span><h2>Follow the test car in Charlotte.</h2><p>'+(r?'Replay '+esc(r.status)+' · '+Math.round(r.progress*100)+'% · '+r.sequence+' validated readings.':'Press Start tracking test. Look for the large car labeled TEST CAR on the map below.')+'</p></div><div class="card-actions"><button class="btn primary" data-replay-action="start">'+(r?'Restart tracking test':'Start tracking test')+'</button>'+(active?'<button class="btn" data-replay-action="'+(r.status==='paused'?'resume':'pause')+'">'+(r.status==='paused'?'Resume test':'Pause test')+'</button><button class="btn" data-replay-action="stop">Stop test</button>':'')+'</div>'+(r?'<progress max="1" value="'+r.progress+'" aria-label="Coordinate replay progress"></progress>':'')+'</section>';}

function operationsSummary(){const fleet=ProLiftBoard.fleet(state).filter(i=>matchesFleetSource(i.driver)),trips=state.trips.filter(t=>!t.demoRunId),attention=trips.filter(t=>ProLiftBoard.group(t)==='attention').length;return '<div class="operations-summary">'+[['Available drivers',fleet.filter(d=>d.status==='available').length,'Ready for a pickup','car'],['Active rides',state.trips.filter(t=>t.driverId&&active(t)&&fleet.some(i=>i.driver.id===t.driverId)).length,'Accepted and in progress','map'],['Upcoming pickups',trips.filter(t=>active(t)&&t.pickupAt>=Date.now()).length,'Scheduled ahead','clock'],['Needs attention',attention,'Review dispatch exceptions','flag']].map(([label,value,note,i])=>'<article class="operations-metric '+(i==='flag'&&value?'attention':'')+'"><div>'+label+icon(i)+'</div><strong>'+value+'</strong><small>'+note+'</small></article>').join('')+'</div>';}
function heading(eyebrow, title, subtitle, buttons = '') { return `<section class="page-heading"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${subtitle}</p></div><div class="heading-actions">${buttons}</div></section>`; }
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
function queueFor(source = fleetSource, now = Date.now()) {
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
  if (fleetSource === 'replay') return '<h3>GPS replay</h3><p>Choose a queue above to view open rides.</p>';
  if (!total) return config.mode==='pilot' ? '<h3>No open rides</h3><p>Import and approve your LGTC schedule or add a booking.</p>' :
    '<h3>No open rides in this queue</h3><p>Choose another queue, open Bookings, or start a Charlotte test.</p><button class="btn small" id="watch-auto-dispatch">Start Charlotte test</button>';
  const title = { now:'No rides in the next hour', later:'No later pickups', attention:'No rides need attention' }[dispatchView];
  return '<h3>' + title + '</h3><p>Choose another queue tab above to see the open rides.</p>';
}
function dispatchBrief(lists, now) {
  const next = [...lists.now, ...lists.later, ...lists.attention]
    .filter(ride => ride.pickupAt >= now && !['arrived', 'onboard'].includes(ride.status))
    .reduce((earliest, ride) => !earliest || ride.pickupAt < earliest.pickupAt ? ride : earliest, null);
  const attention = lists.attention.length;
  const nextTitle = next ? time(next.pickupAt) + ' · ' + next.pickup : 'No upcoming pickup';
  const nextDetail = next ? date(next.pickupAt) + ' · ' + ProLiftBoard.dispatchLabel(state, next, now).label : 'Future bookings appear here.';
  return '<section class="dispatch-brief" aria-label="Dispatch priorities">' +
    '<article class="dispatch-brief-card' + (attention ? ' needs-review' : '') + '"><span class="dispatch-brief-icon" aria-hidden="true">' + icon('flag') + '</span><div><small>NEEDS ATTENTION</small><strong>' +
    (attention ? attention + (attention === 1 ? ' ride to review' : ' rides to review') : 'Queue is clear') +
    '</strong><p>' + (attention ? 'Missed pickups and flagged rides.' : 'No overdue or flagged rides in this queue.') +
    '</p></div>' + (attention ? '<button class="btn small" id="review-attention-rides">Review rides</button>' : '') + '</article>' +
    '<article class="dispatch-brief-card"><span class="dispatch-brief-icon" aria-hidden="true">' + icon('clock') + '</span><div><small>NEXT PICKUP</small><strong>' + esc(nextTitle) + '</strong><p>' +
    esc(nextDetail) + '</p></div>' + (next ? '<button class="btn small" data-focus-ride="' + esc(next.id) +
    '">Open pickup</button>' : '') + '</article></section>';
}
const dutyLabels = { online:'Online', busy:'On ride', offline:'Offline' };
let dutyFilter = 'all';
let fleetSearch='',vehicleFocusId=null,followedVehicleId=null,lastFollowPosition='';
function dutyRoster(now = Date.now()) {
  const run = queueRun(fleetSource);
  return ProLiftBoard.fleet(state,now).filter(({driver}) =>
    run === undefined ? matchesFleetSource(driver) : (driver.demoRunId || null) === run);
}
function dutyLocation({driver,hasLocation,age}) {
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
  const freshness=hasLocation?' · '+(age<60000?Math.floor(age/1000)+' sec ago':Math.floor(age/60000)+' min ago'):'';
  const follow=followedVehicleId===driver.id&&vehicleCanFollow(item);
  return '<section class="fleet-inspector" aria-label="Selected vehicle"><div class="fleet-inspector-head"><div><small>SELECTED VEHICLE</small><h3>'+
    esc(driver.vehicle)+' · '+esc(driver.plate)+'</h3></div><button class="text-btn" id="clear-vehicle-focus" aria-label="Clear selected vehicle">×</button></div>'+
    '<p><strong>'+esc(driver.name)+'</strong> · '+esc(dutyLabels[driver.status]||driver.status)+'</p><p>'+esc(dutyLocation(item)+freshness)+
    (hasLocation?' · '+time(driver.lastLocationAt):'')+'</p>'+
    '<p>'+(activeRide?esc((trip?'Current ride ':'Offer pending ')+activeRide.reference):'No active ride')+'</p><div class="fleet-inspector-actions">'+
    (canLocate?'<button class="btn small" id="center-selected-vehicle">Center map</button>':'<small>Position unavailable in this map view.</small>')+
    (canLocate&&vehicleCanFollow(item)?'<button class="btn small" id="follow-selected-vehicle" aria-pressed="'+!!follow+'">'+(follow?'Stop following':'Follow vehicle')+'</button>':'')+
    (activeRide?'<button class="text-btn" data-focus-ride="'+esc(activeRide.id)+'">Open ride</button>':'')+
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
function chooseFleetVehicle(id,fromRoster=false) {
  stopVehicleFollow();
  focusedRideId=null;
  vehicleFocusId=selectedDriverId=id;
  render();
  centerFleetVehicle();
  if(fromRoster) $('.fleet-inspector')?.scrollIntoView({block:'nearest'});
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
      return '<li><button class="text-btn" data-vehicle-focus="' + esc(driver.id) + '" aria-pressed="'+(vehicleFocusId===driver.id)+'">' +
        esc(driver.vehicle) + ' · '+esc(driver.plate)+'<small>'+esc(driver.name)+'</small></button><span class="duty-pill duty-' + esc(driver.status) + '">' + esc(dutyLabels[driver.status] || driver.status) +
        '</span><small>' + esc(trip ? trip.reference + ' · ' + dutyLocation(item) : status==='offered' ?
          'Offer pending · ' + dutyLocation(item) : dutyLocation(item)) + '</small></li>';
    }).join('');
  return '<section id="driver-duty" class="driver-duty" aria-label="Driver duty status"><div class="driver-duty-heading"><div><h3>Vehicles and driver duty</h3>' +
    '<p>Search the fleet or select a vehicle to see its location and ride.</p></div>' +
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
  const pending=state.offers.some(o=>o.tripId===t.id&&o.status==='pending'&&o.expiresAt>now);
  const assignment = driver ? status + ': ' + driver.name : pending ? ProLiftBoard.dispatchLabel(state,t,now).label : issue || (opens>now ?
    'Scheduled · offers open ' + date(opens) + ' ' + time(opens) : ProLiftBoard.dispatchLabel(state,t,now).label);
  const lastFailure=state.offers.findLast(o=>o.tripId===t.id&&['declined','expired'].includes(o.status));
  const attempt=lastFailure?(state.drivers.find(d=>d.id===lastFailure.driverId)?.name||'Previous driver')+
    (lastFailure.status==='declined'?' declined':' did not respond in 45 seconds'):'';
  const canAssign = !t.driverId && opens<=now && ['awaiting_driver','needs_reassignment','offered'].includes(t.status);
  return '<article class="dispatch-ride-wrap"><button class="dispatch-row ' + (t.id === focusedRideId ? 'selected' : '') +
    '" data-focus-ride="' + esc(t.id) + '"><div><span class="dispatch-dot ' + kind + '"></span><strong>' + esc(t.reference) +
    '</strong><span>' + esc(date(t.pickupAt) + ' · ' + time(t.pickupAt)) + '</span></div><p>' + esc(t.pickup) +
    '</p><small>→ ' + esc(t.destination) + '</small>' + (driver&&issue?'<small class="dispatch-last-attempt">'+esc(issue)+'</small>':'')+
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
  return '<section class="dispatch-completion"><div>' + icon('check') + '<strong>Last completed</strong></div><p>' +
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
function overview() {
  const now = Date.now();
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
  const planningOpen=$('#dispatch-planning')?.open;
  return '<div class="dispatch-command fleet-theme-' + identity.theme + '"><section class="dispatch-toolbar"><div class="dispatch-title"><span class="eyebrow">OWNER WORKSPACE</span><div><h1>Dispatch</h1>' + dispatchIndicator() +
    '</div></div><button class="btn primary" id="add-planned-ride">'+icon('plus')+' New booking</button></section>' +
    '<div class="dispatch-rail"><nav class="dispatch-jump" aria-label="On this page"><a href="#ride-queue">'+icon('car')+'Ride queue</a><a href="#fleet-map">'+icon('map')+'Fleet map</a><a href="#driver-duty">'+icon('users')+'Driver duty</a><a href="#dispatch-planning" id="open-dispatch-planning">'+icon('clock')+'Plan &amp; records</a></nav>'+
    dispatchFleetPicker() + '</div></div>' +
    (!['device','sample'].includes(fleetSource)?'<aside class="queue-test-notice"><p><strong>Test data</strong> · '+esc(identity.label)+' is selected.'+
      (fleetSource==='queue-review'?' Starts with 50 Now, 50 Later and 50 Attention.':'')+'</p>'+
      (fleetSource==='queue-review'?'<button class="btn small" data-queue-review="restart">Start fresh test</button>':'')+
      '<button class="btn small" data-dispatch-fleet="device">Back to Ordinary fleet</button></aside>':'')+
    dispatchBrief(lists, now) + '<div class="dispatch-workspace"><section id="fleet-map" class="dispatch-map fleet-map-panel">' +
    '<div class="dispatch-map-title"><div><h2>Fleet map</h2><small>' + esc(identity.detail) + '</small></div>' + fleetBadge(identity) + '</div>' +
    selectedVehiclePanel() + liveFleetMap(fleet,null) + dispatchFleetStatus() + '</section>' +
    '<aside id="ride-queue" class="dispatch-queue fleet-theme-' + identity.theme + '"><header><div><h2 tabindex="-1">Ride queue</h2>' + fleetBadge(identity) +
    '</div><div class="queue-header-actions"><strong>' + (dispatchSearch?queueTotal(visible)+' of ':'') + total + ' open</strong></div></header>'+
    '<form id="dispatch-search" class="dispatch-search"><input name="query" type="search" maxlength="120" aria-label="Find open rides" placeholder="Ride, rider, driver or stop" value="'+esc(dispatchSearch)+'"><button class="btn small">Find</button>'+
    (dispatchSearch?'<button class="text-btn" type="button" id="clear-dispatch-search">Clear</button>':'')+'</form><div class="dispatch-tabs">' + tabs +
    '</div>' + (selected?selectedDispatchRide(selected,now):'') + '<div class="dispatch-queue-rows">' + list + '</div>' + paging + latestCompletion() + '</aside></div>'+
    '<details class="dispatch-records" id="dispatch-planning" '+(planningOpen?'open':'')+'><summary>Plan &amp; records</summary><div class="dispatch-record-actions">'+
    '<button class="btn" data-go="imports">Import LGTC or Excel</button><button class="btn" id="design-vehicle-plan">Plan bookings</button><button class="btn" data-driver-day="">Driver day</button>'+
    '<button class="btn" id="queue-bookings">All bookings</button><button class="btn" data-go="schedule">Upcoming schedule</button>'+
    (config.mode==='pilot'?'':'<button class="btn" data-queue-review="open">Open test queues</button>')+lgtcHandoff()+'</div></details>';
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
function liveFleetMap(items,selected){return '<div class="geo-map-wrap">'+mapPriorityLegend()+'<div id="geo-fleet-map" role="region" aria-label="Geographic fleet map"></div><div class="geo-map-actions"><button class="btn small" id="fit-geo-fleet">Show vehicles</button><button class="btn small" id="fit-priority-map">Show priority rides</button><span>'+ (fleetSource==='scenario'?'4 TEST CARS':fleetSource==='device'?'PHONE GPS':fleetSource==='replay'?'DUMMY COORDINATES':'SAMPLE POSITIONS')+'</span></div>'+(!items.some(i=>i.hasLocation)?(fleetSource==='device'?'<div class="geo-empty"><strong>No phone locations yet</strong><span>Drivers can share their location from My work.</span></div>':'<div class="geo-empty"><strong>No vehicle positions for this fleet</strong></div>'):'')+'<div id="geo-map-status" role="status"></div></div>';}
function bookingScopeOptions() {
  const scopes = [['all', 'All records'], ['live', 'Ordinary bookings']];
  for (const [source, label, run] of testQueueOptions()) scopes.push([run, source === 'volume' ? '500-trip test dataset' : label]);
  if (!scopes.some(([key]) => key === tripDataScope)) scopes.push([tripDataScope, 'Previous test']);
  return scopes.map(([key, label]) => '<option value="' + esc(key) + '" ' + (tripDataScope === key ? 'selected' : '') + '>' + label + '</option>').join('');
}
function tripsPage(){
 const view=ProLiftBoard.select(state.trips,{scope:tripDataScope,filter,search,page:boardPage,drivers:state.drivers,order:bookingOrder,leadMinutes:dispatchLead()});boardPage=view.page;
 return '<section class="simple-page-head"><div><h1>Bookings</h1><p>'+view.counts.all+' records · '+view.counts.attention+' need attention</p></div><div><button class="btn" data-go="schedule">Upcoming</button><button class="btn" data-go="imports">Import file</button><button class="btn primary" id="add-planned-ride">New booking</button></div></section>'+lgtcHandoff()+'<section class="bookings-panel"><div class="bookings-filters"><label class="search">'+icon('search')+'<input id="trip-search" type="search" placeholder="Customer, mobile or booking" aria-label="Search trips" value="'+esc(search)+'"></label><select id="booking-order" aria-label="Pickup order">' + [['next','Next pickup first'],['latest','Latest pickup first'],['past','Past trips only']].map(([key,label]) => '<option value="'+key+'" '+(bookingOrder===key?'selected':'')+'>'+label+'</option>').join('') + '</select><select id="booking-status" aria-label="Booking status">'+[['all','All statuses'],['waiting','Waiting'],['offered','Offer sent'],['assigned','Assigned'],['attention','Needs attention'],['completed','Completed'],['cancelled','Cancelled']].map(([key,label])=>'<option value="'+key+'" '+(filter===key?'selected':'')+'>'+label+'</option>').join('')+'</select><select id="trip-data-scope" aria-label="Booking records">'+bookingScopeOptions()+'</select></div><div id="trip-results">'+simpleTripTable(view.rows)+'</div><div class="pagination"><span>'+view.start+'–'+view.end+' of '+view.total+'</span><button class="btn small" data-board-page="'+(view.page-1)+'" '+(view.page<=1?'disabled':'')+'>Previous</button><small>'+view.page+' / '+view.pages+'</small><button class="btn small" data-board-page="'+(view.page+1)+'" '+(view.page>=view.pages?'disabled':'')+'>Next</button></div></section>';
}
function simpleTripTable(trips) {
  if (!trips.length) return '<div class="empty"><h3>No trips in this group</h3><p>Choose another group or import your planned rides.</p></div>';
  return '<div class="table-scroll"><table class="simple-trips"><thead><tr><th>Pickup time</th><th>Trip / customer</th><th>Journey</th><th>Driver</th><th>Status</th><th></th></tr></thead><tbody>' + trips.map(t => {
    const g = ProLiftBoard.group(t,Date.now(),dispatchLead()), pending = state.offers.find(o => o.tripId === t.id && o.status === 'pending' && o.expiresAt > Date.now());
    const d = state.drivers.find(d => d.id === (t.driverId || pending?.driverId));
    const driverLabel = d ? esc(d.name) : '—';
    const status = { waiting:'Waiting',offered:'Waiting for driver',assigned:'Assigned',attention:'Needs attention',completed:'Completed',cancelled:'Cancelled' }[g];
    const note = ProLiftBoard.attentionReason(t,Date.now(),dispatchLead()) || ProLiftRideExplanation.explain(state,t,user.role).meaning;
    return '<tr class="' + (g === 'attention' ? 'flagged-row' : '') + '"><td><strong>' + time(t.pickupAt) + '</strong><small>' + date(t.pickupAt) + '</small></td><td><button class="text-btn trip-ref" data-detail="' + t.id + '">' + esc(t.reference) + '</button><small>' + esc(t.customerName) +(t.poolParentId?' · Shared booking':'')+(t.preferredDriver?' · Regular: '+esc(t.preferredDriver.name):'')+'</small>'+(t.demoRunId?fleetBadge(fleetIdentity(sourceForTrip(t)||'unknown')):'')+'</td><td>' + esc(t.pickup) + '<small>→ ' + esc(t.destination) + '</small></td><td><strong>' + driverLabel + '</strong></td><td><span class="badge ' + (g === 'attention' ? 'danger' : g === 'assigned' ? 'completed' : g) + '">' + status + '</span><small>' + note + '</small></td><td><button class="btn small" data-detail="' + t.id + '">' + (g === 'attention' ? 'Review' : 'View') + '</button></td></tr>';
  }).join('') + '</tbody></table></div>';
}
function importsPage() {
  if (config.publicDemo) return heading('PLANNED RIDES', 'Try the sample rides.', 'The public demo uses built-in test data. File uploads are available in the local demo.');
  return heading('BOOKINGS', 'Import trips', 'Open an LGTC schedule for planning, or import bookings using the ProLift template.', '<a class="btn" href="/api/template">Download Excel template</a>') +
    `<div class="import-grid"><section class="panel upload-panel"><span class="upload-symbol">${icon('upload')}</span><h2>Upload a trip file</h2><p>LGTC CSV or ProLift Excel/CSV · Up to 1,000 trips · Maximum 5 MB</p><label class="file-label">Choose file<input id="import-file" type="file" accept=".xlsx,.csv"></label><p class="help">Upload the LGTC export as received. The local planning copy keeps references, times and stop cities. Keep the original for rider details and instructions.</p><div id="upload-progress" aria-live="polite"></div></section><section class="panel" id="lgtc-history"><h2>Saved LGTC schedules</h2>${lgtcHistoryView()}</section></div>${batch?.kind === 'lgtc' ? lgtcPreview() : batch ? previewImport() : ''}${state.imports.length ? '<section class="panel"><details><summary>Recent ProLift template imports</summary>' + state.imports.slice(0,5).map(i=>'<div class="activity-row"><strong>'+i.count+' trip rows · '+esc(date(i.at))+'</strong>'+badge(i.confirmed?'imported':'preview')+'</div>').join('')+'</details></section>' : ''}`;
}
function previewImport() {
  const invalid = batch.rows.filter(r => r.errors.length).length;
  return `<section class="panel"><div class="panel-heading"><div><h2>Review your import</h2><p>${batch.rows.length} rows · ${invalid} with errors. ${batch.confirmed ? 'Already imported.' : 'All rows must be valid. Automatic dispatch uses your configured pickup window.'}</p></div><button class="btn primary" id="confirm-import" ${invalid || batch.confirmed ? 'disabled' : ''}>${icon('check')} ${batch.confirmed ? 'Imported' : 'Confirm import'}</button></div><div class="table-scroll"><table><thead><tr><th>Row</th><th>Trip</th><th>Customer</th><th>Pickup</th><th>Validation</th></tr></thead><tbody>${batch.rows.map(r => `<tr><td>${r.row}</td><td>${esc(r.trip_id)}</td><td>${esc(r.customer_name)}</td><td>${esc(r.pickup)}<small>${esc(r.pickup_at)}</small></td><td>${r.errors.length ? `<span class="validation-error">${r.errors.map(esc).join('<br>')}</span>` : badge('valid')}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function fleetPage() { return heading('LIVE OPERATIONS', 'Stay close to your fleet.', 'Location freshness and driver status, updated over a live connection.') + `<div class="overview-grid fleet-large"><section class="panel">${mapView()}</section><section class="panel"><div class="panel-heading"><h2>Working drivers</h2></div><div class="driver-list">${driverRows()}</div></section></div><div class="notice">${icon('map')} This is a schematic with simulated GPS. Real Google maps and phone GPS are separate production integrations.</div>`; }
function driversPage() { return heading('YOUR TEAM', 'The people behind every pickup.', 'Availability, vehicles, and current work in one place.') + `<div class="driver-cards">${state.drivers.map(d => { const t = state.trips.find(t => !t.poolParentId && t.driverId === d.id && active(t)); return `<article class="panel driver-card"><div class="driver-card-top"><span class="avatar large">${esc(d.name.split(' ').map(x => x[0]).join(''))}</span>${badge(d.status)}</div><h2>${esc(d.name)}</h2><p>${esc(d.vehicle)} · ${esc(d.plate)}</p><div class="specs"><span>${d.seats} passenger seats</span><button class="btn small" data-capacity="${d.id}">Set 4 / 7 seats</button><span>${d.capabilities.length ? 'Wheelchair accessible' : 'Standard vehicle'}</span></div><div class="driver-assignment">${t ? `<small>CURRENT TRIP</small><button class="text-btn" data-detail="${t.id}">${esc(t.reference)} ${icon('arrow')}</button><p>${esc(t.pickup)}</p>` : '<small>NO ACTIVE TRIP</small><p>Ready for the next assignment.</p>'}</div><small class="muted">Last location ${Number.isFinite(d.lastLocationAt) ? time(d.lastLocationAt) : "unavailable"}</small><button class="btn small" data-driver-day="${esc(d.id)}">Driver day</button></article>`; }).join('')}</div>`; }
function activityPage() { return heading('ACCOUNTABILITY', 'Every update has a history.', 'Assignments, driver drops, trip updates, and import activity.') + `<section class="panel">${state.events.length ? state.events.slice(0, 100).map(e => `<div class="activity-row">${icon(e.type.includes('reassignment') ? 'flag' : 'clock')}<div><strong>${esc(e.type.replace(/[._]/g, ' '))}</strong><span>${esc(e.reference || '')} · ${esc(e.actor)}</span><small>${esc(e.detail)}</small></div><time>${date(e.at)} · ${time(e.at)}</time></div>`).join('') : '<div class="empty"><p>Activity appears as your team works.</p></div>'}</section>`; }
function tripCard(t) {
  const driver = state.drivers.find(d => d.id === t.driverId) || (t.status==='completed'?t.confirmedDriver:null), offer = state.offers.find(o => o.tripId === t.id && o.status === 'pending' && o.expiresAt > Date.now());
  return `<article class="panel trip-card ${t.redFlag ? 'flagged-card' : ''}"><div class="trip-card-head"><strong>${esc(t.reference)}</strong>${badge(t.status, t.redFlag)}</div><div class="trip-card-time"><strong>${time(t.pickupAt)}</strong><span>${date(t.pickupAt)} · ${t.passengers} passenger${t.passengers > 1 ? 's' : ''}</span></div><div class="journey"><div><span class="journey-dot"></span><small>PICKUP</small><strong>${esc(t.pickup)}</strong></div><div><span class="journey-dot end"></span><small>DESTINATION</small><strong>${esc(t.destination)}</strong></div></div>${t.isSharedRun?'<section class="shared-run-preview notice"><strong>Shared run · '+t.passengers+' passengers · '+(t.collectedStops||0)+' / '+t.sharedStops.length+' pickups collected</strong><ol>'+t.sharedStops.map((x,i)=>'<li>'+time(x.plannedAt)+' · '+esc(x.pickup)+' · '+x.passengers+' passenger(s)'+(i<(t.collectedStops||0)?' · Onboard':i===(t.collectedStops||0)?' · NEXT':'')+'</li>').join('')+'</ol></section>':''}${user.role === 'driver' ? `<div class="trip-customer">${icon('users')} ${esc(t.customerName)}${t.isSharedRun?' · Follow pickup order':' · '+esc(t.customerPhone)}</div>` : driver ? `<div class="trip-customer">${icon('car')} ${esc(driver.name)} · ${esc(driver.vehicle)} · ${esc(driver.plate)}</div>` : '<p class="muted">Dispatch will confirm your driver.</p>'}${offer && user.role === 'driver' ? `<div class="offer-note"><span data-offer-countdown="${offer.expiresAt}">${Math.max(0,Math.ceil((offer.expiresAt-Date.now())/1000))} seconds to respond</span> · ${offer.etaSource==='road'?'Road':'Simulated'} pickup ETA ${offer.eta} min</div><div class="card-actions"><button class="btn primary" data-trip="${t.id}" data-action="accept" data-offer="${offer.id}">Accept trip</button><button class="btn" data-trip="${t.id}" data-action="decline" data-offer="${offer.id}">Decline</button></div>` : `${user.role==='customer'&&t.confirmedDriver&&active(t)?'<div class="confirmed-driver"><strong>Your confirmed driver: '+esc(t.confirmedDriver.name)+'</strong><span>'+esc(t.confirmedDriver.vehicle)+' · '+esc(t.confirmedDriver.plate)+'</span><span>Driver phone: '+esc(t.confirmedDriver.phone||'Contact dispatch')+'</span></div>':''}<div class="card-actions">${user.role === 'driver' ? driverButtons(t) : active(t) ? `<button class="btn primary" data-detail="${t.id}">${icon('map')} Track trip</button>${!t.poolParentId?`<button class="btn" data-trip="${t.id}" data-action="cancel">Cancel trip</button>`:''}` : t.status === 'completed' ? t.rating ? `<span class="rating">${'★'.repeat(t.rating)} · Your rating</span>` : `<button class="btn" data-rate="${t.id}">Rate your ride</button>` : ''}</div>`}${rideExplanation(t)}${rideExtras(t)}</article>`;
}
function driverButtons(t) { const next = { accepted: ['depart', 'Head to pickup'], heading_to_pickup: ['arrive', 'I have arrived'], arrived: ['pickup', 'Passenger onboard'], onboard: ['complete', 'Complete trip'] }[t.status]; return next ? `<button class="btn primary" data-trip="${t.id}" data-action="${next[0]}">${icon('check')} ${t.isSharedRun&&next[0]==='pickup'?'Confirm this pickup · '+((t.collectedStops||0)+1)+' / '+t.sharedStops.length:next[1]}</button>${['accepted', 'heading_to_pickup', 'arrived'].includes(t.status)&&!(t.collectedStops>0) ? `<button class="btn danger-text" data-release="${t.id}">Drop trip</button>` : ''}<button class="btn" data-detail="${t.id}">Details</button>` : ''; }
function driverPage() {
  const d = state.drivers.find(d => d.id === user.driverId), trips = state.trips.filter(t=>active(t)&&(t.driverId===user.driverId||state.offers.some(o=>o.tripId===t.id&&o.status==='pending')));
  return heading('DRIVER WORKSPACE', `Let’s get moving, ${esc(user.name.split(' ')[0])}.`, 'Accept an offer, follow your pickup, and keep dispatch updated.', `<button class="btn ${d.status === 'online' ? 'primary' : ''}" id="toggle-status" ${d.status === 'busy' ? 'disabled' : ''}>${icon('bolt')} ${d.status === 'offline' ? 'Go online' : d.status === 'busy' ? 'On a trip' : 'Online · go offline'}</button>`) + '<section class="mobile-status panel"><span class="status-orb '+d.status+'">'+icon('car')+'</span><div><strong>'+(d.status==='busy'?'You have an active ride':d.status==='online'?'You’re available':'You’re offline')+'</strong><p>'+(d.status==='busy'?'Follow the next step on your ride card.':d.status==='online'?'Eligible pickup offers appear here automatically.':'Go online when you’re ready for pickups.')+'</p></div></section>' + (d.status==='busy'?`<section class="panel last-ride"><strong>${d.finishThenOffline?'You will go offline after this ride.':'Keep receiving rides after this trip?'}</strong><button class="btn" id="last-ride">${d.finishThenOffline?'Keep accepting rides':'Go offline after this ride'}</button></section>`:'') + `${phoneTrackingPanel(d)}<div class="trip-card-grid">${trips.length ? trips.map(tripCard).join('') : `<section class="panel empty">${icon('car')}<h2>${d.status === 'offline' ? 'You’re offline.' : 'Ready for the next trip.'}</h2><p>${d.status === 'offline' ? 'Go online to receive offers.' : 'New offers will appear here automatically.'}</p></section>`}</div>`;
}
var selectedCustomerTrip=null;
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
  return heading('YOUR JOURNEY',complete?'Ride completed':'Ride cancelled',complete?'Your driver marked the drop-off complete.':'This booking is closed.')+
   '<div class="trip-card-grid">'+tripCard(viewed)+'</div><div class="card-actions">'+
   (trips.length?'<button class="btn primary" id="next-customer-ride">View upcoming ride</button>':'<button class="btn primary" id="book-trip">Plan a trip</button>')+
   '<button class="btn" data-go="history">Trip history</button></div>';
 }
 const t=viewed||trips[0];
 if(!t)return '<section class="rider-welcome"><span class="eyebrow">PROLIFT RIDES</span><h1>Your next journey starts here.</h1><p>Book a pickup and follow every step in one place.</p><button class="btn primary" id="book-trip">Plan a trip</button>'+(state.trips.length?' <button class="btn" data-go="history">Trip history</button>':'')+'</section>';
 selectedCustomerTrip=t.id;
 const d=state.drivers.find(d=>d.id===t.driverId),j=ProLiftRider.journey(t,d),identity=t.confirmedDriver;
 return '<section class="rider-journey"><header class="rider-header"><div><span class="eyebrow">YOUR JOURNEY</span><h1>'+esc(j.title)+'</h1><p>'+esc(j.description)+'</p></div></header>'+
 (trips.length>1?'<label class="rider-switch">Viewing ride<select id="customer-ride-choice">'+trips.map(x=>'<option value="'+x.id+'" '+(x.id===t.id?'selected':'')+'>'+esc(x.pickup)+' → '+esc(x.destination)+' · '+date(x.pickupAt)+'</option>').join('')+'</select></label>':'')+
 (j.late?'<div class="rider-warning"><strong>Your pickup time has passed</strong><span>Please check with your driver or send a help request. The app has no verified new arrival time.</span></div>':'')+
 '<div class="rider-layout">'+customerTracking(t,d,j)+'<section class="rider-sheet"><div class="rider-time"><span>Pickup '+date(t.pickupAt)+'</span><strong>'+time(t.pickupAt)+'</strong><span>'+esc(t.reference)+'</span></div><div class="rider-stops"><div><i></i><span>MEET HERE<strong>'+esc(t.pickup)+'</strong></span></div><div><i></i><span>GOING TO<strong>'+esc(t.destination)+'</strong></span></div></div><ol class="rider-steps">'+['Booked','Driver confirmed','At pickup','On your way'].map((label,i)=>'<li class="'+(i<=j.step?'reached':'')+'" '+(i===j.step?'aria-current="step"':'')+'><i>'+ (i<j.step?'✓':i+1)+'</i><span>'+label+'</span></li>').join('')+'</ol>'+
 (identity?'<div class="rider-identity"><span class="avatar large">'+esc(identity.name.split(' ').map(x=>x[0]).join('').slice(0,2))+'</span><div><strong>'+esc(identity.name)+'</strong><span>'+esc(identity.vehicle)+'</span><b>'+esc(identity.plate)+'</b></div></div>':'<div class="rider-unassigned">Driver and car details will appear here after acceptance.</div>')+
 rideExplanation(t)+'<div class="rider-main-action">'+(identity?.phone?'<a class="btn primary" href="tel:'+esc(identity.phone)+'">'+icon('users')+' Call driver</a>':'<button class="btn primary" data-help-trip="'+t.id+'">Ask about my pickup</button>')+'</div><div class="rider-secondary"><button class="text-btn" data-help-trip="'+t.id+'">Get help</button><button class="text-btn" data-go="messages">Ride updates</button>'+(t.status!=='onboard'?'<button class="text-btn" data-trip="'+t.id+'" data-action="cancel">Cancel ride</button>':'')+'</div></section></div><button class="btn rider-book" id="book-trip">'+icon('plus')+' Book another ride</button></section>';
}
function historyPage() { const trips = state.trips.filter(t => !active(t)); return heading('TRIP RECORDS', 'Your journey history.', 'Completed and cancelled trips, with the details that matter.') + `<div class="trip-card-grid">${trips.length ? trips.map(tripCard).join('') : '<section class="panel empty"><h2>No past trips yet.</h2><p>Completed and cancelled trips appear here.</p></section>'}</div>`; }
function render() {
  if (!user || !state) return;
  const pages = {manage:managePage,"lgtc-settings":lgtcSettingsPage,customers:regularCustomersPage,readiness:readinessPage,scheduled:scheduledPage,help:helpPage, overview, reports:reportsPage, messages:messagesPage, settings:settingsPage, schedule: schedulePageView, trips: tripsPage, fleet: fleetPage, imports: importsPage, drivers: driversPage, activity: activityPage, work: driverPage, mytrips: customerPage, history: historyPage };
  shell((pages[tab] || overview)());
  updateConnection();
}
function modal(content) { const el = $('#modal'); el.innerHTML = `<div class="modal-top"><span class="eyebrow">PROLIFT</span><button class="icon-btn" id="close-modal" aria-label="Close dialog">×</button></div>${content}`; el.showModal(); $('#close-modal').onclick = () => { el.close(); render(); }; el.oncancel = () => setTimeout(() => { if (!el.open) render(); }); }
function tripDetail(id) {
  const t = state.trips.find(t => t.id === id), driver = state.drivers.find(d => d.id === t.driverId);
  modal(`<h2>${esc(t.reference)}</h2><p>${esc(t.customerName)} · ${date(t.pickupAt)} at ${time(t.pickupAt)}</p>${badge(t.status, t.redFlag)}${rideExplanation(t)}<div class="detail-route">${esc(t.pickup)} ${icon('arrow')} ${esc(t.destination)}</div>${t.isSharedRun?'<section class="notice"><strong>Shared pickup order · '+t.passengers+' passengers total</strong><ol>'+t.sharedStops.map((x,i)=>'<li>'+esc(x.reference)+' · '+esc(x.pickup)+' · '+x.passengers+' passenger(s) · '+(i<(t.collectedStops||0)?'Onboard':i===(t.collectedStops||0)?'Next pickup':'Waiting')+'</li>').join('')+'</ol></section>':''}${tripFacts(t,driver)}${mapView(driver ? [driver] : [], t)}<p>${driver ? `<strong>${esc(driver.name)}</strong> · ${esc(driver.vehicle)} · ${esc(driver.plate)}<br><small>Location updated ${time(driver.lastLocationAt)} · ${driver.locationSource==='device'?'Phone GPS':'Simulated GPS'}</small>` : 'No driver assigned yet.'}</p>${t.dispatchError ? `<p class="validation-error">${esc(t.dispatchError)}</p>` : ''}<h3>Trip timeline</h3><div class="timeline">${state.events.filter(e => e.tripId === t.id).slice(0, 10).map(e => `<div><strong>${esc(e.type.replace(/[._]/g, ' '))}</strong><small>${time(e.at)} · ${esc(e.actor)} · ${esc(e.detail)}</small></div>`).join('') || '<p class="muted">Awaiting first update.</p>'}</div>${user.role === 'owner' && active(t) && t.status !== 'onboard' && !t.poolParentId && !(t.collectedStops>0) ? `<button class="btn danger-text" id="detail-cancel">Cancel trip</button>` : ''}`);
  $('#modal h2').dataset.tripDetailId = id;
  if (user.role === 'owner' && tab !== 'overview' && canShowInDispatch(t)) {
    const button = document.createElement('button');
    button.className = 'btn primary'; button.textContent = 'Show in Dispatch';
    button.onclick = () => focusDispatchRide(t.id); $('#modal').append(button);
  }
  if(user.role==='owner'&&t.poolParentId){const b=document.createElement('button');b.className='btn primary';b.textContent='Open shared car run';b.onclick=()=>tripDetail(t.poolParentId);$('#modal').append(b);}
  if(user.role==='owner'&&t.isSharedRun&&!t.driverId){const b=document.createElement('button');b.className='btn';b.textContent='Split back into separate bookings';b.onclick=()=>run(()=>sendAction(t.id,'unpool'));$('#modal').append(b);}
  if(user.role==='owner'){const button=document.createElement('button');button.className='btn';button.textContent='Review driver selection';button.onclick=()=>reviewDispatch(id);$('#modal').append(button);}
  if(user.role==='owner'&&['awaiting_driver','needs_reassignment','offered'].includes(t.status)){const b=document.createElement('button');b.className='btn primary';b.textContent='Choose driver';b.onclick=()=>run(()=>chooseDriver(id));$('#modal').append(b);}
  if(user.role==='owner'&&canReplaceConfirmed(t)){const b=document.createElement('button');b.className='btn danger-text';b.textContent='Replace driver';b.onclick=()=>replaceConfirmed(t.id);$('#modal').append(b);}
  if(user.role==='owner'&&!t.isSharedRun){const b=document.createElement('button');b.className='btn';b.textContent=t.preferredDriver?'Regular driver: '+t.preferredDriver.name:'Set regular driver';b.onclick=()=>regularDriverModal(t.id);$('#modal').append(b);}
  if ($('#detail-cancel')) $('#detail-cancel').onclick = () => confirmAction(t.id, 'cancel');
  if (user.role === 'owner' && ['awaiting_driver', 'needs_reassignment'].includes(t.status)) {
    const button = document.createElement('button'); button.className = 'btn'; button.textContent = 'Retry driver search';
    button.onclick = () => run(() => sendAction(t.id, 'retry')); $('#modal').append(button);
  }
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
  await api(`/api/trips/${id}/action`, { action, ...extra }, crypto.randomUUID());
  if ($('#modal')?.open) $('#modal').close();
  await refresh(); toast(action === 'offer' ? 'Offer sent. Waiting for the driver to accept.' : action === 'release' ? 'Trip reopened with a red flag. Replacement dispatch will retry automatically.' : 'Trip updated.');
}
function confirmRideComplete(id) {
  const trip = state.trips.find(t=>t.id===id);
  if (user.role !== 'driver' || !trip || trip.driverId !== user.driverId || trip.status !== 'onboard') return;
  const key = crypto.randomUUID();
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
function settingsPage(){
  const s=state.settings||{};
  return heading('OPERATIONS SETTINGS','Set the pickup timing.','These settings apply to automatic assignment and one-time customer reminders.')+
    '<section class="panel settings-panel"><form id="operations-settings"><h2>Automatic driver offers</h2><p>Start looking for the nearest eligible driver this many minutes before pickup.</p><div class="timing-presets"><button type="button" class="btn" data-timing="10" data-timing-field="dispatch-lead">10 minutes</button><button type="button" class="btn" data-timing="15" data-timing-field="dispatch-lead">15 minutes</button></div><label>Driver-offer lead time (minutes)<input id="dispatch-lead" type="number" min="1" max="180" step="1" required value="'+(s.dispatchLeadMinutes||15)+'"></label><h2>Urgent pickup recovery</h2><p>After a declined or expired offer, alert a small group when pickup is close. The first acceptance wins.</p><label class="checkbox-label"><input id="urgent-enabled" type="checkbox" '+(s.urgentGroupEnabled?'checked':'')+'> Enable urgent group offers</label><label>Urgent window (minutes before pickup)<input id="urgent-minutes" type="number" min="1" max="30" required value="'+(s.urgentGroupMinutes||5)+'"></label><label>Drivers per group<select id="urgent-size"><option value="2" '+(s.urgentGroupSize===2?'selected':'')+'>2 drivers</option><option value="3" '+(s.urgentGroupSize!==2?'selected':'')+'>3 drivers</option></select></label><h2>Customer pickup reminder</h2><p>Send once before pickup, after a driver has confirmed. If confirmation happens inside this window, the confirmation message covers the reminder.</p><label class="checkbox-label"><input id="reminders-enabled" type="checkbox" '+(s.customerRemindersEnabled?'checked':'')+'> Enable customer pickup reminders</label><div class="timing-presets"><button type="button" class="btn" data-timing="10" data-timing-field="reminder-lead">10 minutes</button><button type="button" class="btn" data-timing="15" data-timing-field="reminder-lead">15 minutes</button></div><label>Customer reminder lead time (minutes)<input id="reminder-lead" type="number" min="1" max="180" step="1" required value="'+(s.customerReminderMinutes||10)+'"></label><h2>Confirmation message</h2><p>Queued immediately when the driver accepts. Includes pickup time, driver name and phone, car model, plate and destination.</p><label>Company name<input id="company-name" required maxlength="80" value="'+esc(s.companyName||'ProLift')+'"></label><label>Message timezone<input id="message-timezone" required value="'+esc(s.timezone||'America/New_York')+'"></label><div class="notice">'+icon('bell')+' Demo delivery: messages are saved in Messages and the customer app. No SMS leaves this computer.</div><button class="btn primary" type="submit">Save settings</button></form></section>';
}
function messagesPage(){
  const messages=(state.customerMessages||[]).slice(0,100);
  return heading(user.role==='owner'?'CUSTOMER COMMUNICATION':'RIDE UPDATES',user.role==='owner'?'Customer message outbox.':'Your ride updates.','Confirmation, pickup reminders, and assignment changes.')+
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
  return heading('FLEET REPORTING','Driver and car reports.','Counts come from recorded offers and assignment history. No estimated revenue or distance is added.')+
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
  const now=Date.now();
  const view=ProLiftBoard.schedule(state.trips,{now,period:schedulePeriod,search:scheduleSearch,page:schedulePage});
  schedulePage=view.page;
  return heading('DISPATCH SCHEDULE','Pickup schedule','Current rides, overdue pickups, and upcoming bookings.',
    '<button class="btn" id="design-vehicle-plan">Design car schedule</button><button class="btn" data-go="imports">'+icon('upload')+' Import file</button><button class="btn primary" id="add-planned-ride">'+icon('plus')+' Add planned ride</button>')+
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
function helpPage(){return heading('TRIP SUPPORT','Help requests','Send a request from the ride card. Replies from your fleet owner appear here.')+'<div class="notice">Local demo inbox. Requests are saved for the owner; this is not a staffed emergency service.</div><div class="trip-card-grid">'+((state.supportRequests||[]).length?(state.supportRequests||[]).map(r=>'<article class="panel trip-card"><div class="trip-card-head"><strong>'+esc(r.reference)+'</strong>'+badge(r.status)+'</div><h2>'+esc(r.category.replaceAll('_',' '))+'</h2><p>'+esc(r.details)+'</p><small>'+date(r.createdAt)+' · '+time(r.createdAt)+'</small>'+(r.ownerReply?'<p><strong>Owner reply:</strong> '+esc(r.ownerReply)+'</p>':'')+(user.role==='owner'?'<button class="btn" data-help-review="'+r.id+'">Review request</button>':'')+'</article>').join(''):'<section class="panel empty"><h2>No help requests.</h2><p>Use Get trip help on a ride to start a request.</p></section>')+'</div>';}
setInterval(()=>document.querySelectorAll('[data-offer-countdown]').forEach(el=>{const seconds=Math.max(0,Math.ceil((Number(el.dataset.offerCountdown)-Date.now())/1000));el.textContent=seconds?seconds+' seconds to respond':'Offer expired — waiting for dispatch';}),1000);
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
 return heading('DISPATCH READINESS','Know what needs you.','Review late pickups, driver replies and future work in one place.','<button class="btn" id="refresh-readiness">Refresh</button><button class="btn primary" data-go="schedule">Plan pickups</button>')+
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
          const reading={id:crypto.randomUUID(),latitude:position.coords.latitude,longitude:position.coords.longitude,
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
function bindGeographicMap(){
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
 const items=ProLiftBoard.fleet(state).filter(i=>matchesFleetSource(i.driver)&&(fleetFilter==='all'||i.status===fleetFilter)&&(tab!=='overview'||fleetRowMatches(i))),located=items.filter(i=>i.hasLocation);
 let initial=false;
 if(!geoMap){initial=true;geoMap=fleetMapProvider().map(node,{zoomControl:true,scrollWheelZoom:true,zoomAnimation:false}).setView(config.map?.center||[35.2271,-80.8431],config.map?.zoom||13);geoMarkers=fleetMapProvider().layerGroup().addTo(geoMap);geoPriorityLayer=fleetMapProvider().layerGroup().addTo(geoMap);geoFocusedRoute=null;geoScenarioRoutes=fleetMapProvider().layerGroup().addTo(geoMap);geoTrail=fleetMapProvider().polyline([],{color:'#285fda',weight:4}).addTo(geoMap);if (!googleFleetProvider) L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'}).on('tileerror',()=>{const el=$('#geo-map-status');if(el)el.textContent='Street tiles could not load. Vehicle coordinates are still available.';}).addTo(geoMap);geoMap.on('dragstart zoomstart',()=>{mapInteracting=true;});geoMap.on('moveend zoomend',()=>{mapInteracting=false;});geoMap.on('dragstart',stopVehicleFollow);}
 geoMarkers.clearLayers();const colors={available:'#159a73',onride:'#2865e1',offered:'#c48a1a',offline:'#8290a6',stale:'#c0545b'};
 for(const item of located){const d=item.driver,stopped=d.locationSource==='device'&&d.trackingEnabled===false,age=Math.max(0,Math.floor((Date.now()-d.lastLocationAt)/1000)),label=d.locationSource==='device'?(stopped?'Sharing stopped':age>120?'Location stale':'Phone GPS'):d.locationSource==='replay'?'TEST · dummy coordinates':d.locationSource==='scenario'?'CHARLOTTE FLEET TEST':'SAMPLE';
  const priorityRide=item.trip||state.trips.find(t=>t.id===item.offer?.tripId),carPriority=priorityRide?ProLiftBoard.priority(priorityRide):'later';
  const carIcon=fleetMapProvider().divIcon({className:'fleet-car-marker fleet-theme-'+identity.theme+' priority-car-'+carPriority+' '+(stopped?'offline':item.status)+(selectedDriverId===d.id?' chosen':''),iconSize:[44,44],iconAnchor:[22,22],html:'<span class="fleet-car-disc"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 17H3v-7l3-6h12l3 6v7h-2M5 17h14M6 10h12M6 14h1m10 0h1M5 17v3m14-3v3"/></svg><span class="fleet-marker-code">'+identity.code+'</span></span>'});const marker=fleetMapProvider().marker([d.lat,d.lng],{icon:carIcon,title:d.name+' · '+identity.label+' · '+label,alt:d.name,keyboard:true,riseOnHover:true}).addTo(geoMarkers);
  marker.bindTooltip(d.locationSource==='replay'?'TEST CAR · dummy GPS':d.locationSource==='scenario'?esc(d.name)+' · '+({available:'Available',onride:'On ride',offered:'Offer pending',stale:'Location old',offline:'Offline'}[item.status]||item.status):esc(d.name)+' · '+label,{direction:'bottom',permanent:selectedDriverId===d.id,offset:[0,20],className:'fleet-car-label'});marker.bindPopup('<strong>'+esc(d.name)+'</strong><br>'+esc(d.vehicle)+' · '+esc(d.plate)+'<br>'+label+' · '+age+' seconds ago<br>'+d.lat.toFixed(5)+', '+d.lng.toFixed(5)+(Number.isFinite(d.locationAccuracy)?'<br>Accuracy '+Math.round(d.locationAccuracy)+' m':''));
  marker.on('click',()=>{if(tab==='overview'){chooseFleetVehicle(d.id);return;}if(item.trip){focusDispatchRide(item.trip.id);return;}if(item.offer){focusDispatchRide(item.offer.tripId);return;}modal('<h2>Driver details</h2>'+fleetDetails(item,{available:'Available',onride:'On ride',offered:'Awaiting reply',offline:'Offline',stale:'Location old'}));return;});
 }
 if(fleetSource==='replay'&&state.trackingReplay){geoTrail.setLatLngs(state.trackingReplay.trail.map(p=>[p.lat,p.lng]));}else geoTrail.setLatLngs([]);
 drawScenarioRoutes();drawPriorityMarkers();
 const fit=()=>{if(fleetSource==='scenario'&&state.fleetScenario){const points=located.map(i=>[i.driver.lat,i.driver.lng]);for(const t of scenarioTrips()){for(const name of [t.pickup,t.destination]){const p=config.places.find(p=>p.name===name);if(p)points.push([p.lat,p.lng]);}}if(points.length)geoMap.fitBounds(points,{padding:[65,65],maxZoom:15,animate:false});return;}if(fleetSource==='replay'&&state.trackingReplay){geoMap.fitBounds(state.trackingReplay.route.map(p=>[p.lat,p.lng]),{padding:[70,70],maxZoom:15,animate:false});return;}if(located.length)geoMap.fitBounds(located.map(i=>[i.driver.lat,i.driver.lng]),{padding:[45,45],maxZoom:15,animate:false});};
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
  document.querySelectorAll('[data-vehicle-focus]').forEach(b=>b.onclick=()=>chooseFleetVehicle(b.dataset.vehicleFocus,true));
  if($('#clear-vehicle-focus')) $('#clear-vehicle-focus').onclick=()=>{stopVehicleFollow();vehicleFocusId=selectedDriverId=null;render();};
  if($('#center-selected-vehicle')) $('#center-selected-vehicle').onclick=()=>centerFleetVehicle();
  if($('#follow-selected-vehicle')) $('#follow-selected-vehicle').onclick=()=>{
    if(followedVehicleId) stopVehicleFollow();
    else {followedVehicleId=vehicleFocusId;centerFleetVehicle();render();}
  };
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
  document.querySelectorAll('[data-capacity]').forEach(b=>b.onclick=()=>{const d=state.drivers.find(d=>d.id===b.dataset.capacity);modal('<h2>Vehicle passenger capacity</h2><p>'+esc(d.name)+' · '+esc(d.vehicle)+'. Seats exclude the driver. Only choose the actual passenger capacity.</p><label>Passenger seats<select id="car-capacity"><option value="4">4 seats</option><option value="7">7 seats</option></select></label><button class="btn primary" id="save-capacity">Save capacity</button>');$('#car-capacity').value=String(d.seats===7?7:4);$('#save-capacity').onclick=()=>run(async()=>{await api('/api/vehicle-capacity',{driverId:d.id,seats:+$('#car-capacity').value});$('#modal').close();await refresh();toast('Vehicle capacity updated.');});});
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
  if($('#selected-ride-map')) $('#selected-ride-map').onclick=fitFocusedRide;
  if($('#open-dispatch-planning')) $('#open-dispatch-planning').onclick=()=>{$('#dispatch-planning').open=true;};
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
  document.querySelectorAll('[data-go]').forEach(el => el.onclick = () => { const previous=tab;tab = el.dataset.go; render(); if(user.role==='owner'&&previous!==tab) window.scrollTo(0,0);if (tab === 'imports') loadLgtcHistory(); if (tab === 'lgtc-settings') run(loadLgtcSettings); });
  document.querySelectorAll('[data-detail]').forEach(el => el.onclick = () => tripDetail(el.dataset.detail));
  document.querySelectorAll('[data-action]').forEach(el => el.onclick = () => { if (el.disabled) return; confirmAction(el.dataset.trip, el.dataset.action, el.dataset.offer); });
  document.querySelectorAll('[data-filter]').forEach(el => el.onclick = () => { filter = el.dataset.filter; boardPage = 1; render(); });
  if ($('#trip-search')) $('#trip-search').oninput = e => { search = e.target.value; boardPage = 1; const position = e.target.selectionStart; render(); const input = $('#trip-search'); input.focus(); if (input.type === 'text') input.setSelectionRange(position, position); };
  if ($('#import-file')) $('#import-file').onchange = e => run(async () => {
    const file = e.target.files[0]; if (!file) return; if (file.size > 5 * 1024 * 1024) throw new Error('Maximum file size is 5 MB');
    $('#upload-progress').textContent = 'Reading and validating your spreadsheet…';
    const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
    try {
      batch = (await api('/api/import/preview', { filename: file.name, base64 })).batch;
      lgtcUpload = batch.kind === 'lgtc' ? { filename: file.name, base64 } : null;
      if (lgtcUpload) { lgtcSelect(batch.dates[0]); render(); $('#lgtc-review')?.scrollIntoView({block:'start'}); }
      else await refresh();
      toast('Preview ready. Review the rows before saving.');
    } catch (error) {
      if ($('#upload-progress')) $('#upload-progress').textContent = error.message;
      throw error;
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
  const bookingKey = crypto.randomUUID();
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
 const now=Date.now(), rides=queueFor(fleetSource,now).attention, pageSize=6;
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
  menu.querySelector('#quick-close').onclick=close;
  const refreshButton=menu.querySelector('#quick-refresh');
  if(refreshButton) refreshButton.onclick=()=>openQuickAssign(tripId,anchor,back);
  const backButton=menu.querySelector('#quick-back');
  if(backButton) backButton.onclick=()=>{close();back();};
  position();
 };
 menu.onclose=()=>menu.remove();
 menu.onclick=e=>{
  if(e.target!==menu) return;
  const r=menu.getBoundingClientRect();
  if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom) close();
 };
 menu.showModal();
 paint(header('Review pickup drivers')+'<p role="status">Checking live availability and pickup ETAs…</p>');
 try {
  const r=await api('/api/trips/'+tripId+'/dispatch-review');
  if(!menu.isConnected) return;
  const t=state.trips.find(ride=>ride.id===tripId);
  if(!t) throw Error('This ride is no longer available in the queue.');
  const [nearest,...others]=r.recoveryCandidates.filter(c=>c.eligible);
  const blocked={confirmed:'A driver already accepted this ride.',closed:'This ride is closed.',scheduled:'Driver offers open '+time(r.opensAt)+'.'}[r.phase];
  const pending=r.pending?'<p class="quick-recovery">Waiting for '+esc(r.pending.driverName||'a driver')+'. Sending a new offer replaces the current offer.</p>':'';
  const noCandidates='<p class="notice">No suitable driver can take this pickup right now.</p><div class="quick-unavailable">'+r.recoveryCandidates.slice(0,4).map(c=>'<p><strong>'+esc(c.name)+'</strong><small>'+esc(c.reasons.join(' · '))+'</small></p>').join('')+'</div>';
  const options=nearest?quickDriverCard(nearest,r.pickupAt,true)+
   (others.length?'<details class="quick-alternatives"><summary>2 · Compare other available drivers ('+others.length+')</summary>'+others.map(c=>quickDriverCard(c,r.pickupAt,false)).join('')+'</details>':'<p class="help">No other suitable drivers are available.</p>'):noCandidates;
  paint(header('Review pickup drivers',r.reference)+'<p class="quick-route"><strong>'+esc(t.pickup)+'</strong><br>Scheduled '+date(r.pickupAt)+' '+time(r.pickupAt)+' · '+t.passengers+' passenger(s)</p>'+
   (blocked?'<p class="notice">'+esc(blocked)+'</p>':pending+options+
   '<p class="help">'+(r.etaSource==='road'?'Road ETAs':'Simulated ETAs')+' checked at '+time(r.at)+'. The driver has 45 seconds to accept. A decline or timeout moves the offer to the next suitable available driver.</p>')+
   '<p id="quick-error" class="validation-error" role="alert"></p>'+footer);
  menu.querySelectorAll('[data-quick-driver]').forEach(button=>button.onclick=async()=>{
   menu.querySelectorAll('button').forEach(control=>control.disabled=true);
   try {
    await api('/api/trips/'+tripId+'/action',{action:'manual_offer',driverId:button.dataset.quickDriver,recovery:true,reason:'Owner reviewed availability'},crypto.randomUUID());
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
  if(menu.isConnected) paint(header('Could not load drivers')+'<p>'+esc(e.message)+'</p>'+footer);
 }
}

function dispatchIndicator() {
  const h=state.dispatchHealth, routing=h?.routing;
  let label = !connected ? (connectionMode==='checking'?'Dispatch status refreshing':'Dispatch connection interrupted') : h?.lastError ? 'Dispatch needs attention' : 'Demo dispatch';
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

function ownerShell(content,retainedMap){
 const dutyScroll = $('#driver-duty-roster')?.scrollTop || 0;
 const section=['overview','fleet'].includes(tab)?'overview':['trips','schedule','imports'].includes(tab)?'trips':'manage';
 const back=section==='manage'&&tab!=='manage'?'<button class="manage-back text-btn" data-go="manage">← Manage</button>':section==='trips'&&tab!=='trips'?'<button class="manage-back text-btn" data-go="trips">← Bookings</button>':'';
 $('#app').innerHTML='<a class="skip-link" href="#main-content">Skip to main content</a><div class="simple-owner role-owner"><header class="owner-header"><a href="/" class="brand" data-owner-nav="overview">'+icon('bolt')+' ProLift</a><nav aria-label="Main navigation">'+[['overview','Dispatch'],['manage','Manage']].map(([id,label])=>'<button data-owner-nav="'+id+'" class="'+(section===id||section==='trips'&&id==='overview'?'selected':'')+'" '+(section===id?'aria-current="page"':'')+'>'+label+'</button>').join('')+'</nav><div class="owner-account"><span class="owner-demo">'+(config.mode==='pilot'?'ROAD PILOT':'LOCAL DEMO')+'</span><span id="connection" class="connection">'+(connected?'Connected':'Reconnecting…')+'</span><button class="icon-btn" id="logout" aria-label="Sign out">'+icon('logout')+'</button></div></header><main id="main-content" tabindex="-1"><div class="page-content '+(tab==='overview'?'fleet-home':'')+'">'+(tab==='trips'?'<button class="manage-back text-btn" data-go="overview">← Dispatch</button>':'')+back+content+'</div></main></div><dialog id="modal"></dialog>';
 document.querySelectorAll('[data-owner-nav]').forEach(b=>b.onclick=e=>{e.preventDefault();tab=b.dataset.ownerNav;search='';filter='all';boardPage=1;render();window.scrollTo(0,0);});
 $('#logout').onclick=()=>run(async()=>{await api('/api/logout',{});stopConnection();user=null;codeSent=false;batch=null;lgtcUpload=null;lgtcApprovalSource=null;lgtcHistory=null;lgtcDraft=null;state=null;if(config.mode==='pilot')config=await api('/api/config');renderLogin();});
 const node=$('#geo-fleet-map');if(retainedMap&&node&&geoMap)node.replaceWith(retainedMap);else if(geoMap){geoMap.remove();geoMap=null;geoMarkers=null;}bindActions();
 if ($('#driver-duty-roster')) $('#driver-duty-roster').scrollTop = dutyScroll;
}
function managePage(){return '<section class="simple-page-head"><div><h1>Manage</h1><p>Your team, customers and business settings.</p></div></section><div class="manage-grid">'+[['drivers','car','Drivers & cars','Availability, vehicles and passenger seats'],['customers','users','Regular customers','Save preferred drivers and fallback'],['lgtc-settings','upload','LGTC dispatch settings','Predefine regular drivers and day plans'],['reports','grid','Reports','Driver and vehicle activity'],['settings','clock','Settings','Pickup timing and customer reminders']].map(([id,i,title,detail])=>'<button class="manage-card" data-go="'+id+'"><span class="manage-card-icon">'+icon(i)+'</span><strong>'+title+'</strong><small>'+detail+'</small>'+icon('arrow')+'</button>').join('')+'</div><div class="manage-links"><button class="text-btn" data-go="help">Support requests</button><button class="text-btn" data-go="messages">Customer updates</button><button class="text-btn" data-go="activity">Activity log</button></div>' + (config.mode==='pilot'?'':'<details class="manage-advanced"><summary>Test data & tools</summary><div><label>Fleet data<select id="dispatch-source" aria-label="Fleet data source">'+[['device','Phone GPS'],['sample','Sample fleet'],['scenario','Charlotte test fleet'],['replay','GPS replay'],['volume','500-trip dataset']].map(([id,label])=>'<option value="'+id+'" '+(fleetSource===id?'selected':'')+'>'+label+'</option>').join('')+'</select></label><button class="btn" id="manage-demo">Watch auto dispatch</button><button class="btn" id="manage-volume">Browse 500 test trips</button><button class="btn" id="dispatch-more">More test tools</button></div></details>');}
var regularCustomerSearch='';
function regularCustomersPage(){
 const groups=new Map();for(const t of state.trips){if(t.isSharedRun||!t.customerPhone)continue;const key=(t.demoRunId||'ordinary')+':'+t.customerPhone,g=groups.get(key);if(g){g.count++;if(t.pickupAt>g.trip.pickupAt)g.trip=t;}else groups.set(key,{trip:t,count:1});}
 const needle=regularCustomerSearch.trim().toLowerCase(),rows=[...groups.values()].filter(g=>needle?[g.trip.customerName,g.trip.customerPhone,g.trip.preferredDriver?.name].join(' ').toLowerCase().includes(needle):g.trip.preferredDriver).sort((a,b)=>a.trip.customerName.localeCompare(b.trip.customerName));
 return '<section class="simple-page-head"><div><h1>Regular customers</h1><p>Find a customer by name or mobile to save their regular driver.</p></div></section><form id="regular-customer-search" class="customer-find"><input id="regular-customer-query" type="search" placeholder="Customer name or mobile" aria-label="Find customer" value="'+esc(regularCustomerSearch)+'"><button class="btn primary">Find customer</button></form><section class="bookings-panel customer-list">'+(rows.length?rows.slice(0,20).map(g=>{const t=g.trip;return '<article><div><strong>'+esc(t.customerName)+(t.demoRunId?' <small>TEST</small>':'')+'</strong><small>'+esc(t.customerPhone)+' · '+g.count+' booking(s)</small></div><div><span>'+esc(t.preferredDriver?.name||'No regular driver')+'</span><button class="btn" data-regular-customer="'+esc(t.id)+'">'+(t.preferredDriver?'Change driver':'Set driver')+'</button></div></article>';}).join(''):'<div class="dispatch-empty"><h3>'+(needle?'No matching customer':'No saved regular customers')+'</h3><p>Search an existing customer to choose their regular driver.</p></div>')+'</section>'+(rows.length>20?'<p class="help">Showing 20 of '+rows.length+' matches. Refine your search to find a specific customer.</p>':'');
}
