const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const D = require('./domain.cjs');
const Location=require('./location.cjs');
const TrackingReplay=require('./tracking-replay.cjs');
const CharlotteFleet=require('./charlotte-fleet.cjs');
const DispatchReview=require('./dispatch-review.cjs');
const VolumeDemo=require('./volume-demo.cjs');
const QueueReviewDemo=require('./queue-review-demo.cjs');
const VehiclePlanner=require('./shared-planner.cjs');
const Reservations=require('./reservations.cjs');
const RideService=require('./ride-service.cjs');
const { parseFile, workbook } = require('./excel.cjs');
const { nextRideScenario } = require('./demo.cjs');
const Operations = require('./operations.cjs');
const LGTC = require('./lgtc.cjs');
const DriverDay = require('./driver-day.cjs');
const Road = require('./road-routing.cjs');
const Pilot = require('./road-pilot.cjs');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function createApp({ dbPath, clock = () => Date.now(), automaticDispatch = true, initialSettings={}, roadMatrix, pilotConfig, hostedDemoPassword, hostedDemoInvite, publicDemo = false } = {}) {
  const hostedDemo=publicDemo||hostedDemoPassword!==undefined;
  const privateDemo=hostedDemo&&!publicDemo;
  if (hostedDemo && (dbPath!==':memory:' || roadMatrix || pilotConfig)) {
    throw Error('The hosted demo needs an in-memory demo database.');
  }
  if (privateDemo && (typeof hostedDemoPassword!=='string' || hostedDemoPassword.trim().length<24)) {
    throw Error('The hosted demo needs a preview password of at least 24 characters.');
  }
  if (process.env.NODE_ENV === 'production'&&!hostedDemo) throw new Error('Production startup is disabled until secure user accounts and operational imports are configured.');
  const previewDigest=privateDemo?crypto.createHash('sha256').update('preview:'+hostedDemoPassword).digest():null;
  if (hostedDemoInvite !== undefined && (!privateDemo || !/^[A-Za-z0-9_-]{32,128}$/.test(hostedDemoInvite))) {
    throw Error('Set PROLIFT_PREVIEW_INVITE_TOKEN to a random URL-safe token of 32 to 128 characters.');
  }
  const inviteDigest = hostedDemoInvite && crypto.createHash('sha256').update(hostedDemoInvite).digest();
  const previewSessionAge = 43200;
  const previewPage = privateDemo ? fs.readFileSync(path.join(__dirname, 'public', 'preview.html'), 'utf8') : null;
  function previewSignature(expires) {
    return crypto.createHmac('sha256', previewDigest).update(inviteDigest || 'password').update(expires).digest();
  }
  function hasPreviewSession(req) {
    const cookie = /(?:^|;\s*)__Host-prolift_preview=(\d{1,16})\.([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '');
    return !!cookie && Number(cookie[1]) > clock() && crypto.timingSafeEqual(Buffer.from(cookie[2], 'hex'), previewSignature(cookie[1]));
  }
  const localMapKey = path.join(__dirname, 'data', 'google-maps-browser.key');
  const mapKey = publicDemo ? '' : (process.env.PROLIFT_GOOGLE_MAPS_BROWSER_KEY ||
    (!hostedDemo && require.main === module && fs.existsSync(localMapKey) ? fs.readFileSync(localMapKey, 'utf8') : '')).trim();
  if (!hostedDemo && require.main === module && process.env.PROLIFT_DISPATCH_MODE === 'road') {
    const routeKey = (process.env.PROLIFT_GOOGLE_ROUTES_KEY || '').trim();
    if (routeKey && routeKey === mapKey) throw Error('Use a separate server key for Google Routes.');
    roadMatrix = Road.googleMatrix(routeKey);
    try { pilotConfig = JSON.parse(fs.readFileSync(process.env.PROLIFT_PILOT_CONFIG,'utf8')); }
    catch { throw Error('Set PROLIFT_PILOT_CONFIG to a private pilot configuration file.'); }
  }
  const pilot = pilotConfig ? Pilot.configure(pilotConfig) : null;
  if (pilot && !roadMatrix) throw Error('The road pilot requires a road route provider.');
  const demoPath=path.join(__dirname,'data','prolift.sqlite');
  dbPath ??= pilot ? path.join(__dirname,'data','prolift-road-pilot.sqlite') : demoPath;
  if (pilot && path.resolve(dbPath).toLowerCase()===demoPath.toLowerCase()) throw Error('The road pilot needs its own database.');
  if (pilot?.stops.some(stop=>D.places.some(place=>place.name===stop.name))) throw Error('Verified stop names must be unique across the catalog.');
  const roadRouting = roadMatrix ? Road.createRoadRouting(roadMatrix) : null;
  if (pilot) roadRouting.places=pilot.stops;
  const googleCsp = mapKey ? {
    scripts: ' https://maps.googleapis.com https://maps.gstatic.com',
    styles: ' https://fonts.googleapis.com',
    images: ' blob: https://*.googleapis.com https://*.gstatic.com https://*.google.com https://*.googleusercontent.com',
    connect: ' https://*.googleapis.com https://*.gstatic.com https://*.google.com',
    extra: "; font-src https://fonts.gstatic.com; worker-src blob:"
  } : { scripts:'', styles:'', images:'', connect:'', extra:'' };
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user TEXT NOT NULL,expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS otp(phone TEXT PRIMARY KEY,code TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL,sent INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL);');
  const initial = D.seed(clock(),initialSettings);
  if (pilot) Object.assign(initial,{drivers:pilot.drivers,trips:[],customers:[]});
  db.prepare('INSERT OR IGNORE INTO state(id,body) VALUES(1,?)').run(JSON.stringify(initial));
  if (pilot) {
    const stored = JSON.parse(db.prepare('SELECT body FROM state WHERE id=1').get().body);
    const assigned=new Set(stored.trips.filter(t=>!t.poolParentId&&!['completed','cancelled'].includes(t.status)).map(t=>t.driverId));
    for (const d of stored.drivers) {
      d.status=pilot.hasDriver(d.id)&&assigned.has(d.id)?'busy':'offline';
      d.trackingEnabled=false;
    }
    for (const profile of pilot.drivers) {
      const current=stored.drivers.find(d=>d.id===profile.id);
      const { id,name,phone,vehicle,plate,seats,capabilities }=profile;
      if (current) Object.assign(current,{id,name,phone,vehicle,plate,seats,capabilities});
      else stored.drivers.push(profile);
    }
    db.prepare('UPDATE state SET body=? WHERE id=1').run(JSON.stringify(stored));
    db.exec('DELETE FROM sessions');
    D.places.push(...pilot.stops);
  }
  db.exec('CREATE TABLE IF NOT EXISTS lgtc_schedules(id TEXT PRIMARY KEY,saved_at INTEGER NOT NULL,summary TEXT NOT NULL,body TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS lgtc_identity_secret(id INTEGER PRIMARY KEY CHECK(id=1), secret TEXT NOT NULL); CREATE TABLE IF NOT EXISTS lgtc_preferences(customer_key TEXT PRIMARY KEY, driver_id TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS lgtc_automation(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO lgtc_identity_secret VALUES(1,?)').run(crypto.randomBytes(32).toString('hex'));
  const lgtcSecret = db.prepare('SELECT secret FROM lgtc_identity_secret WHERE id=1').get().secret;
  const lgtcKey = value => crypto.createHmac('sha256', lgtcSecret).update(value).digest('hex');
  const lgtcPreferenceRows=db.prepare('SELECT customer_key,driver_id FROM lgtc_preferences');
  function lgtcData() {
    const state = load();
    const roster = state.drivers.filter(d => !d.demoRunId && d.locationSource !== 'replay' && (!pilot || pilot.hasDriver(d.id)));
    const drivers = new Map(roster.map(d => [d.id, {id:d.id,name:d.name}]));
    const preferences = new Map();
    for (const [key, preference] of Object.entries(state.customerPreferences)) {
      if (!key.startsWith('ordinary:')) continue;
      const identity = LGTC.identity(preference.customerName, key.slice('ordinary:'.length));
      const driver = drivers.get(preference.driverId);
      if (identity && driver) preferences.set(lgtcKey(identity), driver);
    }
    for (const {customer_key, driver_id} of lgtcPreferenceRows.all()) {
      if (drivers.has(driver_id)) preferences.set(customer_key, drivers.get(driver_id));
    }
    return { roster, preferences };
  }
  const lgtcAutomation = () => JSON.parse(db.prepare('SELECT body FROM lgtc_automation WHERE id=1').get()?.body || 'null') ||
    { enabled:false, driverIds:[], buffer:30, profiles:{} };
  const lgtcRoster = roster => roster.map(d => ({
    id:d.id,name:d.name,vehicle:d.vehicle,seats:d.seats,accessible:d.capabilities.includes('wheelchair')
  }));
  function setLgtcPreference(key, driverId, roster) {
    if (driverId === null) db.prepare('DELETE FROM lgtc_preferences WHERE customer_key=?').run(key);
    else {
      if (!roster.some(d => d.id === driverId)) throw Error('Choose an ordinary fleet driver.');
      db.prepare('INSERT INTO lgtc_preferences VALUES(?,?) ON CONFLICT(customer_key) DO UPDATE SET driver_id=excluded.driver_id')
        .run(key,driverId);
    }
  }
  function lgtcPlanContext(batch, date, settings, { roster, preferences }) {
    const rosterById = new Map(roster.map(d => [d.id,d]));
    return hash(JSON.stringify([
      settings.driverIds.map(id => {
        const d = rosterById.get(id);
        return d && [d.id,d.name,d.vehicle,d.vehicleId,d.plate,d.seats,d.capabilities];
      }),
      batch.rows.filter(r => r.serviceDate === date).map(r => preferences.get(r.customerKey) || null)
    ]));
  }
  function lgtcView(batch, data = lgtcData()) {
    const view = LGTC.scheduleView(batch, data.preferences);
    const defaults = lgtcAutomation();
    view.automation = { enabled:defaults.enabled, driverCount:defaults.driverIds.length, codes:Object.keys(defaults.profiles).sort() };
    view.roster = lgtcRoster(data.roster);
    view.linked = batch.rows.some(row => Object.hasOwn(row,'customerKey'));
    view.drafts = Object.fromEntries(Object.entries(batch.drafts || {}).map(([date,draft]) => {
      const { plan, context, ...safe } = draft;
      const stale = safe.stale || !!(context && context !== lgtcPlanContext(batch,date,safe.settings,data));
      return [date, { ...safe, stale }];
    }));
    return view;
  }
  function recordLgtcDraft(schedule, serviceDate, plan, data, automatic = false) {
    const draft = { settings:plan.settings, savedAt:clock(), stale:false, automatic };
    if (plan.settings.driverIds) {
      draft.context = lgtcPlanContext(schedule,serviceDate,plan.settings,data);
      draft.plan = plan;
    }
    (schedule.drafts ??= {})[serviceDate] = draft;
  }
  const readLGTC = id => {
    const row = db.prepare('SELECT saved_at,body FROM lgtc_schedules WHERE id=?').get(String(id));
    if (!row) { const e = Error('Saved LGTC schedule not found'); e.status = 404; throw e; }
    return { ...JSON.parse(row.body), savedAt: row.saved_at };
  };
  function editLGTC(input, change) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const { savedAt, ...batch } = readLGTC(input.id);
      if (input.revision !== (batch.revision ?? 0)) {
        const error = Error('This schedule changed in another tab. Reopen it before making changes.');
        error.status = 409;
        throw error;
      }
      const result = change(batch);
      batch.revision = (batch.revision ?? 0) + 1;
      db.prepare('UPDATE lgtc_schedules SET body=? WHERE id=?').run(JSON.stringify(batch), batch.id);
      const view = lgtcView({ ...batch, savedAt });
      db.exec('COMMIT');
      return { batch: view, result };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const load = () => {
    const state = Operations.normalize(JSON.parse(db.prepare('SELECT body FROM state WHERE id=1').get().body));
    const imported=state.trips.filter(t=>t.lgtc&&!t.demoRunId&&!['completed','cancelled'].includes(t.status));
    if(imported.length){
      const preferences=new Map(lgtcPreferenceRows.all().map(row=>[row.customer_key,row.driver_id]));
      const matches=new Map();
      for(const trip of imported){
        const identity=LGTC.identity(trip.customerName,trip.customerPhone);
        const driverId=identity&&preferences.get(lgtcKey(identity));
        if(driverId) matches.set(trip.id,driverId);
      }
      Object.defineProperty(state,'lgtcRegularDrivers',{value:matches});
    }
    if (roadRouting) Object.defineProperty(state,'roadRouting',{value:roadRouting});
    return state;
  };
  db.exec('CREATE TABLE IF NOT EXISTS trip_records(id TEXT PRIMARY KEY,dataset_id TEXT NOT NULL,reference TEXT NOT NULL,status TEXT NOT NULL,pickup_at INTEGER NOT NULL,driver_id TEXT,passengers INTEGER NOT NULL,body TEXT NOT NULL); CREATE INDEX IF NOT EXISTS trip_records_dataset_time ON trip_records(dataset_id,pickup_at,id); CREATE INDEX IF NOT EXISTS trip_records_dataset_status ON trip_records(dataset_id,status); CREATE INDEX IF NOT EXISTS trip_records_reference ON trip_records(reference);');
  const upsertTrip=db.prepare('INSERT INTO trip_records VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET dataset_id=excluded.dataset_id,reference=excluded.reference,status=excluded.status,pickup_at=excluded.pickup_at,driver_id=excluded.driver_id,passengers=excluded.passengers,body=excluded.body WHERE trip_records.body<>excluded.body');
  function syncTrips(s){const ids=new Set(s.trips.map(t=>t.id));for(const t of s.trips)upsertTrip.run(t.id,t.demoRunId||'ordinary',t.reference,t.status,t.pickupAt,t.driverId||null,t.passengers,JSON.stringify(t));for(const row of db.prepare('SELECT id FROM trip_records').all())if(!ids.has(row.id))db.prepare('DELETE FROM trip_records WHERE id=?').run(row.id);}
  db.exec('BEGIN IMMEDIATE');try{syncTrips(load());db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');db.close();throw e;}
  const save = s => { s.revision++; db.prepare('UPDATE state SET body=? WHERE id=1').run(JSON.stringify(s));syncTrips(s); };
  const dispatchHealth={lastCheckAt:null,lastSuccessAt:null,lastError:null,intervalSeconds:3,automaticDispatch};
  if(automaticDispatch){mutate(s=>{for(const trip of s.trips)if(!trip.demoRunId&&['awaiting_driver','needs_reassignment','offered'].includes(trip.status))trip.autoDispatch=true;D.tick(s,clock());});dispatchHealth.lastCheckAt=clock();dispatchHealth.lastSuccessAt=clock();}
  const listeners = new Map(), limits = new Map();
  function clientState(user){
    const now=clock(),state=D.scoped(load(),user,now);
    if(user.role==='owner'){
      if(roadRouting) DispatchReview.projectForecasts(state,roadRouting,now);
      state.dispatchHealth={...dispatchHealth,routing:roadRouting?.health() || {mode:'demo',status:'simulated'}};
    }
    return state;
  }
  function publish() {
    for (const [res, {user,expires}] of listeners) {
      if(expires<=clock()){listeners.delete(res);res.end();continue;}
      if(res.writableNeedDrain){listeners.delete(res);res.destroy();continue;}
      try { res.write(`event: state\ndata: ${JSON.stringify({ state: clientState(user), at: clock() })}\n\n`); } catch { listeners.delete(res); }
    }
  }
  function mutate(work) {
    db.exec('BEGIN IMMEDIATE');
    try { const s = load(), result = work(s); save(s); db.exec('COMMIT'); return result; }
    catch (e) { db.exec('ROLLBACK'); throw e; }
  }
  function sessionKey(req) {
    const token = /(?:^|;\s*)prolift=([a-f0-9]+)/.exec(req.headers.cookie || '')?.[1];
    return token ? hash(token) : null;
  }
  function session(req) {
    const key = sessionKey(req);
    if (!key) return null;
    const row = db.prepare('SELECT user FROM sessions WHERE token=? AND expires>?').get(key, clock());
    return row ? JSON.parse(row.user) : null;
  }
  function signIn(res, user) {
    const token = crypto.randomBytes(32).toString('hex');
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(hash(token), JSON.stringify(user), clock() + 12 * 3600000);
    res.setHeader('Set-Cookie', `prolift=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${pilot||hostedDemo?'; Secure':''}`);
    return user;
  }
  function throttle(key, max, ms) {
    const now = clock(), bucket = limits.get(key) || { count: 0, reset: now + ms };
    if (bucket.reset <= now) { bucket.count = 0; bucket.reset = now + ms; }
    bucket.count++; limits.set(key, bucket);
    if (bucket.count > max) { const e = new Error('Too many attempts. Please try again later.'); e.status = 429; throw e; }
    if (limits.size > 3000) for (const [k, v] of limits) if (v.reset < now) limits.delete(k);
  }
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(body)); };
  async function body(req) {
    let length = 0; const chunks = [];
    for await (const chunk of req) { length += chunk.length; if (length > 7500000) { const e = new Error('Upload is too large'); e.status = 413; throw e; } chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw new Error('Invalid request data'); }
  }
  function requireRole(user, role) { if (!user || role && user.role !== role) { const e = new Error(user ? 'You do not have access to this action' : 'Please sign in'); e.status = user ? 403 : 401; throw e; } }
  const publicDemoBlockedWrites = new Set([
    '/api/import/preview', '/api/import/confirm', '/api/lgtc/schedules', '/api/lgtc/dispatch',
    '/api/lgtc/customer', '/api/driver/tracking', '/api/driver/location',
  ]);
  const server = http.createServer(async (req, res) => {
    if (hostedDemo && req.method==='GET' && req.url==='/healthz') return json(res,200,{ok:true});
    if (privateDemo) {
      if (req.method === 'GET' && req.url.split('?')[0] === '/preview') {
        const nonce = crypto.randomBytes(16).toString('base64');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
        });
        return res.end(previewPage.replaceAll('{{nonce}}', nonce));
      }
      if (req.method === 'POST' && req.url === '/api/preview/access') {
        try {
          if (req.headers['sec-fetch-site'] === 'cross-site' ||
              (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) {
            return json(res, 403, { error: 'Cross-site requests are not allowed' });
          }
          if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { error: 'JSON request required' });
          throttle(`preview-access:${req.socket.remoteAddress}`, 30, 60000);
          const { token, username, password } = await body(req) || {};
          const usingInvite = token !== undefined;
          const valid = usingInvite
            ? inviteDigest && typeof token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(token) &&
              crypto.timingSafeEqual(crypto.createHash('sha256').update(token).digest(), inviteDigest)
            : username === 'preview' && typeof password === 'string' &&
              crypto.timingSafeEqual(crypto.createHash('sha256').update('preview:' + password).digest(), previewDigest);
          if (!valid) {
            return json(res, 403, { error: usingInvite ? 'Invalid preview invite' : 'Check your username and password.' });
          }
          const expires = String(clock() + previewSessionAge * 1000);
          res.setHeader('Set-Cookie', `__Host-prolift_preview=${expires}.${previewSignature(expires).toString('hex')}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${previewSessionAge}`);
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, error.status || 400, { error: error.message });
        }
      }
      const encoded=/^Basic ([A-Za-z0-9+/=]+)$/i.exec(req.headers.authorization||'')?.[1];
      const digest=encoded&&crypto.createHash('sha256').update(Buffer.from(encoded,'base64')).digest();
      if(!hasPreviewSession(req)&&(!digest||!crypto.timingSafeEqual(digest,previewDigest))){
        if (req.method === 'GET' && req.url.split('?')[0] === '/') {
          res.writeHead(302, { Location: '/preview', 'Cache-Control': 'no-store' });
          return res.end();
        }
        return json(res,401,{error:'RoyalCab preview sign-in required'});
      }
    }
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    const nonce = mapKey ? crypto.randomBytes(16).toString('base64') : '';
    const nonceSource = nonce ? " 'nonce-" + nonce + "'" : '';
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'" + nonceSource + googleCsp.scripts +
      "; style-src 'self'" + nonceSource + googleCsp.styles + "; img-src 'self' data: https://tile.openstreetmap.org" + googleCsp.images +
      "; connect-src 'self'" + googleCsp.connect + "; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" + googleCsp.extra);
    try {
      const url = new URL(req.url, 'http://localhost'), user = session(req);
      if (req.method !== 'GET') {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Cross-site requests are not allowed' });
        if (req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: 'Cross-site requests are not allowed' });
        if (!String(req.headers['content-type']).startsWith('application/json')) return json(res, 415, { error: 'JSON request required' });
        throttle(`write:${req.socket.remoteAddress}`, 200, 60000);
      }
      if (publicDemo && req.method === 'GET' && url.pathname === '/preview') {
        const role = url.searchParams.get('demo');
        res.writeHead(302, { Location: ['owner','driver','customer'].includes(role) ? '/?demo='+role+'#' : '/#', 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (publicDemo && req.method === 'POST' &&
          (publicDemoBlockedWrites.has(url.pathname) || url.pathname === '/api/support' || url.pathname.startsWith('/api/support/'))) {
        return json(res, 403, { error: 'The public demo uses sample rides and simulated GPS. Personal data cannot be submitted here.' });
      }
      if (url.pathname === '/api/config' && req.method === 'GET') {
        const center=pilot?.stops[0];
        return json(res,200,{mode:pilot?'pilot':'demo',publicDemo,dispatchMode:roadRouting?'road':'demo',
          map:{city:pilot?'Verified service area':'Charlotte, NC',center:center?[center.lat,center.lng]:[35.2271,-80.8431],
            zoom:13,googleKey:!pilot||user?mapKey||undefined:undefined},
          places:pilot?(user?pilot.stops:[]):D.places,declineReasons:D.declineReasons,releaseReasons:D.releaseReasons,
          drivers:pilot?[]:load().drivers.map(d=>({id:d.id,name:d.name,vehicle:d.vehicle})),
          providers:{maps:mapKey?'Google Maps':'OpenStreetMap',routing:roadRouting?'Google Routes road ETA pilot':'Simulated travel time',
            gps:'Foreground phone GPS',sms:pilot?'Delivery not configured':'Demo verification',storage:'SQLite (local)'}});
      }
      if (url.pathname === '/api/session' && req.method === 'GET') return json(res, 200, { user });
      if (pilot && (url.pathname==='/api/demo-login'||url.pathname.startsWith('/api/demo/')||url.pathname.startsWith('/api/auth/'))) {
        return json(res,403,{error:'Demo login and test data tools are unavailable in the road pilot.'});
      }
      if (url.pathname === '/api/pilot-login' && req.method === 'POST') {
        if (!pilot) return json(res,404,{error:'Pilot sign-in is unavailable.'});
        throttle('pilot-login:'+req.socket.remoteAddress,8,60000);
        const b=await body(req);
        if (!pilot.authenticate(b.role,b.driverId,b.code)) return json(res,401,{error:'Check the pilot ID or access code.'});
        const account=b.role==='owner'?{role:'owner',id:'pilot-owner',name:'Fleet owner'}:
          {role:'driver',driverId:b.driverId,name:load().drivers.find(d=>d.id===b.driverId).name};
        return json(res,200,{user:signIn(res,account)});
      }
      if (url.pathname === '/api/demo-login' && req.method === 'POST') {
        const b = await body(req); let u;
        if (b.role === 'owner') u = { role: 'owner', name: 'Fleet owner', id: 'owner-demo' };
        else if (b.role === 'driver') { const d = load().drivers.find(d => d.id === b.driverId); if (!d) throw new Error('Driver not found'); u = { role: 'driver', name: d.name, driverId: d.id }; }
        else if (b.role === 'customer') u = { role: 'customer', name: 'Alex Morgan', phone: '+15550102001' };
        else throw new Error('Choose owner, driver, or customer');
        return json(res, 200, { user: signIn(res, u) });
      }
      if (url.pathname === '/api/auth/request-code' && req.method === 'POST') {
        const b = await body(req); if (!D.phoneValid(b.phone)) throw new Error('Enter a mobile number with country code, such as +15550102001');
        if (publicDemo && b.phone !== '+15550102001') return json(res, 403, { error: 'Use the sample mobile number in the public demo.' });
        throttle(`sms-ip:${req.socket.remoteAddress}`, 10, 3600000);
        const prev = db.prepare('SELECT sent FROM otp WHERE phone=?').get(b.phone);
        if (prev && clock() - prev.sent < 30000) throw new Error('Wait 30 seconds before requesting another code');
        throttle(`sms:${b.phone}`, 5, 3600000);
        const code = String(crypto.randomInt(100000, 1000000));
        db.prepare('INSERT OR REPLACE INTO otp VALUES(?,?,?,?,?)').run(b.phone, hash(`${b.phone}:${code}`), clock() + 300000, 0, clock());
        return json(res, 200, { demoCode: code, message: 'DEMO only: no SMS was sent. This code expires in five minutes.' });
      }
      if (url.pathname === '/api/auth/verify' && req.method === 'POST') {
        const b = await body(req); if (!D.phoneValid(b.phone)) throw new Error('Invalid phone number');
        if (publicDemo && b.phone !== '+15550102001') return json(res, 403, { error: 'Use the sample mobile number in the public demo.' });
        throttle(`verify:${req.socket.remoteAddress}`, 30, 60000);
        const row = db.prepare('SELECT * FROM otp WHERE phone=?').get(b.phone);
        if (!row || row.expires < clock() || row.attempts >= 5) throw new Error('Code expired or attempt limit reached. Request a new code.');
        db.prepare('UPDATE otp SET attempts=attempts+1 WHERE phone=?').run(b.phone);
        if (!crypto.timingSafeEqual(Buffer.from(row.code), Buffer.from(hash(`${b.phone}:${b.code}`)))) throw new Error('Incorrect code');
        const s = load(), found = s.customers.find(c => c.phone === b.phone);
        const name = found?.name || String(b.name || '').trim().slice(0, 100);
        if (!name) throw new Error('Enter your name to create your account');
        mutate(s => { if (!s.customers.some(c => c.phone === b.phone)) s.customers.push({ phone: b.phone, name }); db.prepare('DELETE FROM otp WHERE phone=?').run(b.phone); });
        return json(res, 200, { user: signIn(res, { role: 'customer', phone: b.phone, name }) });
      }
      if (url.pathname === '/api/logout' && req.method === 'POST') {
        const key = sessionKey(req);
        if (key) {
          db.prepare('DELETE FROM sessions WHERE token=?').run(key);
          for (const [stream, listener] of listeners) if (listener.key===key) {listeners.delete(stream);stream.end();}
        }
        res.setHeader('Set-Cookie', 'prolift=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'); return json(res, 200, { ok: true });
      }
      if (url.pathname.startsWith('/api/')) requireRole(user);
      if(url.pathname==='/api/operations/readiness'&&req.method==='GET'){requireRole(user,'owner');return json(res,200,DispatchReview.readiness(load(),clock()));}
      const reviewRoute=url.pathname.match(/^\/api\/trips\/([^/]+)\/dispatch-review$/);
      if (reviewRoute && req.method==='GET') {
        requireRole(user,'owner');
        let s=load(), trip=s.trips.find(t=>t.id===reviewRoute[1]);
        if (roadRouting && trip && !trip.driverId && !['completed','cancelled'].includes(trip.status) &&
            trip.pickupAt <= clock()+Operations.settings(s).dispatchLeadMinutes*60000) {
          await roadRouting.prepare(s,[trip],D.places,clock);
          s=load(); trip=s.trips.find(t=>t.id===reviewRoute[1]);
        }
        return json(res,200,DispatchReview.inspect(s,trip,clock()));
      }
      if (url.pathname === '/api/state' && req.method === 'GET') return json(res, 200, { state: clientState(user), at: clock() });
      if(url.pathname==='/api/settings'&&req.method==='POST'){
        requireRole(user,'owner');const b=Operations.validateSettings(await body(req));
        mutate(s=>{s.settings=b;for(const t of s.trips)if(t.autoDispatch&&['awaiting_driver','needs_reassignment'].includes(t.status))t.retryAt=clock();D.event(s,'settings.updated',null,user.name,`Dispatch ${b.dispatchLeadMinutes} min; reminder ${b.customerReminderMinutes} min`);D.tick(s,clock());});publish();return json(res,200,{settings:b});
      }
      if(['/api/reports','/api/reports.csv'].includes(url.pathname)&&req.method==='GET'){
        requireRole(user,'owner');const from=url.searchParams.has('from')?Date.parse(url.searchParams.get('from')):0,to=url.searchParams.has('to')?Date.parse(url.searchParams.get('to')):clock()+86400000;
        const report=Operations.reports(load(),{from,to,group:url.searchParams.get('group')||'driver'});
        if(url.pathname.endsWith('.csv')){res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="ProLift-${report.group}-report.csv"`,'Cache-Control':'no-store'});return res.end(Operations.csv(report));}
        return json(res,200,report);
      }
      if (url.pathname === '/api/demo/next-ride' && req.method === 'POST') {
        requireRole(user,'owner'); await body(req);
        const result=mutate(s=>nextRideScenario(s,clock()));publish();return json(res,201,result);
      }
      if (url.pathname === '/api/demo/start-trip' && req.method === 'POST') {
        requireRole(user, 'owner'); await body(req);
        const result = mutate(s => {
          // This local-only demonstration uses isolated drivers and the normal
          // eligibility, offer and response functions, never production identities.
          const priorRuns=new Set(s.trips.filter(t=>t.demoRunId&&t.demoCandidates).map(t=>t.demoRunId));
          for (const t of s.trips.filter(t => priorRuns.has(t.demoRunId) && !['completed', 'cancelled'].includes(t.status))) D.action(s, t, 'cancel', user, {}, clock());
          s.drivers = s.drivers.filter(d => !priorRuns.has(d.demoRunId));
          const runId = D.id('demo'), now = clock();
          const coords = [[40.7528, -73.9773], [40.771, -73.9772], [40.790, -73.9772]];
          const names = ['Demo Maya · nearest', 'Demo James · second nearest', 'Demo Sofia · farther away'];
          const drivers = coords.map(([lat, lng], index) => ({ id: `demo-driver-${index + 1}`, demoRunId: runId, name: names[index], phone: `+1555010990${index + 1}`, status: 'online', seats: 4, capabilities: [], vehicle: 'Demo car', plate: `DEMO ${index + 1}`, lat, lng, lastLocationAt: now }));
          s.drivers.push(...drivers);
          const trip = { id: D.id('trip'), reference: 'DEMO-' + runId.split('-')[1].toUpperCase(), demoRunId: runId, customerName: 'Demo passenger', customerPhone: '+15550102001', pickup: 'Central Station', destination: 'City Hospital', pickupAt: now + 10 * 60000, passengers: 1, requirements: [], status: 'awaiting_driver', driverId: null, redFlag: false, excluded: [], createdAt: now, autoDispatch: true };
          s.trips.push(trip);
          trip.demoCandidates = D.eligible(s, trip, now).map(({ driver, eta }) => ({ driverId: driver.id, name: driver.name, eta }));
          D.event(s, 'demo.trip_created', trip, user.name, 'Three isolated available drivers; ranked by simulated pickup travel time');
          D.offer(s, trip, 'Automatic dispatch', now);
          return { tripId: trip.id, candidates: trip.demoCandidates };
        }); publish(); return json(res, 201, result);
      }
      if (url.pathname === '/api/demo/respond' && req.method === 'POST') {
        requireRole(user, 'owner'); const b = await body(req);
        mutate(s => {
          const t = s.trips.find(t => t.id === b.tripId && t.demoRunId);
          if (!t) throw new Error('Start a dummy trip first');
          if (!['accept', 'decline'].includes(b.action)) throw new Error('Choose accept or decline');
          const offer = s.offers.find(o => o.id === b.offerId && o.tripId === t.id);
          if (!offer) throw new Error('Offer not found');
          const d = s.drivers.find(d => d.id === offer.driverId && d.demoRunId === t.demoRunId);
          if (!d) throw new Error('Demo driver not found');
          D.action(s, t, b.action, { role: 'driver', driverId: d.id, name: d.name }, { offerId: offer.id, reason: b.reason }, clock());
          if (b.action === 'decline') D.tick(s, clock());
        }); publish(); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/dispatch/start' && req.method === 'POST') {
        requireRole(user, 'owner'); await body(req);
        const result = mutate(s => {
          const waiting = s.trips.filter(t => !t.demoRunId && ['awaiting_driver', 'needs_reassignment'].includes(t.status)).sort((a, b) => a.pickupAt - b.pickupAt);
          for (const trip of waiting) D.action(s, trip, 'retry', user, {}, clock());
          D.tick(s, clock());
          D.event(s, 'dispatch.automatic_started', null, user.name, `Enabled automatic dispatch for ${waiting.length} waiting trips`);
          return { offered: waiting.filter(t => t.status === 'offered').length, scheduled: waiting.filter(t => t.pickupAt > clock() + Operations.settings(s).dispatchLeadMinutes * 60000).length, blocked: waiting.filter(t => t.dispatchError).length };
        }); publish(); return json(res, 200, result);
      }
      if (url.pathname === '/api/events' && req.method === 'GET') {
        if ([...listeners.values()].filter(listener => JSON.stringify(listener.user) === JSON.stringify(user)).length >= 5) return json(res, 429, { error: 'Too many open dashboard connections' });
        const key=sessionKey(req), expires=db.prepare('SELECT expires FROM sessions WHERE token=?').get(key).expires;
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering':'no', Connection: 'keep-alive' });
        listeners.set(res, {user,key,expires}); res.write(`retry: 2000\nevent: state\ndata: ${JSON.stringify({ state: clientState(user), at: clock() })}\n\n`);
        const expiry = setTimeout(() => { listeners.delete(res); res.end(); }, Math.min(600000,expires-clock())); expiry.unref();
        res.on('close', () => { clearTimeout(expiry); listeners.delete(res); }); return;
      }
      if (url.pathname === '/api/template' && req.method === 'GET') {
        requireRole(user, 'owner'); const date = new Date(clock() + 3600000).toISOString().replace(/\.\d{3}Z$/, 'Z');
        const rows = [['trip_id', 'pickup_at', 'customer_name', 'customer_phone', 'pickup', 'destination', 'passengers', 'requirements'], ['IMPORT-' + new Date(clock()).toISOString().slice(11, 19).replace(/:/g, ''), date, 'Alex Morgan', '+15550102001', 'Central Station', 'City Hospital', '1', '']];
        const bytes = workbook(rows); res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': 'attachment; filename="ProLift-trip-template.xlsx"' }); return res.end(bytes);
      }
      if (url.pathname === '/api/import/preview' && req.method === 'POST') {
        requireRole(user, 'owner'); const b = await body(req);
        const lgtc = LGTC.detect(b.filename, b.base64, lgtcKey);
        if (lgtc) return json(res, 200, { batch: lgtcView(lgtc) });
        const rows = D.validateRows(load(), parseFile(String(b.filename), Buffer.from(String(b.base64), 'base64')), clock());
        if (!rows.length) throw new Error('The sheet has no trips');
        const batch = { id: D.id('import'), rows, at: clock(), confirmed: false };
        mutate(s => { s.imports.unshift(batch); s.imports = s.imports.slice(0, 30); }); return json(res, 200, { batch });
      }
      if (url.pathname === '/api/lgtc/schedules' && req.method === 'GET') {
        requireRole(user, 'owner');
        if (url.searchParams.has('id')) return json(res, 200, { batch: lgtcView(readLGTC(url.searchParams.get('id'))) });
        const schedules = db.prepare('SELECT id,saved_at,summary FROM lgtc_schedules ORDER BY saved_at DESC LIMIT 100').all()
          .map(r => ({ id: r.id, savedAt: r.saved_at, summaries: JSON.parse(r.summary) }));
        return json(res, 200, { schedules });
      }
      if (url.pathname === '/api/lgtc/settings') {
        requireRole(user, 'owner');
        const {roster} = lgtcData();
        if (req.method === 'GET') return json(res,200,{ settings:lgtcAutomation(), roster:lgtcRoster(roster) });
        if (req.method === 'POST') {
          const settings = LGTC.automationSettings(await body(req),roster);
          db.prepare('INSERT INTO lgtc_automation VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(JSON.stringify(settings));
          return json(res,200,{ settings, roster:lgtcRoster(roster) });
        }
      }
      if (url.pathname === '/api/lgtc/customer' && req.method === 'POST') {
        requireRole(user, 'owner'); const b = await body(req);
        if (!['lookup','save'].includes(b.action)) throw Error('Choose a regular driver action.');
        const identity = LGTC.identity(b.name,b.phone);
        if (!identity || String(b.name).length > 150 || String(b.phone).length > 40) throw Error('Enter the rider’s name and a valid US mobile number.');
        const key = lgtcKey(identity);
        if (b.action === 'save') setLgtcPreference(key,b.driverId,lgtcData().roster);
        return json(res,200,{ regularDriver:lgtcData().preferences.get(key) || null });
      }
      if (url.pathname === '/api/lgtc/schedules' && req.method === 'POST') {
        requireRole(user, 'owner'); const b = await body(req);
        const batch = LGTC.detect(b.filename, b.base64, lgtcKey);
        if (!batch || b.id !== batch.id) throw Error('Upload and review this LGTC export before saving.');
        db.prepare('INSERT OR IGNORE INTO lgtc_schedules VALUES(?,?,?,?)')
          .run(batch.id, clock(), JSON.stringify(batch.summaries), JSON.stringify(batch));
        const saved = readLGTC(batch.id);
        const identitiesChanged = saved.rows.some((row,i) => row.customerKey !== batch.rows[i].customerKey);
        const sourceChanged = saved.sourceStamp !== batch.sourceStamp;
        const automation = lgtcAutomation();
        const automaticDates = automation.enabled ? saved.dates.filter(date => !saved.drafts?.[date]) : [];
        if (sourceChanged || identitiesChanged || automaticDates.length) {
          const { batch:updated, result } = editLGTC({id:saved.id,revision:saved.revision ?? 0}, schedule => {
            if (sourceChanged || identitiesChanged) {
              schedule.sourceStamp = batch.sourceStamp;
              schedule.rows.forEach((row,i) => { row.customerKey = batch.rows[i].customerKey; });
              for (const draft of Object.values(schedule.drafts || {})) draft.stale = true;
            }
            const data = lgtcData(), autoPlanned = [];
            let autoError;
            for (const serviceDate of automaticDates) {
              try {
                const plan = LGTC.plan(schedule, { ...automation, serviceDate },data);
                recordLgtcDraft(schedule,serviceDate,plan,data,true);
                autoPlanned.push({ serviceDate, allocated:plan.allocated, unassigned:plan.unplanned.length });
              } catch (error) { autoError = error.message; break; }
            }
            return { autoPlanned, autoError };
          });
          return json(res, 200, { batch:updated, ...result });
        }
        return json(res, 200, { batch: lgtcView(saved) });
      }
      if (url.pathname === '/api/lgtc/dispatch' && req.method === 'POST') {
        requireRole(user, 'owner');
        const b = await body(req);
        if (!['preview','approve'].includes(b.action)) throw Error('Choose preview or approve.');
        const source = LGTC.detect(b.filename,b.base64,lgtcKey,true);
        if (!source || source.id !== b.id) throw Error('Choose the original CSV for this saved schedule.');
        const prepare = state => {
          const schedule = readLGTC(b.id);
          if (b.revision !== (schedule.revision ?? 0)) {
            const error = Error('The day plan changed. Reopen it before approving.');
            error.status = 409;
            throw error;
          }
          if (!schedule.sourceStamp || source.sourceStamp !== schedule.sourceStamp) {
            throw Error('This file does not match the saved upload. Save the original CSV and rebuild the day plan.');
          }
          const draft = schedule.drafts?.[b.serviceDate];
          if (!draft?.plan?.settings.driverIds) throw Error('Save a day plan with named drivers first.');
          if (draft.stale || draft.context !== lgtcPlanContext(schedule,b.serviceDate,draft.settings,lgtcData())) {
            throw Error('Rebuild the day plan before approving these rides.');
          }
          return LGTC.dispatchCandidates(draft.plan,source.dispatchSource,state,pilot?.stops||D.places,D.validateRows,clock(),pilot);
        };
        if (b.action === 'preview') {
          const {ready,held,existing} = prepare(load());
          return json(res,200,{ready:ready.map(({trip,reference,driver})=>({
            reference,dispatchRef:trip.reference,driver,pickup:trip.pickup,destination:trip.destination,pickupAt:trip.pickupAt
          })),held,existing});
        }
        const result = mutate(state => {
          const {ready,held,existing} = prepare(state);
          const offered = new Set(ready.map(row=>row.trip.reference));
          const prior = new Set(existing.map(row=>row.dispatchRef));
          if (!Array.isArray(b.references) || !b.references.length || b.references.length > 1000 ||
              b.references.some(ref=>!offered.has(ref)&&!prior.has(ref)) ||
              ready.some(row=>!b.references.includes(row.trip.reference))) {
            const error = Error('The dispatch list changed. Review the ready rides again before approving.');
            error.status = 409;
            throw error;
          }
          const approved = ready.map(({trip,reference}) => {
            state.trips.push(trip);
            D.event(state,'lgtc.approved',trip,user.name,pilot?'Approved from LGTC day plan':'Approved from LGTC day plan · test ride');
            return {reference,tripId:trip.id,status:trip.status};
          });
          return {approved,held,existing};
        });
        if (result.approved.length) publish();
        return json(res,200,result);
      }
      if (url.pathname === '/api/lgtc/preference' && req.method === 'POST') {
        requireRole(user, 'owner'); const b = await body(req);
        const { batch } = editLGTC(b, schedule => {
          const row = schedule.rows.find(r => r.row === b.row);
          if (!row?.customerKey) throw Error('This source row has no usable rider name and mobile for matching.');
          setLgtcPreference(row.customerKey,b.driverId,lgtcData().roster);
        });
        return json(res, 200, { batch });
      }
      if (url.pathname === '/api/lgtc/review' && req.method === 'POST') {
        requireRole(user, 'owner'); const b = await body(req);
        const { batch } = editLGTC(b, schedule => {
          const { row, review } = LGTC.reviewLeg(schedule, b);
          schedule.reviews ??= {};
          if (review) schedule.reviews[row.row] = review;
          else delete schedule.reviews[row.row];
          if (schedule.drafts?.[row.serviceDate]) schedule.drafts[row.serviceDate].stale = true;
        });
        return json(res, 200, { batch });
      }
      if (url.pathname === '/api/lgtc/plan' && req.method === 'POST') {
        requireRole(user, 'owner'); const b = await body(req);
        const data = lgtcData();
        if (b.save === true) {
          const { batch, result } = editLGTC(b, schedule => {
            const plan = LGTC.plan(schedule, b, data);
            recordLgtcDraft(schedule,b.serviceDate,plan,data);
            return plan;
          });
          return json(res, 200, { plan: result, revision: batch.revision, draft: batch.drafts[b.serviceDate] });
        }
        if (b.reopen === true) {
          const schedule = readLGTC(b.id);
          const draft = schedule.drafts?.[b.serviceDate];
          const stale = draft?.stale || !!(draft?.context && draft.context !== lgtcPlanContext(schedule,b.serviceDate,draft.settings,data));
          const plan = draft && !stale ? draft.plan || LGTC.plan(schedule, { ...draft.settings, serviceDate: b.serviceDate },data) : null;
          return json(res, 200, { plan, revision: schedule.revision ?? 0 });
        }
        return json(res, 200, { plan: LGTC.plan(readLGTC(b.id), b, data) });
      }
      if (url.pathname === '/api/import/confirm' && req.method === 'POST') {
        requireRole(user, 'owner'); const b = await body(req);
        const result = mutate(s => {
          const batch = s.imports.find(i => i.id === b.batchId); if (!batch) throw new Error('Import preview expired; upload the file again');
          if (batch.confirmed) return { count: batch.rows.length, alreadyConfirmed: true };
          const checked = D.validateRows(s, batch.rows, clock());
          if (checked.some(r => r.errors.length)) throw new Error('Some rows are invalid or have become duplicates. Upload a corrected sheet.');
          for (const row of checked) { s.trips.push(row.trip); D.event(s, 'trip.imported', row.trip, user.name); }
          batch.confirmed = true; return { count: checked.length };
        }); publish(); return json(res, 200, result);
      }
      if(url.pathname==='/api/demo/charlotte-fleet'&&req.method==='POST'){
        requireRole(user,'owner');const b=await body(req);if(!['start','stop'].includes(b.action))throw Error('Choose start or stop');const result=mutate(s=>{if(b.action==='start')return CharlotteFleet.start(s,clock());CharlotteFleet.stop(s,clock());return s.fleetScenario;});publish();return json(res,200,result);
      }
      if(url.pathname==='/api/demo/tracking-replay'&&req.method==='POST'){
        requireRole(user,'owner');const b=await body(req);const result=mutate(s=>b.action==='start'?TrackingReplay.start(s,clock()):TrackingReplay.control(s,b.action,clock()));publish();return json(res,200,result);
      }
      if(url.pathname==='/api/driver/tracking'&&req.method==='POST'){
        requireRole(user,'driver');const b=await body(req);if(typeof b.enabled!=='boolean')throw Error('Choose enabled or disabled');
        mutate(s=>{const d=s.drivers.find(d=>d.id===user.driverId);if(!d)throw Error('Driver not found');if(d.trackingSimulation)throw Error('The replay driver cannot share real phone GPS');if(b.enabled&&d.status==='offline')throw Error('Go online before sharing location');
          if(b.enabled&&(d.locationSource!=='device'||d.trackingEnabled!==true)){d.lat=null;d.lng=null;d.lastLocationAt=0;d.locationAccuracy=null;d.lastLocationPointId=null;}
          d.locationSource='device';d.trackingEnabled=b.enabled;D.event(s,b.enabled?'tracking.started':'tracking.stopped',null,user.name,'Foreground phone location sharing');
        });publish();return json(res,200,{ok:true});
      }
      if(url.pathname==='/api/driver/location'&&req.method==='POST'){
        requireRole(user,'driver');const b=await body(req);
        const result=mutate(s=>{
          const now=clock(), result=Location.ingest(s,user,b,now);
          if (roadRouting && result.accepted.length) for (const trip of s.trips) {
            if (Road.requiresRoad(trip) && trip.autoDispatch && ['awaiting_driver','needs_reassignment'].includes(trip.status) &&
                trip.pickupAt >= now-300000 && trip.pickupAt <= now+Operations.settings(s).dispatchLeadMinutes*60000) trip.retryAt=now;
          }
          return result;
        });
        if(result.accepted.length)publish();return json(res,200,result);
      }
      if(url.pathname==='/api/customer-preference'&&req.method==='POST'){
        requireRole(user,'owner');const b=await body(req);mutate(s=>{const t=s.trips.find(t=>t.id===b.tripId);if(!t||t.isSharedRun||!D.phoneValid(t.customerPhone))throw Error('Choose an individual customer booking');
          if(t.lgtc&&!t.demoRunId){
            const identity=LGTC.identity(t.customerName,t.customerPhone);
            if(!identity) throw Error('This LGTC ride has no usable customer identity');
            setLgtcPreference(lgtcKey(identity),b.driverId,lgtcData().roster);
            D.event(s,b.driverId===null?'customer.regular_driver_cleared':'customer.regular_driver_saved',t,user.name,
              b.driverId===null?'LGTC override cleared; use the customer default':'LGTC regular driver first when eligible');
            return;
          }
          const key=(t.demoRunId||'ordinary')+':'+t.customerPhone;
          if(b.driverId===null){delete s.customerPreferences[key];D.event(s,'customer.regular_driver_cleared',t,user.name,'Use nearest suitable available driver');return;}
          const d=s.drivers.find(d=>d.id===b.driverId);if(!d||(d.demoRunId||null)!==(t.demoRunId||null))throw Error('Choose a driver from this booking’s fleet');
          s.customerPreferences[key]={phone:t.customerPhone,customerName:t.customerName,driverId:d.id,fallback:'another_suitable_driver',updatedAt:clock()};D.event(s,'customer.regular_driver_saved',t,user.name,d.name+' first when eligible; otherwise another suitable driver');
        });publish();return json(res,200,{ok:true});
      }
      if(url.pathname==='/api/demo/volume'&&req.method==='POST'){
        requireRole(user,'owner');await body(req);const result=mutate(s=>VolumeDemo.seed(s,clock()));publish();return json(res,200,result);
      }
      if (url.pathname === '/api/demo/queue-review' && req.method === 'POST') {
        requireRole(user,'owner');
        const b = await body(req);
        const run = mutate(s=>QueueReviewDemo.seed(s,clock(),{restart:b.restart===true}));
        publish();
        return json(res,200,run);
      }
      if(url.pathname==='/api/demo/volume'&&req.method==='GET'){
        requireRole(user,'owner');const demo=load().volumeDemo;if(!demo)return json(res,200,{total:0,rows:[],page:1,pages:1});
        const search=(url.searchParams.get('search')||'').trim().slice(0,100),status=(url.searchParams.get('status')||'').slice(0,40),where="dataset_id=? AND (?='' OR status=?) AND (?='' OR reference LIKE ? OR body LIKE ?)",args=[demo.runId,status,status,search,'%'+search+'%','%'+search+'%'];
        const total=Number(db.prepare('SELECT COUNT(*) AS n FROM trip_records WHERE '+where).get(...args).n),pages=Math.max(1,Math.ceil(total/25)),requested=Number(url.searchParams.get('page'))||1,page=Math.max(1,Math.min(pages,Math.floor(requested)));
        const rows=db.prepare('SELECT body FROM trip_records WHERE '+where+' ORDER BY pickup_at,id LIMIT 25 OFFSET ?').all(...args,(page-1)*25).map(r=>JSON.parse(r.body)),counts=db.prepare('SELECT status,COUNT(*) AS count FROM trip_records WHERE dataset_id=? GROUP BY status').all(demo.runId);
        return json(res,200,{...demo,total,page,pages,pageSize:25,rows,counts});
      }
      if(url.pathname==='/api/demo/shared-plan'&&req.method==='POST'){
        requireRole(user,'owner');const result=mutate(s=>{
          const now=clock();let demo=s.sharedPlanDemo;
          if(demo&&s.trips.some(t=>t.demoRunId===demo.runId&&!['completed','cancelled'].includes(t.status)))return demo;
          const runId=D.id('pool-demo'),spots=CharlotteFleet.spots;
          const drivers=[4,7].map((seats,i)=>({id:D.id('pool-car'),name:'Charlotte '+seats+'-seat test car',phone:'+1555010880'+i,status:'online',seats,capabilities:[],vehicle:seats===7?'Seven passenger van':'Four passenger sedan',plate:'POOL TEST '+seats,demoRunId:runId,lat:spots[0].lat,lng:spots[0].lng,lastLocationAt:now}));s.drivers.push(...drivers);
          const trips=[2,2,3,4].map((passengers,i)=>({id:D.id('pool-booking'),reference:'POOL-TEST-'+(i+1),customerName:'Shared test customer '+(i+1),customerPhone:'+1555010770'+i,demoRunId:runId,pickup:spots[0].name,destination:spots[1].name,pickupAt:now+(10+i*2+(i===3?35:0))*60000,passengers,requirements:[],status:'awaiting_driver',driverId:null,redFlag:false,excluded:[],autoDispatch:false,createdAt:now}));s.trips.push(...trips);demo={runId,tripIds:trips.map(t=>t.id),driverIds:drivers.map(d=>d.id)};s.sharedPlanDemo=demo;return demo;
        });publish();return json(res,200,result);
      }
      if(url.pathname==='/api/vehicle-capacity'&&req.method==='POST'){
        requireRole(user,'owner');const b=await body(req);if(![4,7].includes(b.seats))throw Error('Choose 4 or 7 passenger seats');
        mutate(s=>{const d=s.drivers.find(d=>d.id===b.driverId);if(!d)throw Error('Driver not found');if(s.trips.some(t=>t.driverId===d.id&&!['completed','cancelled'].includes(t.status))||s.offers.some(o=>o.driverId===d.id&&o.status==='pending'))throw Error('Finish active work and offers before changing capacity');if(s.trips.some(t=>t.reservedDriverId===d.id&&t.passengers>b.seats))throw Error('This capacity is too small for a reserved ride');d.seats=b.seats;D.event(s,'vehicle.capacity_updated',null,user.name,d.name+' · '+b.seats+' passenger seats');});publish();return json(res,200,{ok:true});
      }
      if(url.pathname==='/api/vehicle-plan'&&req.method==='POST'){
        requireRole(user,'owner');const b=await body(req);if(!['preview','apply'].includes(b.action))throw Error('Choose preview or apply');
        const build = s => {
          if (b.runId === undefined) return VehiclePlanner.build(s,D.places,clock());
          if (b.runId !== null && !s.trips.some(t=>t.demoRunId===b.runId)) throw Error('Choose a valid dispatch queue.');
          const matches = item => (item.demoRunId || null) === b.runId;
          return VehiclePlanner.build({ ...s, trips:s.trips.filter(matches), drivers:s.drivers.filter(matches) },D.places,clock());
        };
        if(b.action==='preview')return json(res,200,build(load()));
        const plan=mutate(s=>{const p=build(s);VehiclePlanner.apply(s,p,user.name,clock());D.event(s,'plan.applied',null,user.name,p.summary.planned+' rides planned across '+p.summary.carsUsed+' cars');return p;});publish();return json(res,200,plan);
      }
      if (url.pathname === '/api/driver-day' && req.method === 'POST') {
        requireRole(user, 'owner');
        const b = await body(req);
        if (!['view','preview','save'].includes(b.action)) throw Error('Choose a driver day action.');
        if (b.action !== 'save') return json(res, 200, { day:DriverDay.view(load(),b,clock()) });
        const day = mutate(s => DriverDay.save(s,b,user.name,clock()));
        publish();
        return json(res, 200, { day });
      }
      if(url.pathname==='/api/driver/scheduled'&&req.method==='GET'){
        requireRole(user,'driver');return json(res,200,Reservations.scheduled(load(),user.driverId,D.places,clock(),Number(url.searchParams.get('page'))||1));
      }
      const reservationRoute=url.pathname.match(/^\/api\/trips\/([^/]+)\/(reserve|release-reservation)$/);
      if(reservationRoute&&req.method==='POST'){
        const b=await body(req);const result=mutate(s=>{const t=s.trips.find(t=>t.id===reservationRoute[1]);if(!t)throw Error('Trip not found');
          if(reservationRoute[2]==='reserve'){requireRole(user,'driver');const r=Reservations.reserve(s,t,user.driverId,D.places,clock());D.event(s,'reservation.created',t,user.name,'Provisional scheduled reservation');return r;}
          const r=Reservations.current(s,t.id);if(!r||!(user.role==='owner'||user.role==='driver'&&r.driverId===user.driverId))throw Error('Reservation not available to your account');
          if(!D.releaseReasons.includes(b.reason))throw Error('Choose a listed reason');Reservations.release(s,t,'released',b.reason,clock());D.event(s,'reservation.released',t,user.name,b.reason);return {ok:true};
        });publish();return json(res,200,result);
      }
      if(url.pathname==='/api/driver/last-ride'&&req.method==='POST'){
        requireRole(user,'driver');const b=await body(req);if(typeof b.enabled!=='boolean')throw Error('Choose enabled or disabled');
        mutate(s=>{const d=s.drivers.find(d=>d.id===user.driverId);if(d.status!=='busy')throw Error('This option is available during an assigned ride');d.finishThenOffline=b.enabled;});publish();return json(res,200,{ok:true});
      }
      const summaryRoute=url.pathname.match(/^\/api\/trips\/([^/]+)\/summary(\.txt)?$/);
      if(summaryRoute&&req.method==='GET'){
        const s=load(),report=RideService.summary(s,s.trips.find(t=>t.id===summaryRoute[1]),user);
        if(!summaryRoute[2])return json(res,200,report);
        res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':'attachment; filename="ProLift-ride-summary.txt"'});return res.end(RideService.summaryText(report));
      }
      if(url.pathname==='/api/support'&&req.method==='POST'){
        const b=await body(req);const result=mutate(s=>RideService.request(s,s.trips.find(t=>t.id===b.tripId),user,b,clock()));publish();return json(res,200,result);
      }
      const helpRoute=url.pathname.match(/^\/api\/support\/([^/]+)$/);
      if(helpRoute&&req.method==='POST'){
        requireRole(user,'owner');const b=await body(req);if(!['reviewing','resolved'].includes(b.status)||typeof b.reply!=='string'||b.reply.length>1000)throw Error('Choose a status and a reply up to 1000 characters');
        mutate(s=>{const r=s.supportRequests.find(r=>r.id===helpRoute[1]);if(!r)throw Error('Request not found');r.status=b.status;r.ownerReply=b.reply;r.updatedAt=clock();D.event(s,'support.updated',s.trips.find(t=>t.id===r.tripId),user.name,r.status);});publish();return json(res,200,{ok:true});
      }
      if (url.pathname === '/api/driver/status' && req.method === 'POST') {
        requireRole(user, 'driver'); const b = await body(req); if (!['online', 'offline'].includes(b.status)) throw new Error('Invalid driver status');
        mutate(s => { const d = s.drivers.find(d => d.id === user.driverId); if (d.status === 'busy') throw new Error('Finish or release your current trip first');
          if (b.status === 'offline') {
            d.trackingEnabled=false;
            for (const o of s.offers) if (o.driverId === d.id && o.status === 'pending') D.closeOffer(s,o,'declined',clock());
          }
          d.status = b.status; if(d.locationSource!=='device')d.lastLocationAt = clock(); }); publish(); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/book' && req.method === 'POST') {
        requireRole(user); if (!['customer','owner'].includes(user.role)) { const e=new Error('Customer or owner access required');e.status=403;throw e; } const b = await body(req);
        const key = String(req.headers['idempotency-key'] || '');
        if (!/^[a-zA-Z0-9-]{8,100}$/.test(key)) throw new Error('A request identifier is required');
        const scopedKey = hash(JSON.stringify(user) + ':booking:' + key), fingerprint = hash(JSON.stringify(b));
        const cached = db.prepare('SELECT * FROM requests WHERE key=?').get(scopedKey);
        if (cached) { if (cached.fingerprint !== fingerprint) throw new Error('Request identifier was reused for a different booking'); return json(res, 201, JSON.parse(cached.body)); }
        const rider = publicDemo ? { name: 'Alex Morgan', phone: '+15550102001' } :
          user.role === 'owner' ? { name: String(b.customerName||'').trim(), phone: String(b.customerPhone||'').trim() } : user;
        const rows = D.validateRows(load(), [{ trip_id: 'PL-' + crypto.randomBytes(3).toString('hex').toUpperCase(), pickup_at: String(b.pickupAt), customer_name: rider.name, customer_phone: rider.phone, pickup: b.pickup, destination: b.destination, passengers: String(b.passengers), requirements: b.requirements || '' }], clock());
        if (rows[0].errors.length) throw new Error(rows[0].errors.join('; '));
        const result = { tripId: rows[0].trip.id };
        mutate(s => { s.trips.push(rows[0].trip); D.event(s, 'trip.booked', rows[0].trip, user.name); db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(scopedKey, fingerprint, JSON.stringify(result), clock()); }); publish(); return json(res, 201, result);
      }
      const match = /^\/api\/trips\/([^/]+)\/action$/.exec(url.pathname);
      if (match && req.method === 'POST') {
        const b = await body(req), key = String(req.headers['idempotency-key'] || '');
        if (!/^[a-zA-Z0-9-]{8,100}$/.test(key)) throw new Error('A request identifier is required');
        const scopedKey = hash(JSON.stringify(user) + ':' + key), fingerprint = hash(req.url + JSON.stringify(b));
        const cached = db.prepare('SELECT * FROM requests WHERE key=?').get(scopedKey);
        if (cached) { if (cached.fingerprint !== fingerprint) throw new Error('Request identifier was reused for a different action'); return json(res, 200, JSON.parse(cached.body)); }
        if (roadRouting && user.role==='driver' && b.action==='accept') {
          const snapshot=load(), trip=snapshot.trips.find(t=>t.id===match[1]);
          const offer=snapshot.offers.find(o=>o.id===b.offerId && o.tripId===match[1] && o.driverId===user.driverId &&
            o.status==='pending' && o.expiresAt>clock());
          if (trip?.status==='offered' && offer && Road.requiresRoad(trip)) {
            const driver=snapshot.drivers.find(d=>d.id===user.driverId);
            const stop=(roadRouting.places||D.places).find(p=>p.name===trip.pickup);
            await roadRouting.prepareOffer(driver,stop,clock);
          }
        }
        const result = mutate(s => {
          // Another request can finish while a route quote is in flight.
          const prior=db.prepare('SELECT * FROM requests WHERE key=?').get(scopedKey);
          if(prior){
            if(prior.fingerprint!==fingerprint) throw Error('Request identifier was reused for a different action');
            return JSON.parse(prior.body);
          }
          D.action(s, s.trips.find(t => t.id === match[1]), b.action, user, b, clock());
          const result = { ok: true }; db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(scopedKey, fingerprint, JSON.stringify(result), clock()); return result; });
        publish(); return json(res, 200, result);
      }
      if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Endpoint not found' });
      const assets = { '/google-fleet-map.js':['google-fleet-map.js','text/javascript'], '/lgtc-view.js':['lgtc-view.js','text/javascript'], '/ride-explanation.js':['ride-explanation.js','text/javascript'], '/leaflet.js':['leaflet.js','text/javascript'], '/leaflet.css':['leaflet.css','text/css'], '/rider-view.js':['rider-view.js','text/javascript'], '/interface.css':['interface.css','text/css'], '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/board.js': ['board.js', 'text/javascript'], '/map-camera.js': ['map-camera.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
      const asset = assets[url.pathname]; if (!asset || req.method !== 'GET') return json(res, 404, { error: 'Not found' });
      res.writeHead(200, { 'Content-Type': asset[1] + '; charset=utf-8', 'Cache-Control': 'no-cache' });
      const contents = fs.readFileSync(path.join(__dirname, 'public', asset[0]));
      if (nonce && url.pathname === '/') return res.end(contents.toString().replace('<script src="/google-fleet-map.js"', '<style nonce="' + nonce + '"></style><script nonce="' + nonce + '" src="/google-fleet-map.js"'));
      res.end(contents);
    } catch (e) { if (!res.headersSent) json(res, e.status || 400, { error: e.message }); else res.end(); }
  });
  let working = false, closed = false;
  const worker = setInterval(async () => {
    if (working || closed) return;
    working = true;
    try {
      const now = clock();
      dispatchHealth.lastCheckAt=now;
      if (roadRouting) {
        const snapshot=load(), opens=now+Operations.settings(snapshot).dispatchLeadMinutes*60000;
        const due=snapshot.trips.filter(t=>t.autoDispatch&&!t.poolParentId&&['awaiting_driver','needs_reassignment','offered'].includes(t.status)&&
          t.pickupAt<=opens&&(t.pickupAt>=now-300000||t.recoveryUntil>=now))
          .sort((a,b)=>a.pickupAt-b.pickupAt);
        await roadRouting.prepare(snapshot,due,D.places,clock);
      }
      if (closed) return;
      const changed=mutate(s=>{
        const at=clock(), dispatch=D.tick(s,at), replay=TrackingReplay.tick(s,at), fleet=CharlotteFleet.tick(s,at);
        return dispatch||replay||fleet;
      });
      dispatchHealth.lastSuccessAt=clock(); dispatchHealth.lastError=null;
      if(changed||clock()-(dispatchHealth.lastPublishedAt||0)>=9000){dispatchHealth.lastPublishedAt=clock();publish();}
      if(roadRouting && await roadRouting.monitorPickups(load(),roadRouting.places||D.places,clock) && !closed) publish();
    } catch (e) {
      const previous=dispatchHealth.lastError;dispatchHealth.lastError=e.message;
      if(previous!==e.message)publish();
      console.error('Worker failed:',e.message);
    } finally { working=false; }
  },3000);
  worker.unref();
  const maintenance = setInterval(() => { const now = clock(); db.prepare('DELETE FROM sessions WHERE expires<?').run(now); db.prepare('DELETE FROM otp WHERE expires<?').run(now - 3600000); db.prepare('DELETE FROM requests WHERE at<?').run(now - 86400000); }, 60000); maintenance.unref();
  function close() {
    closed=true;clearInterval(worker);clearInterval(maintenance);
    for (const res of listeners.keys()) res.end();
    listeners.clear();db.close();
    if (pilot) for (const stop of pilot.stops) {
      const index=D.places.indexOf(stop);
      if(index!==-1) D.places.splice(index,1);
    }
  }
  return { server, close, load, mutate };
}
if (require.main === module && process.env.PROLIFT_HOSTED_DEMO === '1') {
  require('./start-demo.cjs').startDemo(createApp);
} else if (require.main === module) {
  const roadPilot=process.env.PROLIFT_DISPATCH_MODE==='road';
  const app = createApp(roadPilot ? {dbPath:path.join(__dirname,'data','prolift-road-pilot.sqlite')} : undefined), port = Number(process.env.PORT || 4720);
  app.server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log(roadPilot ? `ProLift road ETA pilot: ${url} — demo accounts; local only` :
      `ProLift demo: ${url} — simulated SMS and routes; local only`);
    if (process.argv.includes('--open') && process.platform === 'win32') require('node:child_process').execFile('explorer.exe', [url], () => {});
  });
  app.server.on('error', e => { console.error(e.message); app.close(); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { app.close(); app.server.close(() => process.exit()); });
}
module.exports = { createApp };
