const { createHash } = require('node:crypto');
const { sameVehicle } = require('./reservations.cjs');

function csv(text) {
  const rows = [];
  let row = [], field = '', quoted = false, closed = false;
  const nextField = () => { row.push(field.trim()); field = ''; closed = false; };
  const nextRow = () => {
    nextField();
    if (row.length > 1 || row[0]) rows.push(row);
    if (rows.length > 1000) throw Error('Import up to 1,000 LGTC trip legs at a time.');
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else field += c;
    } else if (c === ',') nextField();
    else if (c === '\n' || c === '\r') { nextRow(); if (c === '\r' && text[i + 1] === '\n') i++; }
    else if (c === '"' && !closed && !field.trim()) { field = ''; quoted = true; }
    else if (closed && /[ \t]/.test(c)) continue;
    else if (closed || c === '"') throw Error('Malformed CSV quotation near record ' + (rows.length + 1) + '.');
    else field += c;
  }
  if (quoted) throw Error('Unclosed CSV quotation near record ' + (rows.length + 1) + '.');
  if (row.length || field || closed) nextRow();
  return rows;
}

function date(value) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(20\d{2})$/.exec(value);
  if (!m) return null;
  const iso = m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
  const d = new Date(iso);
  return Number.isFinite(+d) && d.toISOString().slice(0, 10) === iso ? iso : null;
}
function minutes(value) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)(?::00)?$/.exec(value);
  return m ? +m[1] * 60 + +m[2] : null;
}
function locality(city, state) {
  return /^[a-z .'-]{1,40}$/i.test(city) && /^[A-Z]{2}$/.test(state) ? city + ', ' + state : null;
}
function identity(name, phone) {
  const digits = String(phone || '').replace(/[\s().+-]/g, '').replace(/^1(?=\d{10}$)/, '');
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(digits) || /^(\d)\1+$/.test(digits)) return null;
  const words = String(name || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[a-z0-9]+/g);
  return words?.length ? digits + ':' + words.sort().join(' ') : null;
}
function detect(filename, base64, customerKey, includeDispatchSource = false) {
  if (!/\.csv$/i.test(filename || '') || typeof base64 !== 'string') return null;
  if (base64.length > 7000000) throw Error('File must be 5 MB or smaller.');
  const buffer = Buffer.from(base64, 'base64');
  const source = buffer.toString('utf8').replace(/^\uFEFF/, '');
  if (!/^\s*"?MCD\d+"?\s*,/i.test(source) && !/^LGTC[_ -]/i.test(filename)) return null;
  if (buffer.length > 5 * 1024 * 1024) throw Error('File must be 5 MB or smaller.');
  const records = csv(source);
  if (!records.length) throw Error('This LGTC export is empty.');
  const keys = new Set();
  const rows = records.map((r, i) => {
    const row = i + 1, program = r[0]?.toUpperCase(), serviceDate = date(r[2]), code = r[3]?.toUpperCase();
    if (r.length !== 38) throw Error('LGTC record ' + row + ' has ' + r.length + ' fields; expected 38.');
    if (!/^MCD\d{1,3}$/.test(program) || !serviceDate || !/^[A-Z0-9]{1,4}$/.test(code) ||
        !/^\d{1,12}-\d{1,16}-[A-Z]$/i.test(r[1])) throw Error('LGTC record ' + row + ' has an invalid program, reference, date or service code.');
    const reference = r[1].toUpperCase(), key = [program, serviceDate, reference].join(':');
    if (keys.has(key)) throw Error('Duplicate trip reference at LGTC record ' + row + '.');
    keys.add(key);
    const start = minutes(r[14]), end = minutes(r[23]);
    const from = locality(r[10], r[11]), to = locality(r[19], r[20]);
    const notes = r.slice(34, 37).filter(Boolean).join(' ');
    const issues = [];
    if (!start || !end) issues.push('Missing or zero scheduled time');
    else if (end <= start) issues.push('End must follow pickup');
    if (!from || !to || !r[7] || !r[16]) issues.push('Incomplete stops');
    if (/\bwill[\s-]*call\b/i.test(notes)) issues.push('Will-call: confirm a pickup time');
    return { row, reference, group: reference.slice(0, -2), program, serviceDate, code, start, end, from, to,
      additionalTime: minutes(r[24]) || null,
      sourceCounts: r.slice(29, 32).map(v => /^\d{1,3}$/.test(v) ? +v : null),
      miles: /^\d{1,5}(?:\.\d{1,3})?$/.test(r[33]) ? +r[33] : null,
      hasNotes: !!notes, issues };
  });
  // Hash only the planning projection: no raw file, names, addresses, contacts, or note text are retained.
  const id = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
  if (customerKey) rows.forEach((row, i) => {
    const value = identity(records[i][4], records[i][28]);
    row.customerKey = value ? customerKey(value) : null;
  });
  const dates = [...new Set(rows.map(r => r.serviceDate))].sort();
  const batch = { id, kind: 'lgtc', dates, rows, summaries: dates.map(d => summary(rows.filter(r => r.serviceDate === d), d)) };
  if (customerKey) batch.sourceStamp = customerKey('file:' + createHash('sha256').update(buffer).digest('hex'));
  if (includeDispatchSource) batch.dispatchSource = records.map(r=>({name:r[4],phone:r[28],pickup:r[7],destination:r[16],
    pickupAddress:[r[7],r[10],r[11],r[12]], destinationAddress:[r[16],r[19],r[20],r[21]]}));
  return batch;
}

