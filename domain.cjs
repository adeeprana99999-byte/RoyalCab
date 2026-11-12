const SharedPlanner=require('./shared-planner.cjs');
const crypto = require('node:crypto');
const Operations = require('./operations.cjs');
const Reservations=require('./reservations.cjs');
const { MAX_AGE: LOCATION_MAX_AGE } = require('./location.cjs');
const { deviceReady, requiresRoad } = require('./road-routing.cjs');
const easternServiceDate = new Intl.DateTimeFormat('en-CA', { timeZone:'America/New_York', year:'numeric', month:'2-digit', day:'2-digit' });
function freeDriver(d){
 d.status=d.finishThenOffline?'offline':'online';
 if(d.status==='offline')d.trackingEnabled=false;
 d.finishThenOffline=false;
}
const id = prefix => prefix + '-' + crypto.randomUUID().slice(0, 8);
const places = [
  { name: 'Central Station', lat: 40.7527, lng: -73.9772 },
  { name: 'City Hospital', lat: 40.764, lng: -73.954 },
  { name: 'Riverside Hotel', lat: 40.774, lng: -73.99 },
  { name: 'Airport Terminal', lat: 40.6413, lng: -73.7781 },
  { name: 'Downtown Office', lat: 40.713, lng: -74.006 },
  { name: 'Park Avenue', lat: 40.76, lng: -73.97 }
];
const phoneValid = p => /^\+[1-9]\d{7,14}$/.test(p);
const declineReasons = ['On a break', 'Vehicle issue', 'Pickup too far', 'Unable to take this trip'];
const releaseReasons = ['Vehicle issue', 'Feeling unwell', 'Road blocked', 'Unable to reach pickup', 'Need dispatch assistance'];
function seed(now = Date.now(),initialSettings={}) {
  const drivers = [
    { id: 'd1', name: 'Maya Chen', phone: '+15550101001', status: 'online', seats: 4, capabilities: [], plate: 'PL • 104', vehicle: 'Toyota Camry', lat: 40.751, lng: -73.98, lastLocationAt: now },
    { id: 'd2', name: 'James Wilson', phone: '+15550101002', status: 'online', seats: 7, capabilities: ['wheelchair'], plate: 'PL • 208', vehicle: 'Accessible van', lat: 40.768, lng: -73.96, lastLocationAt: now },
    { id: 'd3', name: 'Sofia Martinez', phone: '+15550101003', status: 'online', seats: 4, capabilities: [], plate: 'PL • 312', vehicle: 'Hyundai Ioniq', lat: 40.73, lng: -73.995, lastLocationAt: now }
  ];
  const trip = (ref, customerName, customerPhone, from, to, minutes, extra = {}) => ({ id: id('trip'), reference: ref, customerName, customerPhone, pickup: places[from].name, destination: places[to].name, pickupAt: now + minutes * 60000, passengers: 1, requirements: [], status: 'awaiting_driver', driverId: null, redFlag: false, excluded: [], createdAt: now, ...extra });
  const trips = [trip('PL-1001', 'Alex Morgan', '+15550102001', 0, 1, 30), trip('PL-1002', 'Jordan Lee', '+15550102002', 2, 3, 75), trip('PL-1003', 'Taylor Brooks', '+15550102003', 4, 0, 55), trip('PL-1004', 'Casey Evans', '+15550102004', 5, 1, 50, { requirements: ['wheelchair'] })];
  return { settings:{...Operations.defaults,...initialSettings},customerMessages:[],assignmentHistory:[],drivers, trips, offers: [], events: [], imports: [], customers: [{ phone: '+15550102001', name: 'Alex Morgan' }], notifications: [], revision: 0 };
}
function event(s, type, trip, actor, detail = '') {
  const e = { id: id('evt'), type, tripId: trip?.id, reference: trip?.reference, actor, detail, at: Date.now() };
  s.events.unshift(e); s.events = s.events.slice(0, 1000);
  s.notifications.unshift({ ...e, delivery: 'demo-log' }); s.notifications = s.notifications.slice(0, 300);
}
function estimate(driver, place) {
  const dx = (driver.lat - place.lat) * 111, dy = (driver.lng - place.lng) * 84;
  return Math.max(1, Math.ceil(Math.hypot(dx, dy) * 1.25 / 0.5));
}
function currentOffers(s, now) { return s.offers.filter(o => o.status === 'pending' && o.expiresAt > now); }
function recoveryAllows(t, driverId, at) {
 return t.recoveryUntil>=at && (t.recoveryDriverIds||[]).includes(driverId);
}
function eligibility(s,t,now,ignoreOffer){
 const road=s.roadRouting && requiresRoad(t);
 const catalog=road&&s.roadRouting.places?s.roadRouting.places:places;
 const pickup=catalog.find(p=>p.name===t.pickup), destination=catalog.find(p=>p.name===t.destination);
 const pending=currentOffers(s,now),ignored=new Set(Array.isArray(ignoreOffer)?ignoreOffer:[ignoreOffer]);
 return s.drivers.filter(d=>(d.demoRunId||null)===(t.demoRunId||null)).map(d=>{
  const reasons=[];
  const quote=road?s.roadRouting.get(d,pickup,now):null;
  const eta=road?(quote?.minutes ?? null):pickup&&Number.isFinite(d.lat)&&Number.isFinite(d.lng)?estimate(d,pickup):null;
  if(road&&!deviceReady(d,now))reasons.push('Fresh phone GPS required');
  if(!road&&(d.locationSource==='replay'||d.locationSource==='device'&&(!t.lgtc?.test||!d.trackingEnabled)))reasons.push('Real routing connection required');
  if(d.status!=='online')reasons.push(d.status==='busy'?'On another ride':'Offline');
  const shift = d.availability && Number.isFinite(t.pickupAt) ? d.availability[easternServiceDate.format(t.pickupAt)] : null;
  if (shift?.unavailable || shift && (Math.max(t.pickupAt,now) < shift.startAt || Math.max(t.pickupAt,now) >= shift.endAt ||
      (t.plannedPickupAt === t.pickupAt && t.plannedEndAt > shift.endAt))) reasons.push('Outside the driver’s scheduled hours');
  if(!road&&(!Number.isFinite(d.lastLocationAt)||now-d.lastLocationAt>120000||now<d.lastLocationAt||eta===null))reasons.push('Fresh location required');
  if(road&&(!pickup||!destination))reasons.push('Verified pickup and drop-off coordinates required');
  if(d.seats<t.passengers)reasons.push('Not enough seats');
  if(!t.requirements.every(r=>d.capabilities.includes(r)))reasons.push('Vehicle requirements not met');
  if(t.excluded.includes(d.id))reasons.push('Already declined, timed out or dropped this ride');
  if(pending.some(o=>o.driverId===d.id&&!ignored.has(o.id)))reasons.push('Waiting for another offer reply');
  if(pending.some(o=>o.driverId!==d.id&&!ignored.has(o.id)&&Reservations.sameVehicle(d,s.drivers.find(x=>x.id===o.driverId)||{})))reasons.push('Vehicle has another pending offer');
  if(s.trips.some(x=>x.driverId===d.id&&!['completed','cancelled'].includes(x.status)))reasons.push('Already assigned to an active ride');
  if(Reservations.resourceBusy(s,d))reasons.push('Vehicle is on another ride');
  const recovery=recoveryAllows(t,d.id,now);
  if(pickup&&destination&&Reservations.conflicts(s,d,recovery?{...t,pickupAt:Math.max(t.pickupAt,now+(eta||0)*60000)}:t,catalog,now))reasons.push('Would overlap a reserved pickup');
  if(!recovery&&eta!==null&&now+eta*60000>t.pickupAt+5*60000)reasons.push('Cannot reach pickup within the arrival tolerance');
  const roadPending=!!(road&&!quote&&!reasons.length);
  if(road&&!quote)reasons.push('Waiting for a verified road ETA');
  else if(road&&eta===null)reasons.push('No road route to pickup');
  return {driver:d,eta,reasons,roadPending,eligible:reasons.length===0};
 });
}
function recoveryTrip(s,t,driverId,now=Date.now()){
 const memberIds=new Set([t.id,...(t.isSharedRun?(t.sharedStops||[]).map(x=>x.tripId):[])]);
 const memberDrops=t.isSharedRun?(t.sharedStops||[]).flatMap(x=>s.trips.find(t=>t.id===x.tripId)?.droppedDrivers||[]):[];
 const dropped=new Set([...memberDrops,...(t.droppedDrivers||[]),...s.events.filter(e=>memberIds.has(e.tripId)&&e.type==='trip.reassignment_required').map(e=>s.drivers.find(d=>d.name===e.actor)?.id).filter(Boolean)]);
 return {...t,excluded:[...new Set([...t.excluded,...dropped])].filter(id=>dropped.has(id)||driverId&&id!==driverId),recoveryUntil:now+45000,recoveryDriverIds:driverId?[driverId]:s.drivers.map(d=>d.id)};
}
function regularDriver(s,t){
 const members=t.isSharedRun?(t.sharedStops||[]).map(x=>s.trips.find(t=>t.id===x.tripId)).filter(Boolean):[t];
 const ids=[...new Set(members.map(x=>s.lgtcRegularDrivers?.get(x.id)||
   s.customerPreferences?.[(x.demoRunId||'ordinary')+':'+x.customerPhone]?.driverId).filter(Boolean))];return ids.length===1?ids[0]:null;
}
function eligible(s,t,now,ignoreOffer){
 const regular=regularDriver(s,t), planned=t.plannedPickupAt===t.pickupAt?t.plannedDriverId:null;
 const paired=t.lgtc?.pairedReference && s.trips.find(ride =>
   ride.customerPhone === t.customerPhone && ride.lgtc?.reference === t.lgtc.pairedReference &&
   ride.lgtc?.pairedReference === t.lgtc.reference && ride.lgtc.program === t.lgtc.program &&
   ride.lgtc.serviceDate === t.lgtc.serviceDate &&
   ['accepted','heading_to_pickup','arrived','onboard','completed'].includes(ride.status));
 const priority=[t.reservedDriverId,paired?.driverId,regular||planned];
 return eligibility(s,t,now,ignoreOffer).filter(x=>x.eligible).sort((a,b)=>{
  for (const id of priority) {
   const diff=Number(b.driver.id===id)-Number(a.driver.id===id);
   if(diff)return diff;
  }
  return a.eta-b.eta||a.driver.id.localeCompare(b.driver.id);
 });
}
function offer(s, t, actor, now = Date.now(),options={}) {
  if (!['awaiting_driver', 'needs_reassignment'].includes(t.status)) throw new Error('This trip cannot receive an offer now');
  const lead=Operations.settings(s).dispatchLeadMinutes;
  if (t.pickupAt > now + lead * 60000) throw new Error(`This trip is scheduled. Dispatch opens ${lead} minutes before pickup.`);
  const road = s.roadRouting && requiresRoad(t);
  if (road && eligibility(s,t,now).some(c=>c.roadPending && (!options.driverId||c.driver.id===options.driverId))) {
    const error = Error('Waiting for a verified road ETA.');
    error.code = 'ROAD_PENDING';
    throw error;
  }
  let candidates=eligible(s,t,now);
  if(t.reservedDriverId&&(!candidates.some(x=>x.driver.id===t.reservedDriverId)||!Reservations.sameVehicle(Reservations.current(s,t.id)||{},s.drivers.find(d=>d.id===t.reservedDriverId)||{}))){Reservations.release(s,t,'unavailable','Reserved driver cannot reach pickup or is unavailable',now);t.reservationIssue=true;event(s,'reservation.unavailable',t,'Automatic dispatch','Reservation unavailable; searching the remaining fleet');candidates=eligible(s,t,now);}
  if(options.mode==='recovery_sequential') candidates.sort((a,b)=>a.eta-b.eta||a.driver.id.localeCompare(b.driver.id));
  const best=options.driverId?candidates.find(x=>x.driver.id===options.driverId):candidates[0];
  if (!best) throw new Error('No eligible driver can reach this pickup on time. Check driver availability and location.');
  const created=[],groupId=options.mode==='urgent_group'?id('group'):null,limit=groupId?(options.limit||Operations.settings(s).urgentGroupSize):1;
  for(let i=0;i<limit;i++){
    const candidate=i===0?best:eligible(s,t,now)[0];if(!candidate)break;
    const o={id:id('offer'),tripId:t.id,driverId:candidate.driver.id,eta:candidate.eta,status:'pending',offeredAt:now,expiresAt:now+45000,attemptNumber:s.offers.filter(o=>o.tripId===t.id).length+1,mode:options.mode||'sequential',groupId,ownerReason:options.reason||null};
    o.etaSource = road ? 'road' : 'simulated';
    if(t.demoScenario==='charlotte-fleet'){t.demoCandidateRanking=candidates.map(x=>({driverId:x.driver.id,name:x.driver.name,eta:x.eta}));t.demoAssignmentReason=candidate.driver.name+' was the nearest eligible available driver ('+candidate.eta+' min simulated pickup ETA).';}
    const regular=regularDriver(s,t);
    o.selectionReason=candidate.driver.id===t.reservedDriverId?'reserved_driver':candidate.driver.id===regular?'regular_customer_driver':
      !regular&&t.plannedPickupAt===t.pickupAt&&candidate.driver.id===t.plannedDriverId?'planned_driver':'nearest_eligible';
    s.offers.push(o);created.push(o);event(s,'offer.created',t,actor,'Offer '+o.attemptNumber+': '+candidate.driver.name+' · '+o.mode+' · '+(road?'road':'simulated')+' ETA '+o.eta+' min'+(options.reason?' · '+options.reason:''));
  }
  if(options.mode==='recovery_sequential') t.recoveryUntil=created[0].expiresAt;
  t.status='offered';t.dispatchExhausted=false;t.dispatchMode=options.mode||'sequential';
  if(groupId)event(s,'dispatch.urgent_group',t,actor,created.length+' eligible drivers notified; first valid acceptance wins');
  return created[0];
}
function dispatchNext(s, t, now = Date.now()) {
  try {
    const settings=Operations.settings(s),missed=s.offers.some(o=>o.tripId===t.id&&['declined','expired'].includes(o.status));
    const urgent=settings.urgentGroupEnabled&&missed&&t.pickupAt<=now+settings.urgentGroupMinutes*60000;
    const preferred=regularDriver(s,t),firstRegularOffer=preferred&&eligible(s,t,now).some(x=>x.driver.id===preferred)&&!s.offers.some(o=>o.tripId===t.id&&o.driverId===preferred);
    const mode=t.recoveryUntil>=now?'recovery_sequential':urgent&&!firstRegularOffer?'urgent_group':'sequential';
    offer(s,t,'Automatic dispatch',now,{mode}); t.dispatchError='';
  }
  catch(e) {
    if (e.code === 'ROAD_PENDING') { t.dispatchError=''; t.retryAt=now+6000; return; }
    t.dispatchError=e.message;
    const remaining=eligible(s,{...t,excluded:[]},now);
    const attempted=s.offers.some(o=>o.tripId===t.id && ['declined','expired','invalidated'].includes(o.status));
    if (attempted && remaining.every(({driver})=>t.excluded.includes(driver.id))) {
      if (!t.dispatchExhausted) event(s,'dispatch.exhausted',t,'Automatic dispatch','No remaining eligible driver. All currently available suitable candidates have been tried or are unavailable. Owner review required.');
      t.dispatchExhausted=true;
      t.dispatchError='No remaining eligible driver. Review driver availability or retry the search.';
    }
  }
  t.retryAt=now+60000;
}
function closeOffer(s,o,status,now=Date.now()){
 const t=s.trips.find(t=>t.id===o.tripId);o.status=status;o.respondedAt=now;
 if(!t)return;t.excluded=[...new Set([...t.excluded,o.driverId])];event(s,'offer.'+status,t,'System');
 if(t.status==='offered'&&!currentOffers(s,now).some(x=>x.tripId===t.id)){
  t.status=t.redFlag?'needs_reassignment':'awaiting_driver';t.retryAt=now;
  if(['declined','expired'].includes(status) && ['manual','recovery_sequential'].includes(o.mode) && recoveryAllows(t,o.driverId,o.offeredAt)){
   t.recoveryUntil=now+45000;
   t.recoveryDriverIds=s.drivers.map(d=>d.id);
  }
 }
}
function tick(s, now = Date.now()) {
  let changed = false;
  for (const o of s.offers) if (o.status === 'pending' && o.expiresAt <= now) { closeOffer(s, o, 'expired', now); changed = true; }
  // These points are intentionally simulated; there is no real driver tracking.
  for (const d of s.drivers) if (!['device','replay','scenario'].includes(d.locationSource) && d.status !== 'offline' && now - d.lastLocationAt > 5000) {
    const t = s.trips.find(t => t.driverId === d.id && !['completed', 'cancelled'].includes(t.status));
    const target = t && places.find(p => p.name === (t.status === 'onboard' ? t.destination : t.pickup));
    if (target) { d.lat += (target.lat - d.lat) * 0.025; d.lng += (target.lng - d.lng) * 0.025; }
    d.lastLocationAt = now; changed = true;
  }
  // Failed/no-driver attempts back off and survive restarts in persisted state.
  for (const t of [...s.trips].sort((a, b) => a.pickupAt - b.pickupAt)) if (t.autoDispatch && ['awaiting_driver', 'needs_reassignment'].includes(t.status) && t.pickupAt <= now + Operations.settings(s).dispatchLeadMinutes * 60000 && (t.retryAt || 0) <= now) {
    dispatchNext(s,t,now); changed = true;
  }
  for(const t of s.trips.filter(t=>t.isSharedRun))SharedPlanner.sync(s,t,now);
  return Operations.reminders(s,now)||changed;
}
function performAction(s, t, command, user, body = {}, now = Date.now()) {
  if (!t) throw new Error('Trip not found');
  if (command === 'retry') {
    if (user.role !== 'owner') throw new Error('Owner access required');
    if (!['awaiting_driver', 'needs_reassignment'].includes(t.status)) throw new Error('Resolve the current offer or trip before retrying');
    const released = s.events.filter(e => e.tripId === t.id && e.type === 'trip.reassignment_required').map(e => s.drivers.find(d => d.name === e.actor)?.id).filter(Boolean);
    t.excluded = [...new Set([...(t.droppedDrivers || []), ...released])];
    t.autoDispatch = true; t.retryAt = now; t.dispatchError = ''; t.dispatchExhausted=false;
    event(s, 'dispatch.search_restarted', t, user.name, 'Retry declined/expired candidates; released drivers remain excluded'); return;
  }
  if(command==='manual_offer'||command==='group_offer'){
    if(user.role!=='owner')throw Error('Owner access required');
    if(!['awaiting_driver','needs_reassignment','offered'].includes(t.status)||t.driverId)throw Error('Only unconfirmed rides can receive an owner-selected offer');
    if(t.pickupAt>now+Operations.settings(s).dispatchLeadMinutes*60000)throw Error('This ride is outside its driver-offer window');
    const reasons=['Urgent pickup','Driver contacted by dispatch','Replacement requested','Owner reviewed availability'];
    if(!reasons.includes(body.reason))throw Error('Choose a listed dispatch reason');
    const pending=currentOffers(s,now).filter(o=>o.tripId===t.id),reviewed=body.recovery===true&&command==='manual_offer'?recoveryTrip(s,t,body.driverId,now):t,choices=eligible(s,reviewed,now,pending.map(o=>o.id));
    if(command==='manual_offer'&&!choices.some(x=>x.driver.id===body.driverId))throw Error('This driver is unavailable or unsuitable. Refresh driver choices.');
    if(command==='group_offer'&&!choices.length)throw Error('No eligible drivers are currently available');
    if(reviewed!==t){t.excluded=reviewed.excluded;t.recoveryUntil=reviewed.recoveryUntil;t.recoveryDriverIds=reviewed.recoveryDriverIds;event(s,'dispatch.recovery_reviewed',t,user.name,'Owner selected '+body.driverId+' using current availability; original pickup time retained');}
    for(const o of s.offers)if(o.tripId===t.id&&o.status==='pending'){o.status='replaced_by_owner';o.respondedAt=now;}
    if(command==='manual_offer'&&t.reservedDriverId&&t.reservedDriverId!==body.driverId)Reservations.release(s,t,'released',body.reason,now);
    t.status=t.redFlag?'needs_reassignment':'awaiting_driver';t.autoDispatch=true;t.dispatchError='';
    const result=offer(s,t,user.name,now,{mode:command==='manual_offer'?'manual':'urgent_group',driverId:command==='manual_offer'?body.driverId:undefined,reason:body.reason});
    event(s,'dispatch.owner_override',t,user.name,body.reason+' · '+(command==='manual_offer'?'Selected driver offer':'Small group offer'));return result;
  }
  if (command === 'offer') { if (user.role !== 'owner') throw new Error('Owner access required'); t.autoDispatch = true; const o = offer(s, t, user.name, now); t.dispatchError = ''; return o; }
  if (command === 'accept' || command === 'decline') {
    const o = s.offers.find(o => o.tripId === t.id && o.id === body.offerId);
    if (user.role !== 'driver' || !o || o.driverId !== user.driverId) throw new Error('This offer is not yours');
    if (o.status !== 'pending' || o.expiresAt <= now || t.status !== 'offered') throw new Error('Offer is no longer available');
    if (command === 'decline') {
      if (!declineReasons.includes(body.reason)) throw new Error('Choose a listed decline reason');
      o.declineReason = body.reason; o.respondedAt = now;
      if(t.reservedDriverId===user.driverId)Reservations.release(s,t,'declined',body.reason,now);
      closeOffer(s, o, 'declined', now);
      event(s, 'driver.decline_reason', t, user.name, body.reason);
      t.autoDispatch = true; t.retryAt = now;
      if(!currentOffers(s,now).some(x=>x.tripId===t.id))dispatchNext(s,t,now); return;
    }
    const candidate = eligibility(s,t,now,o.id).find(x=>x.driver.id===user.driverId);
    if (candidate?.roadPending) {
      const error=Error('A fresh road ETA is unavailable. Try Accept again while the offer is open.');
      error.status=409;
      throw error;
    }
    if (!candidate?.eligible) throw new Error('Driver availability changed; this assignment cannot be accepted');
    Reservations.release(s,t,'fulfilled','Driver accepted the live offer',now);t.reservationIssue=false;
    for(const other of s.offers)if(other.tripId===t.id&&other.id!==o.id&&other.status==='pending'){other.status='taken';other.respondedAt=now;}
    o.respondedAt=now;o.status = 'accepted'; t.driverId = user.driverId; t.status = 'accepted'; t.redFlag = false; t.dispatchExhausted=false; t.dispatchError = ''; t.recoveryUntil=0;t.recoveryDriverIds=[];const acceptedDriver=s.drivers.find(d => d.id === user.driverId);acceptedDriver.status = 'busy';Operations.confirmed(s,t,acceptedDriver,o,now);event(s, 'assignment.accepted', t, user.name); return;
  }
  if (command === 'cancel') {
    if (!(user.role === 'owner' || user.role === 'customer' && user.phone === t.customerPhone)) throw new Error('Not authorized');
    if (['onboard', 'completed', 'cancelled'].includes(t.status)) throw new Error('Cannot cancel at this stage; contact dispatch');
    Reservations.release(s,t,'cancelled','Trip cancelled',now);Operations.outcome(s,t,'cancelled',now);t.cancelledAt=now;
    for (const o of s.offers) if (o.tripId === t.id && o.status === 'pending') o.status = 'cancelled';
    if (t.driverId) freeDriver(s.drivers.find(d => d.id === t.driverId));
    t.driverId = null; t.status = 'cancelled'; t.redFlag = false; event(s, 'trip.cancelled', t, user.name); return;
  }
  if (command === 'rate') {
    if (user.role !== 'customer' || user.phone !== t.customerPhone || t.status !== 'completed' || t.rating) throw new Error('Rating is unavailable');
    if (!Number.isInteger(body.stars) || body.stars < 1 || body.stars > 5) throw new Error('Choose 1–5 stars');
    t.rating = body.stars; event(s, 'trip.rated', t, user.name, `${body.stars} stars`); return;
  }
  if (command === 'release') {
    const owner=user.role==='owner',driver=s.drivers.find(d=>d.id===t.driverId);
    if(!driver||driver.id!==(owner?body.driverId:user.driverId)||!['owner','driver'].includes(user.role)) {
      throw Error('The driver assignment has changed. Refresh the ride before releasing it.');
    }
    if (!['accepted', 'heading_to_pickup', 'arrived'].includes(t.status)) throw new Error('Contact dispatch for an onboard incident');
    if (typeof body.reason !== 'string' || body.reason.trim().length < 3) throw new Error('Please give a reason for dropping this trip');
    Operations.outcome(s,t,'released',now);
    t.driverId = null; t.status = 'needs_reassignment'; t.redFlag = true; t.excluded = [...new Set([...t.excluded, driver.id])]; t.autoDispatch = true; t.retryAt = now + 10000;
    t.droppedDrivers = [...new Set([...(t.droppedDrivers || []), driver.id])];
    if(owner) driver.finishThenOffline=true;
    freeDriver(driver);
    event(s,owner?'dispatch.assignment_released':'trip.reassignment_required',t,user.name,
      (owner?driver.name+' · ':'')+body.reason.trim().slice(0,500));
    return;
  }
  if (user.role !== 'driver' || t.driverId !== user.driverId) throw new Error('Only the assigned driver can update this trip');
  const transitions = { depart: ['accepted', 'heading_to_pickup'], arrive: ['heading_to_pickup', 'arrived'], pickup: ['arrived', 'onboard'], complete: ['onboard', 'completed'] };
  const rule = transitions[command]; if (!rule || t.status !== rule[0]) throw new Error('Invalid trip transition');
  t.status = rule[1];if(command==='pickup')Operations.started(s,t,now); if (command === 'complete') {
    Operations.outcome(s,t,'completed',now);
    t.completedAt = now; freeDriver(s.drivers.find(d => d.id === user.driverId));
    event(s,'driver.available',t,user.name,s.drivers.find(d=>d.id===user.driverId).status==='offline'?'Ride finished; driver went offline as requested.':'Ride finished; driver is available for the next pickup.');
    for (const waiting of s.trips) if (waiting.autoDispatch && ['awaiting_driver','needs_reassignment'].includes(waiting.status)) waiting.retryAt=now;
  }
  Operations.stage(s,t,command,now);event(s, `trip.${t.status}`, t, user.name);
}
function action(s,t,command,user,body={},now=Date.now()){
 if(command==='unpool'){
  if(user.role!=='owner'||!t?.isSharedRun)throw Error('Owner access to a shared run required');
  if(t.driverId||(t.collectedStops||0)>0)throw Error('An accepted run cannot be split. Contact the driver first.');
  for(const stop of t.sharedStops){const child=s.trips.find(x=>x.id===stop.tripId);if(child?.poolParentId===t.id){delete child.poolParentId;child.status=child.redFlag?'needs_reassignment':'awaiting_driver';child.autoDispatch=true;delete child.plannedDriverId;}}
  for(const o of s.offers)if(o.tripId===t.id&&o.status==='pending')o.status='replaced_by_owner';t.status='cancelled';t.autoDispatch=false;event(s,'shared.split',t,user.name,'Original bookings returned to the dispatch queue');return;
 }
 if(t?.poolParentId&&command!=='rate')throw Error('This booking belongs to a shared run. Contact dispatch to change it.');
 if(t?.isSharedRun&&(t.collectedStops||0)>0&&['release','cancel'].includes(command))throw Error('Passengers are onboard. Contact dispatch for assistance.');
 const result=performAction(s,t,command,user,body,now);
 if(t?.isSharedRun&&command==='pickup'){
  t.collectedStops=(t.collectedStops||0)+1;
  if(t.collectedStops<t.sharedStops.length){t.status='heading_to_pickup';t.pickup=t.sharedStops[t.collectedStops].pickup;event(s,'shared.next_pickup',t,user.name,'Next pickup: '+t.pickup);}
 }
 SharedPlanner.sync(s,t,now);return result;
}
function validateRows(s, rows, now = Date.now()) {
  const seen = new Set();
  return rows.map(r => {
    const errors = [], reference = r.trip_id, pickupAt = Date.parse(r.pickup_at);
    if (!reference || reference.length > 80) errors.push('Trip ID required (max 80 characters)');
    if (seen.has(reference) || s.trips.some(t => t.reference === reference)) errors.push('Duplicate trip ID'); seen.add(reference);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(r.pickup_at) || !Number.isFinite(pickupAt) || pickupAt < now) errors.push('Future pickup required as ISO date/time with timezone, e.g. 2026-11-02T09:30:00-05:00');
    if (!r.customer_name || r.customer_name.length > 100) errors.push('Customer name required (max 100 characters)');
    if (!phoneValid(r.customer_phone)) errors.push('Phone must include country code, e.g. +15550102001');
    const bookingPlaces=s.roadRouting?.places||places;
    for (const field of ['pickup', 'destination']) if (!bookingPlaces.some(p => p.name === r[field])) errors.push(
      `Unknown ${field}; use a listed ${s.roadRouting?.places?'verified':'demo'} location`);
    if (r.pickup === r.destination) errors.push('Pickup and destination must differ');
    if (!/^\d+$/.test(r.passengers) || +r.passengers < 1 || +r.passengers > 7) errors.push('Passengers must be 1–7');
    const requirements = r.requirements ? r.requirements.toLowerCase().split(/[;,]/).map(x => x.trim()).filter(Boolean) : [];
    if (requirements.some(x => x !== 'wheelchair')) errors.push('Only wheelchair is supported as a demo requirement');
    if (Object.values(r).some(v => typeof v === 'string' && v.includes('#FORMULA_NOT_ALLOWED'))) errors.push('Replace spreadsheet formulas with plain values');
    return { ...r, errors, trip: { id: id('trip'), reference, customerName: r.customer_name, customerPhone: r.customer_phone, pickupAt, pickup: r.pickup, destination: r.destination, passengers: +r.passengers, requirements, status: 'awaiting_driver', driverId: null, redFlag: false, excluded: [], createdAt: now, autoDispatch: true } };
  });
}
function scoped(s, user, now = Date.now()) {
  const copy = structuredClone(s);for(const t of copy.trips){const id=regularDriver(s,t),d=s.drivers.find(d=>d.id===id);t.preferredDriver=d?{id:d.id,name:d.name,fallback:'another_suitable_driver'}:null;}
  if (user.role === 'owner') { copy.imports = copy.imports.map(i => ({ id: i.id, at: i.at, count: i.rows.length, confirmed: i.confirmed })); return copy; }
  delete copy.vehiclePlan;delete copy.volumeDemo;delete copy.queueReviewDemo;delete copy.customerPreferences;
  delete copy.fleetScenario;delete copy.trackingReplay;delete copy.sharedPlanDemo;
  copy.imports = []; copy.customers = []; copy.notifications = [];
  copy.customerMessages=user.role==='customer'?(copy.customerMessages||[]).filter(m=>m.recipient===user.phone):[];
  copy.assignmentHistory=[];
  copy.offerUpdates=user.role==='driver'?copy.offers.filter(o=>o.driverId===user.driverId&&['taken','replaced_by_owner'].includes(o.status)).slice(-10).map(o=>({id:o.id,status:o.status})):[];
  copy.reservations=(copy.reservations||[]).filter(r=>user.role==='driver'?r.driverId===user.driverId:copy.trips.some(t=>t.id===r.tripId&&t.customerPhone===user.phone));
  copy.supportRequests=(copy.supportRequests||[]).filter(r=>user.role==='customer'?r.customerPhone===user.phone:r.createdBy==='driver:'+user.driverId);
  const driverOffers = new Set(user.role==='driver'?currentOffers(s,now).filter(o=>o.driverId===user.driverId).map(o=>o.tripId):[]);
  copy.trips = copy.trips.filter(t => user.role === 'customer' ? t.customerPhone === user.phone : !t.poolParentId&&(t.driverId === user.driverId || driverOffers.has(t.id)));
  const tripIds = new Set(copy.trips.map(t => t.id));
  copy.offers = copy.offers.filter(o => tripIds.has(o.tripId) && (user.role === 'driver' ? o.driverId === user.driverId : false));
  copy.events = copy.events.filter(e => tripIds.has(e.tripId));
  copy.drivers = copy.drivers.filter(d => user.role === 'driver' ? d.id === user.driverId : copy.trips.some(t => t.driverId === d.id && !['completed', 'cancelled'].includes(t.status))).map(d => {
    const { phone, ...safe } = d;
    if (user.role === 'driver') return safe;
    const { id,name,vehicle,plate,status,locationSource,trackingEnabled,lastLocationAt,lat,lng } = safe;
    const fresh = status!=='offline' && !(locationSource==='device'&&trackingEnabled===false) &&
      Number.isFinite(lat) && Number.isFinite(lng) && lastLocationAt<=now && now-lastLocationAt<=LOCATION_MAX_AGE;
    return { id,name,vehicle,plate,status,locationSource,trackingEnabled,...(fresh?{lastLocationAt,lat,lng}:{}) };
  });
  return copy;
}
module.exports = { id, places, phoneValid, declineReasons, releaseReasons, seed, event, estimate, eligibility, eligible, regularDriver, recoveryTrip, offer, closeOffer, tick, action, validateRows, scoped };
