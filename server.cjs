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
const { parseFile, workbook, xlsx } = require('./excel.cjs');
const { nextRideScenario } = require('./demo.cjs');
const Operations = require('./operations.cjs');
const LGTC = require('./lgtc.cjs');
const DriverDay = require('./driver-day.cjs');
const Road = require('./road-routing.cjs');
const Pilot = require('./road-pilot.cjs');
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function createApp({ dbPath, clock = () => Date.now(), automaticDispatch = true, initialSettings={}, roadMatrix, pilotConfig, hostedDemoPassword, hostedDemoInvite, publicDemo = false, sheetFile, fleetImportPath, advanceRideClock, claimTestOffer, ownerRecords } = {}) {
  const hostedDemo=publicDemo||hostedDemoPassword!==undefined;
  const privateDemo=hostedDemo&&!publicDemo;
  if (ownerRecords && !privateDemo) throw Error('MongoDB Owner records require private hosted mode.');
  if (sheetFile && (hostedDemo || pilotConfig || roadMatrix || !dbPath)) throw Error('Sheet testing requires a separate local database.');
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
  const rememberedPreviewAge = 14 * 24 * 60 * 60;
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
  const fleetDb = fleetImportPath ? new DatabaseSync(fleetImportPath) : db;
  fleetDb.exec('CREATE TABLE IF NOT EXISTS driver_profile_photos(driver_id TEXT PRIMARY KEY, jpeg BLOB NOT NULL, version TEXT NOT NULL)');
  fleetDb.exec('CREATE TABLE IF NOT EXISTS fleet_import_records(kind TEXT NOT NULL, record_key TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,record_key))');
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user TEXT NOT NULL,expires INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS otp(phone TEXT PRIMARY KEY,code TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER NOT NULL,sent INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS requests(key TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL);');
  const initial = D.seed(clock(),initialSettings);
  if (sheetFile) Object.assign(initial,{trips:[],customers:[]});
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
  let readSheetDetails, compareRiderHistory;
  function saveSheetDetails(batch) {
    const write = db.prepare('INSERT OR REPLACE INTO lgtc_sheet_legs VALUES(?,?,?,?,?,?,?,?)');
    const normalize = value => value.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    for (const row of batch.rows) {
      const source = batch.dispatchSource[row.row - 1];
      const details = { name:source.name, phone:source.phone, pickupAddress:source.pickupAddress,
        destinationAddress:source.destinationAddress, instructions:source.instructions, sourceFields:source.sourceFields };
      const routeKey = source.pickup && source.destination && row.from && row.to
        ? JSON.stringify([source.pickupAddress.map(normalize), source.destinationAddress.map(normalize)]) : null;
      write.run(batch.id,row.row,batch.sourceStamp,row.customerKey,row.serviceDate,row.reference,routeKey,JSON.stringify(details));
    }
  }
  if (sheetFile) {
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS lgtc_sheet_legs(
        schedule_id TEXT NOT NULL, source_row INTEGER NOT NULL, source_stamp TEXT NOT NULL,
        rider_key TEXT, service_date TEXT NOT NULL, reference TEXT NOT NULL, route_key TEXT, details TEXT NOT NULL,
        PRIMARY KEY(schedule_id,source_row));
        CREATE INDEX IF NOT EXISTS lgtc_sheet_rider ON lgtc_sheet_legs(rider_key,service_date);`);
      readSheetDetails = db.prepare('SELECT source_row,route_key,details FROM lgtc_sheet_legs WHERE schedule_id=? AND source_stamp=?');
      compareRiderHistory = db.prepare(`SELECT COUNT(DISTINCT service_date) AS priorDates,
        COUNT(DISTINCT CASE WHEN route_key=? THEN service_date END) AS sameRouteDates, MAX(service_date) AS lastDate
        FROM lgtc_sheet_legs WHERE rider_key=? AND service_date<? AND reference<>?`);
      const batch = LGTC.detect(sheetFile.filename, sheetFile.base64, lgtcKey, true);
      if (!batch) throw Error('Choose an LGTC CSV or Excel workbook.');
      const { dispatchSource, ...schedule } = batch;
      db.exec('BEGIN IMMEDIATE');
      const inserted = db.prepare('INSERT OR IGNORE INTO lgtc_schedules VALUES(?,?,?,?)')
        .run(batch.id, clock(), JSON.stringify(batch.summaries), JSON.stringify(schedule));
      if (!inserted.changes) {
        const { body } = db.prepare('SELECT body FROM lgtc_schedules WHERE id=?').get(batch.id);
        const saved = JSON.parse(body);
        if (saved.sourceStamp === batch.sourceStamp && saved.rows.some((row,i) =>
          JSON.stringify(row.instructionPolicy) !== JSON.stringify(batch.rows[i].instructionPolicy))) {
          saved.rows.forEach((row,i) => { row.instructionPolicy = batch.rows[i].instructionPolicy; });
          for (const draft of Object.values(saved.drafts || {})) draft.stale = true;
          saved.revision = (saved.revision ?? 0) + 1;
          db.prepare('UPDATE lgtc_schedules SET body=? WHERE id=?').run(JSON.stringify(saved),batch.id);
        }
      }
      const storedSchedule = JSON.parse(db.prepare('SELECT body FROM lgtc_schedules WHERE id=?').get(batch.id).body);
      const { complete } = db.prepare(`SELECT COUNT(*) AS complete FROM lgtc_sheet_legs
        WHERE schedule_id=? AND source_stamp=? AND json_array_length(details,'$.sourceFields')=38`).get(batch.id,batch.sourceStamp);
      if (storedSchedule.sourceStamp === batch.sourceStamp && complete !== batch.rows.length) saveSheetDetails(batch);
      db.exec('COMMIT');
    } catch (error) {
      db.close();
      throw error;
    }
  }
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
    id:d.id,name:d.name,vehicle:d.vehicle,seats:d.seats,accessible:d.capabilities.includes('wheelchair'),availability:d.availability
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
      'daily-staffing-v6',
      settings.driverIds.map(id => {
        const d = rosterById.get(id);
        return d && [d.id,d.name,d.vehicle,d.vehicleId,d.plate,d.seats,d.capabilities,
          d.driverDisabled,d.vehicleDisabled,d.rosterManaged,d.rosterServiceDate,LGTC.driverShift(d,date)];
      }),
      batch.rows.filter(r => r.serviceDate === date).map(r => preferences.get(r.customerKey) || null)
    ]));
  }
  function lgtcView(batch, data = lgtcData()) {
    const view = LGTC.scheduleView(batch, data.preferences);
    if (readSheetDetails && batch.sourceStamp) {
      const details = new Map(readSheetDetails.all(batch.id,batch.sourceStamp).map(row => [row.source_row,row]));
      const riderKeys = new Map(batch.rows.map(row => [row.row,row.customerKey]));
      view.rows = view.rows.map(row => {
        const stored = details.get(row.row);
        if (!stored) return row;
        const { name, pickupAddress, destinationAddress, instructions } = JSON.parse(stored.details);
        const sourceDetails = { name, pickupAddress, destinationAddress, instructions };
        const riderKey = riderKeys.get(row.row);
        const riderHistory = riderKey ? compareRiderHistory.get(stored.route_key,riderKey,row.serviceDate,row.reference) : null;
        return { ...row, sourceDetails, riderHistory };
      });
    }
    const defaults = lgtcAutomation();
    view.summaries = view.summaries.map(day => {
      const settings = batch.drafts?.[day.serviceDate]?.settings || defaults;
      const staffingRoster = settings.driverIds?.length ? data.roster.filter(driver => settings.driverIds.includes(driver.id)) : data.roster;
      const staffing = LGTC.uploadStaffing(view.rows.filter(row => row.serviceDate === day.serviceDate),day.serviceDate,staffingRoster,settings.buffer);
      return { ...day, staffing };
    });
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
  db.exec('CREATE TABLE IF NOT EXISTS driver_documents (driver_id TEXT, kind TEXT, payload TEXT NOT NULL, PRIMARY KEY(driver_id,kind))');
  const documentRows=db.prepare("SELECT driver_id,kind,json_extract(payload,'$.status') AS status,json_extract(payload,'$.expiresOn') AS expiresOn FROM driver_documents");
  const load = () => {
    const state = Operations.normalize(JSON.parse(db.prepare('SELECT body FROM state WHERE id=1').get().body));
    const documents=Object.groupBy(documentRows.all(),row=>row.driver_id);
    for(const driver of state.drivers){
      const records=documents[driver.id];
      driver.documentEligibility=records||fleetImportPath&&driver.id==='d2'?{
        license:records?.find(row=>row.kind==='license')?.status,
        expiresOn:records?.find(row=>row.kind==='license')?.expiresOn,
        contract:records?.find(row=>row.kind==='contract')?.status
      }:undefined;
    }
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
  if(automaticDispatch){mutate(s=>{for(const trip of s.trips)if(!trip.demoRunId&&!trip.willCall&&!trip.dispatchPaused&&['awaiting_driver','needs_reassignment','offered'].includes(trip.status))trip.autoDispatch=true;D.tick(s,clock());});dispatchHealth.lastCheckAt=clock();dispatchHealth.lastSuccessAt=clock();}
  const listeners = new Map(), limits = new Map();
  function clientState(user){
    const now=clock(),state=D.scoped(load(),user,now);
    if(user.role==='owner'){
      const photos = new Map(fleetDb.prepare('SELECT driver_id, version FROM driver_profile_photos').all().map(row=>[row.driver_id,row.version]));
      for (const driver of state.drivers) driver.profilePhotoVersion = photos.get(driver.id);
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
  function wakeWaitingRides(state, driverId, now) {
    const driver = state.drivers.find(candidate => candidate.id === driverId);
    if (driver?.status !== 'online') return 0;
    const opens = now + Operations.settings(state).dispatchLeadMinutes * 60000;
    let queued = 0;
    for (const ride of state.trips) {
      if (!ride.autoDispatch || ride.poolParentId || !['awaiting_driver','needs_reassignment'].includes(ride.status) ||
          ride.pickupAt > opens || (ride.pickupAt <= now-15*60000 && !(ride.recoveryUntil >= now)) ||
          !(ride.retryAt > now) || (!ride.dispatchError && !Road.requiresRoad(ride))) continue;
      if ((ride.demoRunId || null) !== (driver.demoRunId || null) || driver.seats < ride.passengers ||
          ride.excluded?.includes(driverId) || !ride.requirements.every(requirement => driver.capabilities.includes(requirement))) continue;
      const candidate = D.eligibility(state,ride,now).find(option => option.driver.id === driverId);
      if (!candidate?.eligible && !candidate?.roadPending) continue;
      ride.retryAt = now;
      queued++;
    }
    return queued;
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
  const previewLoginAssets = new Set(['/', '/api/config', '/api/session', '/app.js', '/board.js',
    '/styles.css', '/interface.css', '/favicon.svg', '/leaflet.js', '/leaflet.css', '/map-camera.js',
    '/rider-view.js', '/ride-explanation.js', '/lgtc-view.js', '/google-fleet-map.js']);
  const server = http.createServer(async (req, res) => {
    let needsPreviewAccess=false;
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
          const { token, username, password, rememberDevice } = await body(req) || {};
          const usingInvite = token !== undefined;
          const valid = usingInvite
            ? inviteDigest && typeof token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(token) &&
              crypto.timingSafeEqual(crypto.createHash('sha256').update(token).digest(), inviteDigest)
            : username === 'preview' && typeof password === 'string' &&
              crypto.timingSafeEqual(crypto.createHash('sha256').update('preview:' + password).digest(), previewDigest);
          if (!valid) {
            return json(res, 403, { error: usingInvite ? 'Invalid preview invite' : 'Check your username and password.' });
          }
          const sessionAge = ownerRecords && !usingInvite && rememberDevice === true ? rememberedPreviewAge : previewSessionAge;
          const expires = String(clock() + sessionAge * 1000);
          res.setHeader('Set-Cookie', `__Host-prolift_preview=${expires}.${previewSignature(expires).toString('hex')}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${sessionAge}`);
          return json(res, 200, { ok: true });
        } catch (error) {
          return json(res, error.status || 400, { error: error.message });
        }
      }
      const encoded=/^Basic ([A-Za-z0-9+/=]+)$/i.exec(req.headers.authorization||'')?.[1];
      const digest=encoded&&crypto.createHash('sha256').update(Buffer.from(encoded,'base64')).digest();
      if(!hasPreviewSession(req)&&(!digest||!crypto.timingSafeEqual(digest,previewDigest))){
        const pathname = req.url.split('?')[0];
        if (ownerRecords && req.method === 'GET' && previewLoginAssets.has(pathname)) needsPreviewAccess=true;
        else if (req.method === 'GET' && pathname === '/') {
          res.writeHead(302, { Location: '/preview', 'Cache-Control': 'no-store' });
          return res.end();
        }
        else return json(res,401,{error:'RoyalCab preview sign-in required'});
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
      if (ownerRecords && req.method === 'POST' && url.pathname === '/api/preview/forget') {
        const origin = req.headers.origin;
        if (req.headers['sec-fetch-site'] === 'cross-site' || (origin && new URL(origin).host !== req.headers.host)) {
          return json(res,403,{error:'Cross-site requests are not allowed'});
        }
        if (!String(req.headers['content-type']).startsWith('application/json')) return json(res,415,{error:'JSON request required'});
        res.setHeader('Set-Cookie','__Host-prolift_preview=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
        return json(res,200,{ok:true});
      }
      if (ownerRecords && req.method === 'GET' && url.pathname === '/owner/records') {
        requireRole(user,'owner');
        res.setHeader('Cache-Control','private, no-store');
        res.setHeader('Content-Security-Policy',"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'; base-uri 'none'");
        res.setHeader('X-Frame-Options','SAMEORIGIN');
        return await ownerRecords(url,res);
      }
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
      if (sheetFile && req.method === 'POST' && url.pathname.startsWith('/api/demo/')) {
        return json(res, 403, { error: 'This local session is using the imported schedule.' });
      }
      if (url.pathname === '/api/config' && req.method === 'GET') {
        const center=pilot?.stops[0];
        return json(res,200,{mode:pilot?'pilot':'demo',publicDemo,needsPreviewAccess,hostedWorkspace:!!ownerRecords,mongoOwnerRecords:!!ownerRecords&&!needsPreviewAccess&&user?.role==='owner',sheetOnly:!!sheetFile,dispatchMode:roadRouting?'road':'demo',
          map:{city:pilot?'Verified service area':'Charlotte, NC',center:center?[center.lat,center.lng]:[35.2271,-80.8431],
            zoom:13,googleKey:!needsPreviewAccess&&(!pilot||user)?mapKey||undefined:undefined},
          places:pilot?(user?pilot.stops:[]):D.places,declineReasons:D.declineReasons,releaseReasons:D.releaseReasons,
          drivers:pilot?[]:load().drivers.map(d=>({id:d.id,name:d.name,vehicle:d.vehicle})),
          providers:{maps:mapKey?'Google Maps':'OpenStreetMap',routing:roadRouting?'Google Routes road ETA pilot':'Simulated travel time',
            gps:'Foreground phone GPS',sms:pilot?'Delivery not configured':'Demo verification',storage:'SQLite (local)'}});
      }
      if (url.pathname === '/api/session' && req.method === 'GET') return json(res, 200, { user:needsPreviewAccess ? null : user });
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
      if (url.pathname === '/api/fleet/availability' && req.method === 'POST') {
        requireRole(user,'owner');
        const {driverId,kind,disabled} = await body(req);
        if (!['driver','vehicle'].includes(kind) || typeof disabled !== 'boolean') throw Error('Choose a valid fleet status.');
        mutate(state => {
          const driver = state.drivers.find(item=>item.id===driverId && !item.demoRunId);
          if (!driver) throw Error('Choose an operational driver.');
          const targets = kind==='vehicle' && driver.plate ? state.drivers.filter(item=>item.plate===driver.plate) : [driver];
          if (disabled && targets.some(item=>item.status==='busy' || state.offers.some(offer=>offer.driverId===item.id && offer.status==='pending' && offer.expiresAt>clock()))) throw Error('Finish active rides and resolve pending offers before disabling this resource.');
          for (const item of targets) item[kind==='driver'?'driverDisabled':'vehicleDisabled'] = disabled;
          D.event(state,'fleet.availability_changed',null,user.name,kind+' '+(disabled?'disabled':'enabled'));
        });
        publish();
        return json(res,200,{ok:true});
      }
      if (['/api/fleet-roster/validate','/api/fleet-roster/apply'].includes(url.pathname) && req.method === 'POST') {
        requireRole(user,'owner');
        if (publicDemo) return json(res,403,{error:'Roster validation is available in the owner workspace.'});
        const {filename,base64} = await body(req);
        if (typeof filename !== 'string' || !/\.xlsx$/i.test(filename) || typeof base64 !== 'string') throw Error('Choose the completed .xlsx roster.');
        const file = Buffer.from(base64,'base64');
        if (file.length > 5*1024*1024) throw Error('Maximum file size is 5 MB.');
        const {links,...report} = require('./fleet-roster.cjs').validateRoster(file);
        if (url.pathname.endsWith('/validate')) return json(res,200,report);
        if (report.issues.length || !links.length) throw Error('Resolve roster issues and include an eligible driver before applying.');
        mutate(state => {
          const roster = state.drivers.filter(driver=>!driver.demoRunId);
          if (links.some(link=>!roster.some(driver=>driver.id===link.id))) throw Error('Each enabled account ID must match an existing operational driver.');
          if (state.trips.some(ride=>ride.driverId&&!['completed','cancelled'].includes(ride.status)) ||
              state.offers.some(offer=>offer.status==='pending'&&offer.expiresAt>clock())) throw Error('Resolve active rides and offers before applying a roster.');
          if ((state.reservations||[]).some(reservation=>reservation.status==='reserved')) throw Error('Release existing reservations before applying a roster.');
          const savedStatus = fleetDb.prepare('SELECT payload FROM fleet_import_records WHERE kind=? AND record_key=?');
          const disabledRecord = (kind,key,field) => key &&
            JSON.parse(savedStatus.get(kind,key)?.payload || '{}')[field] === 'Disabled';
          for (const link of links) {
            const driver = roster.find(item=>item.id===link.id);
            if (disabledRecord('vehicle',link.vin,'Vehicle Status') ||
                disabledRecord('driver',driver.importedDriver,'Driver Status')) {
              throw Error('Remove disabled drivers and vehicles before applying the roster.');
            }
          }
          for (const driver of roster) {
            const link = links.find(item=>item.id===driver.id);
            driver.driverDisabled = !link;
            if (!link) continue;
            const startAt=LGTC.easternPickup(link.day,link.start), endAt=LGTC.easternPickup(link.day,link.end);
            if (!startAt || !endAt || endAt<=startAt) throw Error('Choose an unambiguous Eastern shift.');
            driver.vehicleId=link.vin;
            driver.vehicleDisabled=false;
            driver.seats=link.seats;
            driver.capabilities=driver.capabilities.filter(value=>value!=='wheelchair');
            if (link.wheelchair) driver.capabilities.push('wheelchair');
            driver.availability={...driver.availability,[link.day]:{start:link.start,end:link.end,startAt,endAt}};
            driver.rosterManaged=true;
            delete driver.rosterServiceDate;
          }
          D.event(state,'fleet.roster_applied',null,user.name,String(links.length)+' eligible links');
        });
        publish();
        return json(res,200,report);
      }
      if (url.pathname === '/api/fleet-setup' && req.method === 'POST') {
        requireRole(user,'owner');
        if (publicDemo) return json(res,403,{error:'Fleet setup is available in the private owner workspace.'});
        const input = await body(req);
        const entries = input.entries ?? [input];
        if (!Array.isArray(entries) || !entries.length || entries.length>500 ||
            entries.some(entry=>!entry || typeof entry.driverId!=='string') ||
            new Set(entries.map(entry=>entry.driverId)).size!==entries.length) throw Error('Include each driver account once, up to 500 accounts.');
        const record = (kind,key) => fleetDb.prepare('SELECT payload FROM fleet_import_records WHERE kind=? AND record_key=?').get(kind,key);
        mutate(state=>{
        for (const [index,entry] of entries.entries()) {
        try {
        const {driverId,importedDriver,vin,seats,accessible,days,start,end} = entry;
        const vehicleRecord = typeof vin==='string' && /^[A-HJ-NPR-Z0-9]{17}$/.test(vin) && record('vehicle',vin);
        const vehicle = vehicleRecord && JSON.parse(vehicleRecord.payload);
        if (!vehicle || vehicle['Vehicle Status']?.toLowerCase()!=='enabled') throw Error('Choose an enabled imported vehicle.');
        if (typeof importedDriver!=='string' || !record('driver',importedDriver) || JSON.parse(record('driver',importedDriver).payload)['Driver Status']==='Disabled') throw Error('Choose an enabled imported driver.');
        if (!Number.isInteger(seats) || seats<1 || seats>7 || typeof accessible!=='boolean') throw Error('Confirm passenger seats and accessibility.');
        if (!Array.isArray(days) || !days.length || new Set(days).size!==days.length || days.some(day=>!Number.isInteger(day)||day<0||day>6) ||
            !Number.isInteger(start) || !Number.isInteger(end) || start<0 || end>1440 || start>=end) throw Error('Choose weekdays and valid same-day Eastern shift hours.');
          const driver=state.drivers.find(item=>item.id===driverId&&!item.demoRunId);
          if (!driver) throw Error('Choose an operational driver account.');
          if (state.drivers.some(item=>item.id!==driverId&&(item.vehicleId===vin||item.importedDriver===importedDriver))) throw Error('This vehicle or imported driver is already linked.');
          if (state.trips.some(ride=>ride.driverId===driverId&&!['completed','cancelled'].includes(ride.status)) ||
              state.offers.some(offer=>offer.driverId===driverId&&offer.status==='pending'&&offer.expiresAt>clock()) ||
              state.reservations?.some(reservation=>reservation.driverId===driverId&&reservation.status==='reserved')) throw Error('Resolve this driver’s active rides, offers and reservations before editing their fleet setup.');
          Object.assign(driver,{vehicleId:vin,importedDriver,seats,rosterManaged:true,recurringShift:{days,start,end},
            vehicle:[vehicle.Make,vehicle.Model].filter(Boolean).join(' ')||vehicle['Vehicle Name']||vin,
            plate:vehicle['License Plate Number']||vehicle['License Plate']||''});
          driver.capabilities=driver.capabilities.filter(value=>value!=='wheelchair');
          if (accessible) driver.capabilities.push('wheelchair');
          delete driver.rosterServiceDate;
          D.event(state,'fleet.setup_saved',null,user.name,driver.name);
        } catch(error) { throw Error('Fleet row '+(index+1)+'. '+error.message); }
        }
        });
        publish();
        return json(res,200,{saved:true,count:entries.length});
      }
      if(url.pathname==='/api/driver-documents'&&['GET','POST'].includes(req.method)){
        requireRole(user);
        if(hostedDemo||!['driver','owner'].includes(user.role))return json(res,403,{error:'Driver documents are unavailable.'});
        const id=user.role==='driver'?user.driverId:url.searchParams.get('driver');
        if(!load().drivers.some(d=>d.id===id))return json(res,404,{error:'Driver not found.'});
        db.exec('CREATE TABLE IF NOT EXISTS driver_documents (driver_id TEXT, kind TEXT, payload TEXT NOT NULL, PRIMARY KEY(driver_id,kind))');
        if(req.method==='POST'){
          const {kind,action,file,reason,expiresOn}=await body(req);
          if(!['license','contract'].includes(kind))throw Error('Choose a document.');
          let record;
          if(action==='upload'){
            const match=/^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/.exec(file);
            if(!match||kind==='license'&&match[1]==='application/pdf'||Buffer.from(match[2],'base64').length>2000000)throw Error('Choose an image or supported PDF up to 2 MB.');
            if(fleetImportPath){
              const sample=fs.readFileSync(path.join(__dirname,'examples',kind==='license'?'sample-license.png':'sample-contract.pdf'));
              if(!Buffer.from(match[2],'base64').equals(sample))throw Error('The shared demo accepts only the supplied sample files.');
            }
            if(kind==='license'&&(!/^\d{4}-\d{2}-\d{2}$/.test(expiresOn||'')||
               !Number.isFinite(Date.parse(expiresOn))||new Date(expiresOn).toISOString().slice(0,10)!==expiresOn))throw Error('Enter a valid license expiration date.');
            record={file,...(kind==='license'&&{expiresOn}),status:'Pending review',uploadedBy:user.name,uploadedAt:clock()};
          }else{
            requireRole(user,'owner');
            if(!['approve','correct'].includes(action)||action==='correct'&&!(typeof reason==='string'&&reason.trim()&&reason.length<=500))throw Error('Enter a correction reason.');
            record=JSON.parse(db.prepare('SELECT payload FROM driver_documents WHERE driver_id=? AND kind=?').get(id,kind)?.payload||'null');
            if(!record)throw Error('Upload a document first.');
            Object.assign(record,{status:action==='approve'?'Approved':'Needs correction',reason:action==='correct'?reason.trim():'',reviewedBy:user.name,reviewedAt:clock()});
          }
          db.prepare('INSERT INTO driver_documents VALUES(?,?,?) ON CONFLICT(driver_id,kind) DO UPDATE SET payload=excluded.payload').run(id,kind,JSON.stringify(record));
        }
        const documents=Object.fromEntries(db.prepare('SELECT kind,payload FROM driver_documents WHERE driver_id=?').all(id).map(row=>[row.kind,JSON.parse(row.payload)]));
        return json(res,200,{documents});
      }
      if (url.pathname === '/api/driver-profile-photo' && ['GET','POST'].includes(req.method)) {
        requireRole(user,'owner');
        const input = req.method === 'POST' ? await body(req) : Object.fromEntries(url.searchParams);
        const driverId = input.driverId;
        if (!load().drivers.some(driver=>driver.id===driverId)) return json(res,404,{error:'Driver not found'});
        if (req.method === 'GET') {
          const photo = fleetDb.prepare('SELECT jpeg FROM driver_profile_photos WHERE driver_id=?').get(driverId);
          if (!photo) return json(res,404,{error:'Photo not found'});
          res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'private, no-store'});
          return res.end(Buffer.from(photo.jpeg));
        }
        const match = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/.exec(String(input.photo||''));
        const jpeg = match && match[1].length <= 140000 && Buffer.from(match[1],'base64');
        if (!jpeg || jpeg.length < 5 || !jpeg.subarray(0,3).equals(Buffer.from([255,216,255])) ||
          !jpeg.subarray(-2).equals(Buffer.from([255,217]))) return json(res,400,{error:'Choose a valid JPEG profile photo'});
        fleetDb.prepare('INSERT INTO driver_profile_photos VALUES(?,?,?) ON CONFLICT(driver_id) DO UPDATE SET jpeg=excluded.jpeg,version=excluded.version')
          .run(driverId,jpeg,require('node:crypto').randomUUID());
        publish();
        return json(res,200,{ok:true});
      }
      if (url.pathname === '/api/fleet-record' && req.method === 'POST') {
        requireRole(user,'owner');
        if(publicDemo||hostedDemo) return json(res,403,{error:'Use the private Owner workspace.'});
        const input=await body(req);
        const clean=(value,max)=>typeof value==='string'?value.trim().slice(0,max):'';
        const name=clean(input.name,100);
        const vehicle=input.kind==='vehicle';
        if(!name||!['vehicle','driver'].includes(input.kind))throw Error('Enter a record name.');
        const vin=clean(input.vin,17).toUpperCase();
        if(vehicle&&!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin))throw Error('Enter a valid 17-character VIN.');
        if(fleetImportPath&&(input.license||input.contract))throw Error('Use a private Owner workspace for driver documents.');
        function attachment(value,pdfAllowed){
          if(!value)return undefined;
          const match=/^data:(image\/(?:jpeg|png|webp)|application\/pdf);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
          if(!match||(!pdfAllowed&&match[1]==='application/pdf'))throw Error('Choose a JPEG, PNG, WebP'+(pdfAllowed?' or PDF':'')+' file.');
          const bytes=Buffer.from(match[2],'base64');
          const valid=match[1]==='image/jpeg'?bytes.subarray(0,3).equals(Buffer.from([255,216,255])):
            match[1]==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
            match[1]==='image/webp'?bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP':
            bytes.toString('ascii',0,5)==='%PDF-';
          if(!valid||bytes.length>2000000)throw Error('Choose a valid file of up to 2 MB.');
          return value;
        }
        const files=vehicle?{photo:attachment(input.photo,false)}:{license:attachment(input.license,false),contract:attachment(input.contract,true)};
        const item=vehicle?{'Vehicle Name':name,'Vehicle Identification Number (VIN)':vin,Year:clean(input.year,4),Make:clean(input.make,60),Model:clean(input.model,60),'Vehicle Status':input.status==='Disabled'?'Disabled':'Enabled'}:{name};
        const key=vehicle?vin:name.toLowerCase();
        if(fleetDb.prepare('SELECT 1 FROM fleet_import_records WHERE kind=? AND record_key=?').get(input.kind,key))throw Error('This fleet record already exists.');
        fleetDb.exec('CREATE TABLE IF NOT EXISTS fleet_attachments(kind TEXT, record_key TEXT, payload TEXT, PRIMARY KEY(kind,record_key))');
        fleetDb.exec('BEGIN IMMEDIATE');
        try{
          fleetDb.prepare('INSERT INTO fleet_import_records VALUES(?,?,?)').run(input.kind,key,JSON.stringify(item));
          fleetDb.prepare('INSERT INTO fleet_attachments VALUES(?,?,?)').run(input.kind,key,JSON.stringify(files));
          fleetDb.exec('COMMIT');
        }catch(error){fleetDb.exec('ROLLBACK');throw error;}
        return json(res,201,{saved:true});
      }
      if (url.pathname === '/api/fleet-record/status' && req.method === 'POST') {
        requireRole(user,'owner');
        const {kind,key,disabled} = await body(req);
        if (!['driver','vehicle'].includes(kind) || typeof key!=='string' || typeof disabled!=='boolean') throw Error('Choose a valid fleet status.');
        const record = fleetDb.prepare('SELECT payload FROM fleet_import_records WHERE kind=? AND record_key=?').get(kind,key);
        if (!record) return json(res,404,{error:'Fleet record not found.'});
        const field = kind==='driver'?'Driver Status':'Vehicle Status';
        const payload = JSON.parse(record.payload);
        mutate(state=>{
          const linked = state.drivers.filter(d=>(kind==='driver'?d.importedDriver:d.vehicleId)===key);
          if (disabled && linked.some(d=>d.status==='busy'||state.offers.some(o=>o.driverId===d.id&&o.status==='pending'&&o.expiresAt>clock()))) {
            throw Error('Finish active rides and resolve pending offers before disabling this resource.');
          }
          for (const driver of linked) driver[kind+'Disabled'] = disabled;
          payload[field] = disabled?'Disabled':'Enabled';
          fleetDb.prepare('UPDATE fleet_import_records SET payload=? WHERE kind=? AND record_key=?').run(JSON.stringify(payload),kind,key);
          D.event(state,'fleet.availability_changed',null,user.name,kind+' '+payload[field].toLowerCase());
        });
        publish();
        return json(res,200,{status:payload[field]});
      }
      if(url.pathname==='/api/fleet-record'&&req.method==='GET'){
        requireRole(user,'owner');
        const kind=url.searchParams.get('kind'), key=url.searchParams.get('key');
        const table=fleetDb.prepare("SELECT 1 FROM sqlite_master WHERE name='fleet_attachments'").get();
        const files=table?JSON.parse(fleetDb.prepare('SELECT payload FROM fleet_attachments WHERE kind=? AND record_key=?').get(kind,key)?.payload||'{}'):{};
        return json(res,200,{files:fleetImportPath||publicDemo||hostedDemo?{photo:files.photo}:files});
      }
      if (url.pathname === '/api/fleet-import' && ['GET','POST'].includes(req.method)) {
        requireRole(user,'owner');
        if (publicDemo || fleetImportPath && req.method === 'POST') return json(res,403,{error:'Fleet uploads are available in the private owner workspace.'});
        if (req.method === 'GET') {
          const counts = fleetDb.prepare('SELECT kind, COUNT(*) AS total FROM fleet_import_records GROUP BY kind').all();
          const records = url.searchParams.get('list') === '1' ? fleetDb.prepare('SELECT kind, payload FROM fleet_import_records ORDER BY kind, record_key').all().map(row=>({kind:row.kind,...JSON.parse(row.payload)})) : undefined;
          return json(res,200,{counts,records});
        }
        const {filename, base64} = await body(req);
        if (typeof filename !== 'string' || !/\.xlsx$/i.test(filename) || typeof base64 !== 'string') throw Error('Choose an Excel .xlsx file.');
        const file = Buffer.from(base64,'base64');
        if (file.length > 5*1024*1024) throw Error('Maximum file size is 5 MB.');
        const rows = xlsx(file);
        const headerIndex = rows.findIndex(row => row.some(value => ['Vehicle Identification Number (VIN)','Driver Name'].includes(String(value).trim())));
        if (headerIndex < 0) throw Error('Include a VIN or Driver Name column.');
        const headers = rows[headerIndex].map(value => String(value).trim());
        const records = [];
        for (const row of rows.slice(headerIndex+1)) {
          if (!row.some(value => String(value ?? '').trim())) continue;
          const item = Object.fromEntries(headers.flatMap((name,index)=>name ? [[name,String(row[index] ?? '').trim()]] : []));
          if (Object.values(item).includes('#FORMULA_NOT_ALLOWED')) throw Error('Replace formulas with values before importing.');
          const vin = item['Vehicle Identification Number (VIN)']?.toUpperCase();
          const name = item['Driver Name'] || item['Last Known Driver'];
          if (!vin && !name) throw Error('Each row must include a VIN or driver name.');
          if (vin) records.push(['vehicle',vin,JSON.stringify(item)]);
          if (name) records.push(['driver',name.toLowerCase(),JSON.stringify({name,...(!vin && item)})]);
        }
        if (!records.length) throw Error('The file contains no fleet records.');
        const save = fleetDb.prepare('INSERT INTO fleet_import_records VALUES (?,?,?) ON CONFLICT(kind,record_key) DO UPDATE SET payload=excluded.payload');
        fleetDb.exec('BEGIN');
        try {
          for (const record of records) save.run(...record);
          fleetDb.exec('COMMIT');
        } catch (error) {
          fleetDb.exec('ROLLBACK');
          throw error;
        }
        return json(res,200,{counts:fleetDb.prepare('SELECT kind, COUNT(*) AS total FROM fleet_import_records GROUP BY kind').all()});
      }
      if (url.pathname === '/api/trips/bulk' && req.method === 'POST') {
        requireRole(user,'owner');
        const { action, ids, driverId, pickupAt } = await body(req);
        if (!['assign','unassign','will-call'].includes(action) || !Array.isArray(ids) || !ids.length ||
            ids.length > 25 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) {
          throw Error('Select up to 25 rides and a bulk action.');
        }
        const now = clock();
        if (action === 'will-call' && pickupAt !== null && (!Number.isSafeInteger(pickupAt) || pickupAt <= now)) {
          throw Error('Choose a future pickup time or mark the rides as will-call.');
        }
        mutate(s => {
          for (const id of ids) {
            const ride = s.trips.find(item => item.id === id);
            try {
              if (!ride || ride.isSharedRun || ride.poolParentId) throw Error('Choose an individual ride.');
              if (action === 'assign') {
                if (ride.willCall) throw Error('Confirm the will-call pickup first.');
                if (ride.status === 'awaiting_driver' && ride.pickupAt > now + Operations.settings(s).dispatchLeadMinutes * 60000) {
                  Reservations.reserve(s,ride,driverId,pilot?.stops || D.places,now);
                  ride.autoDispatch = true;
                  D.event(s,'dispatch.bulk_reserved',ride,user.name);
                } else {
                  D.action(s,ride,'manual_offer',user,{driverId,reason:'Owner reviewed availability'},now);
                }
                delete ride.dispatchPaused;
              } else {
                if (action === 'will-call' && pickupAt !== null && !ride.willCall) throw Error('Only will-call rides can be given a confirmed pickup here.');
                D.action(s,ride,action === 'unassign' ? 'bulk_unassign' : 'bulk_will_call',user,{pickupAt},now);
                ride.dispatchPaused = action === 'unassign';
              }
            } catch (error) {
              throw Error((ride?.reference || 'Selected ride') + ': ' + error.message);
            }
          }
        });
        publish();
        return json(res,200,{count:ids.length});
      }
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
        const batch = LGTC.detect(b.filename, b.base64, lgtcKey, !!sheetFile);
        if (!batch || b.id !== batch.id) throw Error('Upload and review this LGTC export before saving.');
        const { dispatchSource, ...schedule } = batch;
        db.exec('BEGIN IMMEDIATE');
        try {
          db.prepare('INSERT OR IGNORE INTO lgtc_schedules VALUES(?,?,?,?)')
            .run(batch.id, clock(), JSON.stringify(batch.summaries), JSON.stringify(schedule));
          if (sheetFile) saveSheetDetails(batch);
          db.exec('COMMIT');
        } catch (error) {
          db.exec('ROLLBACK');
          throw error;
        }
        const saved = readLGTC(batch.id);
        const identitiesChanged = saved.rows.some((row,i) => row.customerKey !== batch.rows[i].customerKey);
        const instructionsChanged = saved.rows.some((row,i) =>
          JSON.stringify(row.instructionPolicy) !== JSON.stringify(batch.rows[i].instructionPolicy));
        const sourceChanged = saved.sourceStamp !== batch.sourceStamp;
        const automation = lgtcAutomation();
        const automaticDates = automation.enabled ? saved.dates.filter(date => !saved.drafts?.[date]) : [];
        if (sourceChanged || identitiesChanged || instructionsChanged || automaticDates.length) {
          const { batch:updated, result } = editLGTC({id:saved.id,revision:saved.revision ?? 0}, schedule => {
            if (sourceChanged || identitiesChanged || instructionsChanged) {
              schedule.sourceStamp = batch.sourceStamp;
              schedule.rows.forEach((row,i) => {
                row.customerKey = batch.rows[i].customerKey;
                row.instructionPolicy = batch.rows[i].instructionPolicy;
              });
              for (const draft of Object.values(schedule.drafts || {})) draft.stale = true;
            }
            const data = lgtcData(), autoPlanned = [];
            let autoError;
            for (const serviceDate of automaticDates) {
              try {
                const driverIds = automation.driverIds.filter(id => data.roster.some(d=>d.id===id&&!d.driverDisabled&&!d.vehicleDisabled));
                if (!driverIds.length) throw Error('No enabled drivers with enabled vehicles in the configured fleet.');
                const plan = LGTC.plan(schedule, { ...automation, driverIds, serviceDate },data);
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
        if (!source || source.id !== b.id) throw Error('Choose the original file for this saved schedule.');
        const prepare = state => {
          const schedule = readLGTC(b.id);
          if (b.revision !== (schedule.revision ?? 0)) {
            const error = Error('The day plan changed. Reopen it before approving.');
            error.status = 409;
            throw error;
          }
          if (!schedule.sourceStamp || source.sourceStamp !== schedule.sourceStamp) {
            throw Error('This file does not match the saved upload. Save the original file and rebuild the day plan.');
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
      if (url.pathname === '/api/lgtc/review-repeated-notes' && req.method === 'POST') {
        requireRole(user,'owner');
        if (!readSheetDetails) return json(res,404,{error:'Repeated-note review is available in the local workbook session.'});
        const input = await body(req);
        const noteKey = notes => JSON.stringify(notes.map(note => note.trim().replace(/\s+/g,' ').toLowerCase()).sort());
        const { batch, result } = editLGTC(input,schedule => {
          const source = new Map(readSheetDetails.all(schedule.id,schedule.sourceStamp)
            .map(item => [item.source_row,JSON.parse(item.details).instructions]));
          const reference = schedule.rows.find(row => row.row === input.row && row.serviceDate === input.serviceDate);
          const notes = source.get(reference?.row);
          if (!notes?.length) throw Error('Choose a ride with workbook instructions.');
          if (notes.some(note => /wheel[\s-]*chair|walker|stretcher|scooter|ramp|attendant|escort|companion|passengers?|extra seat|oxygen/i.test(note))) {
            throw Error('Review vehicle, mobility, or passenger requirements on each ride.');
          }
          const key = noteKey(notes);
          const matching = schedule.rows.filter(row => row.serviceDate === input.serviceDate && row.hasNotes &&
            row.instructionPolicy?.needsReview !== false && !schedule.reviews?.[row.row]?.notesReviewed &&
            source.has(row.row) && noteKey(source.get(row.row)) === key);
          if (matching.length < 2 || matching.length !== input.count) throw Error('The matching rides changed. Reopen the schedule and review again.');
          schedule.reviews ??= {};
          for (const row of matching) schedule.reviews[row.row] = {
            start:null,end:null,mode:'',seats:null,...schedule.reviews[row.row],notesReviewed:true,
          };
          if (schedule.drafts?.[input.serviceDate]) schedule.drafts[input.serviceDate].stale = true;
          return matching.length;
        });
        return json(res,200,{batch,count:result});
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
          if (result.accepted.length) wakeWaitingRides(s,user.driverId,now);
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
          const becameAvailable = d.status !== 'online' && b.status === 'online';
          d.status = b.status;
          const now = clock();
          if (d.locationSource !== 'device') d.lastLocationAt = now;
          if (becameAvailable) wakeWaitingRides(s,d.id,now);
        }); publish(); return json(res, 200, { ok: true });
      }
      if (url.pathname === '/api/driver/availability' && req.method === 'POST') {
        requireRole(user);
        if (!['owner','driver'].includes(user.role)) return json(res,403,{error:'Owner or driver access required.'});
        const { serviceDate, selection, start, end, driverId } = await body(req);
        const targetId = user.role === 'owner' ? driverId : user.driverId;
        if (typeof serviceDate !== 'string' || !/^20\d\d-\d\d-\d\d$/.test(serviceDate) || LGTC.easternPickup(serviceDate,720) === null) {
          throw Error('Choose a valid date.');
        }
        if (!['hours','unavailable','clear'].includes(selection)) throw Error('Choose how you are available.');
        let shift;
        if (selection === 'unavailable') shift = { unavailable:true };
        if (selection === 'hours') {
          const clockMinutes = value => /^([01]\d|2[0-3]):[0-5]\d$/.test(value || '')
            ? Number(value.slice(0,2))*60 + Number(value.slice(3)) : null;
          const from = clockMinutes(start), to = clockMinutes(end);
          const startAt = LGTC.easternPickup(serviceDate,from), endAt = LGTC.easternPickup(serviceDate,to);
          if (startAt === null || endAt === null || endAt <= startAt) throw Error('Enter a start and end time on the same date. End must be after start.');
          shift = { start:from, end:to, startAt, endAt };
        }
        mutate(s => {
          const driver = s.drivers.find(d => d.id === targetId && (user.role === 'driver' || !d.demoRunId));
          if (!driver) throw Error('Driver not found.');
          driver.availability ??= {};
          if (shift) driver.availability[serviceDate] = shift;
          else delete driver.availability[serviceDate];
          wakeWaitingRides(s,driver.id,clock());
        });
        publish();
        return json(res,200,{ ok:true });
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
        if (claimTestOffer && user.role === 'driver' && b.action === 'accept') {
          const snapshot = load();
          D.action(snapshot, snapshot.trips.find(t => t.id === match[1]), b.action, user, b, clock());
          await claimTestOffer(match[1], user.driverId);
        }
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
          const ride=s.trips.find(t=>t.id===match[1]);
          D.action(s,ride,b.action,user,b,advanceRideClock?.(ride,b.action,user) ?? clock());
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
    listeners.clear();if (fleetDb !== db) fleetDb.close();db.close();
    if (pilot) for (const stop of pilot.stops) {
      const index=D.places.indexOf(stop);
      if(index!==-1) D.places.splice(index,1);
    }
  }
  return { server, close, load, mutate, publish };
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