function summary(rows, serviceDate) {
  const scheduled = rows.filter(r => r.start !== null && r.end > r.start && (r.start > 0 || r.review?.start === 0));
  const events = scheduled.flatMap(r => [[r.start, 1], [r.end, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let running = 0, peak = 0, peakAt = null;
  for (const [at, delta] of events) { running += delta; if (running > peak) { peak = running; peakAt = at; } }
  const hours = Array(24).fill(0);
  scheduled.forEach(r => hours[Math.floor(r.start / 60)]++);
  const codes = Object.fromEntries([...new Set(rows.map(r => r.code))].sort().map(code => [code, rows.filter(r => r.code === code).length]));
  return { serviceDate, count: rows.length, scheduled: scheduled.length, missingTime: rows.length - scheduled.length,
    flagged: rows.filter(r => r.issues.length).length, withNotes: rows.filter(r => r.hasNotes).length, codes, peak, peakAt, hours };
}

function int(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) throw Error(label + ' must be between ' + min + ' and ' + max + '.');
  return value;
}
function reviewLeg(batch, input) {
  const row = batch.rows.find(r => r.row === input.row);
  if (!row) throw Error('Choose a trip leg in this schedule.');
  if (input.reset === true) return { row, review: null };
  if (typeof input.notesReviewed !== 'boolean') throw Error('Confirm whether you reviewed the source notes.');
  let start = null, end = null;
  if (input.start || input.end) {
    start = minutes(String(input.start ?? ''));
    end = minutes(String(input.end ?? ''));
    if (start === null || end === null || end <= start) throw Error('Enter both times. End must be after pickup on the same day.');
  }
  const mode = input.mode || '';
  if (!['', 'standard', 'accessible'].includes(mode)) throw Error('Choose the verified vehicle requirement.');
  const seats = mode ? int(input.seats, 1, 7, 'Occupied seats') : null;
  return { row, review: { start, end, mode, seats, notesReviewed: input.notesReviewed } };
}

function effectiveRows(batch) {
  return batch.rows.map(row => {
    const review = batch.reviews?.[row.row];
    if (!review) return row;
    const corrected = review.start !== null;
    const issues = corrected ? row.issues.filter(issue => issue === 'Incomplete stops') : row.issues;
    return {
      ...row, review, issues,
      originalStart: row.start, originalEnd: row.end,
      start: corrected ? review.start : row.start,
      end: corrected ? review.end : row.end
    };
  });
}

function safeRow(row, preferences) {
  const { customerKey, ...safe } = row;
  return { ...safe, canMatchCustomer:!!customerKey, regularDriver:preferences?.get(customerKey) || null };
}
function scheduleView(batch, preferences) {
  const rows = effectiveRows(batch).map(row => safeRow(row, preferences));
  const { sourceStamp, ...safe } = batch;
  return { ...safe, rows, summaries: batch.dates.map(d => summary(rows.filter(r => r.serviceDate === d), d)) };
}
const eastern = new Intl.DateTimeFormat('en-CA', { timeZone:'America/New_York', year:'numeric', month:'2-digit',
  day:'2-digit', hour:'2-digit', minute:'2-digit', hourCycle:'h23' });
function easternPickup(date, minute) {
  if (!Number.isInteger(minute) || minute < 0 || minute >= 1440) return null;
  const hour = String(Math.floor(minute/60)).padStart(2,'0'), min = String(minute%60).padStart(2,'0');
  const utc = Date.parse(date + 'T' + hour + ':' + min + 'Z');
  const possibilities = [4,5].map(offset=>utc+offset*3600000).filter(at=>{
    const parts = Object.fromEntries(eastern.formatToParts(at).map(p=>[p.type,p.value]));
    return parts.year+'-'+parts.month+'-'+parts.day === date && parts.hour === hour && parts.minute === min;
  });
  return possibilities.length === 1 ? possibilities[0] : null;
}
function dispatchCandidates(plan, source, state, places, validate, now, pilot) {
  const ready = [], held = plan.unplanned.map(row=>({reference:row.reference,reasons:row.reasons}));
  const existing = [];
  const locations = new Map(places.map(place=>[place.name.toLowerCase(),place.name]));
  for (const run of plan.runs) for (const leg of run.trips) {
    const reference = 'LGTC-' + leg.program + '-' + leg.serviceDate + '-' + leg.reference;
    const previous = state.trips.find(t=>t.reference===reference);
    if (previous?.lgtc?.reference === leg.reference) {
      existing.push({reference:leg.reference,dispatchRef:reference,tripId:previous.id,status:previous.status});
      continue;
    }
    const row = source[leg.row - 1];
    const at = easternPickup(leg.serviceDate,leg.start);
    const pickup = pilot ? pilot.resolve(row.pickupAddress) : locations.get(row.pickup.toLowerCase());
    const destination = pilot ? pilot.resolve(row.destinationAddress) : locations.get(row.destination.toLowerCase());
    const mobile = row.phone.replace(/[\s().+-]/g,'').replace(/^1(?=\d{10}$)/,'');
    const reasons = [];
    if (!at || at < now) reasons.push('A future, unambiguous Eastern pickup time is required');
    if (!pickup || !destination) reasons.push(pilot ? 'Pickup and drop-off must match verified street, city, state and ZIP' :
      'Pickup and drop-off must match verified ProLift demo locations');
    if (pilot ? !/^[2-9]\d{2}[2-9]\d{6}$/.test(mobile) : !/^[2-9]\d{2}55501\d{2}$/.test(mobile)) {
      reasons.push(pilot ? 'A valid rider phone is required' : 'Local dispatch testing requires a reserved dummy rider number');
    }
    if (reasons.length) { held.push({reference:leg.reference,reasons}); continue; }
    const checked = validate(state,[{trip_id:reference,customer_name:row.name,customer_phone:'+1'+mobile,
      pickup,destination,pickup_at:new Date(at).toISOString(),passengers:String(leg.seats),
      requirements:leg.mode==='accessible'?'wheelchair':''}],now)[0];
    if (checked.errors.length) { held.push({reference:leg.reference,reasons:checked.errors}); continue; }
    const trip = checked.trip;
    trip.plannedDriverId = run.driverId;
    trip.plannedPickupAt = trip.pickupAt;
    trip.lgtc = { test:!pilot, reference:leg.reference, program:leg.program, serviceDate:leg.serviceDate };
    ready.push({trip, reference:leg.reference, driver:run.label});
  }
  return {ready,held,existing};
}
function namedFleet(driverIds, roster) {
  if (!Array.isArray(driverIds) || driverIds.length > 500 || new Set(driverIds).size !== driverIds.length) {
    throw Error('Select each available driver once.');
  }
  const selected = [];
  return driverIds.map(driverId => {
    const driver = roster.find(d => d.id === driverId);
    if (!driver) throw Error('One of the selected drivers is no longer in this fleet.');
    if (selected.some(other => sameVehicle(driver,other))) throw Error('Select only one driver per vehicle for this date.');
    selected.push(driver);
    return { driverId, label:driver.name, vehicle:driver.vehicle, seats:driver.seats,
      accessible:driver.capabilities.includes('wheelchair'), trips:[] };
  });
}
function serviceProfile(code, profile) {
  if (!['standard', 'accessible'].includes(profile.mode)) throw Error('Choose a service type for code ' + code + '.');
  int(profile.base, 1, 7, 'Base occupied seats');
  if (!Array.isArray(profile.extras) || profile.extras.some(i => ![0, 1, 2].includes(i)) ||
      new Set(profile.extras).size !== profile.extras.length) throw Error('Choose only verified extra-seat fields.');
  return { mode:profile.mode, base:profile.base, extras:profile.extras };
}
function automationSettings(input, roster) {
  if (typeof input.enabled !== 'boolean') throw Error('Choose whether to build drafts on upload.');
  const driverIds = input.driverIds;
  namedFleet(driverIds,roster);
  const buffer = int(input.buffer, 0, 180, 'Between-trip buffer');
  const profiles = {};
  for (const [code,profile] of Object.entries(input.profiles || {})) {
    if (!profile?.mode) continue;
    if (!/^[A-Z0-9]{1,4}$/.test(code)) throw Error('Enter a valid LGTC service code.');
    profiles[code] = serviceProfile(code,profile);
  }
  if (input.enabled && (!driverIds.length || !Object.keys(profiles).length)) {
    throw Error('Select a default driver and verify at least one service code before enabling automatic drafts.');
  }
  return { enabled:input.enabled, driverIds, buffer, profiles };
}

function plan(batch, input, { roster = [], preferences = new Map() } = {}) {
  if (!batch.dates.includes(input.serviceDate)) throw Error('Choose a service date in this import.');
  const buffer = int(input.buffer, 0, 180, 'Between-trip buffer');
  const named = input.driverIds !== undefined;
  const driverIds = input.driverIds;
  const vehicles = named ? namedFleet(driverIds,roster) : [];
  const fleet = {};
  for (const [key, label, seats, accessible] of [
    ['standard4', '4-seat car', 4, false], ['standard7', '7-seat car', 7, false],
    ['accessible4', 'Accessible 4-seat vehicle', 4, true], ['accessible7', 'Accessible 7-seat vehicle', 7, true]
  ]) {
    const count = named ? 0 : int(input.fleet?.[key] ?? 0, 0, 500, label + ' count');
    fleet[key] = count;
    for (let i = 1; i <= count; i++) vehicles.push({ label: label + ' ' + i, seats, accessible, trips: [] });
  }
  if (!vehicles.length) throw Error(named ? 'Select at least one driver available for this date.' : 'Enter at least one vehicle.');
  const pickupOrder = row => row.review?.start ?? (row.start || Infinity);
  const rows = effectiveRows(batch).filter(r => r.serviceDate === input.serviceDate)
    .sort((a, b) => pickupOrder(a) - pickupOrder(b) || a.row - b.row);
  const profiles = new Map();
  for (const code of new Set(rows.map(r => r.code))) {
    const p = input.profiles?.[code];
    if (!p || p.mode === '') continue;
    profiles.set(code, serviceProfile(code,p));
  }
  const unplanned = [], ready = [];
  for (const row of rows) {
    const p = profiles.get(row.code);
    let reasons = [...row.issues], seats;
    if (row.hasNotes && !row.review?.notesReviewed && input.notesReviewed !== true) reasons.push('Review source instructions');
    const mode = row.review?.mode || p?.mode;
    if (row.review?.mode) seats = row.review.seats;
    else if (!p) reasons.push('Verify service code and seats');
    else if (p.extras.some(i => row.sourceCounts[i] === null)) reasons.push('Extra-seat count missing');
    else seats = p.base + p.extras.reduce((n, i) => n + row.sourceCounts[i], 0);
    const safe = safeRow(row, preferences);
    if (reasons.length) unplanned.push({ ...safe, reasons });
    else ready.push({ ...safe, seats, mode });
  }
  const suitable = (v, row) => v.seats >= row.seats && (row.mode !== 'accessible' || v.accessible);
  const fitsTime = (v, row) => v.trips.every(leg => leg.end + buffer <= row.start || row.end + buffer <= leg.start);
  const allocate = (v, row, assignment) => v.trips.push({ ...row, assignment });
  const remaining = [];
  for (const row of ready) {
    const regular = named && row.regularDriver && vehicles.find(v => v.driverId === row.regularDriver.id);
    if (regular && suitable(regular, row) && fitsTime(regular, row)) allocate(regular, row, 'Regular driver');
    else {
      const alternateReason = !named || !row.regularDriver ? '' :
        !regular ? 'Regular driver is outside this day’s roster' :
        !suitable(regular,row) ? 'Regular driver’s vehicle does not meet the requirements' :
        'Regular driver has a scheduling conflict';
      remaining.push({ ...row, alternateReason });
    }
  }
  for (const row of remaining) {
    const suitableVehicles = vehicles.filter(v => suitable(v,row));
    const best = suitableVehicles.filter(v => fitsTime(v,row)).sort((a,b) =>
      Number(a.accessible) - Number(b.accessible) || a.seats - b.seats || b.trips.length - a.trips.length)[0];
    if (best) allocate(best, row, named && row.regularDriver ? 'Alternate driver' : '');
    else unplanned.push({ ...row, reasons:[suitableVehicles.length ? 'No suitable vehicle free at pickup' : 'No vehicle meets seat or accessibility needs'] });
  }
  const byPickup = (a,b) => pickupOrder(a) - pickupOrder(b) || a.row - b.row;
  for (const v of vehicles) v.trips.sort(byPickup);
  unplanned.sort(byPickup);
  const runs = named ? vehicles : vehicles.filter(v => v.trips.length);
  const settings = { buffer, fleet, ...(named ? { driverIds } : {}), profiles: Object.fromEntries(profiles), notesReviewed: input.notesReviewed === true };
  return { serviceDate: input.serviceDate, buffer, count: rows.length, allocated: rows.length - unplanned.length, runs, unplanned, settings };
}

module.exports = { detect, plan, reviewLeg, scheduleView, identity, automationSettings, dispatchCandidates, easternPickup };
