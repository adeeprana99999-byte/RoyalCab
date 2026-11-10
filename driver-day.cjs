const { createHash } = require('node:crypto');
const D = require('./domain.cjs');
const Operations = require('./operations.cjs');
const Planner = require('./vehicle-planner.cjs');
const Shared = require('./shared-planner.cjs');

function context(state, driverId, requestedDate, now) {
  const driver = state.drivers.find(d => d.id === driverId);
  if (!driver) throw Error('Choose a driver.');
  const timezone = Operations.settings(state).timezone;
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone:timezone, year:'numeric', month:'2-digit', day:'2-digit' });
  const dayOf = at => formatter.format(at);
  const today = dayOf(now);
  const date = requestedDate || today;
  const utc = new Date(date + 'T12:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(+utc) || utc.toISOString().slice(0,10) !== date) {
    throw Error('Choose a valid service date.');
  }
  const includeTrip = trip => (trip.demoRunId || null) === (driver.demoRunId || null) &&
    Number.isFinite(trip.pickupAt) && dayOf(trip.pickupAt) === date;
  return { driver, timezone, today, date, includeTrip };
}

function proposal(state, ctx, now, scope) {
  if (ctx.date < ctx.today) throw Error('Choose today or a future date to build a plan.');
  const plan = Shared.build(state, D.places, now, { includeTrip:ctx.includeTrip, keepPlans:true });
  const cars = scope === 'fleet' ? plan.cars : plan.cars.filter(car => car.driverId === ctx.driver.id);
  const selected = cars.find(car => car.driverId === ctx.driver.id);
  const fingerprint = createHash('sha256').update(JSON.stringify([
    scope, ctx.driver.demoRunId || null, ctx.date, cars.map(car => [car.driverId, car.stops.map(stop => [
      stop.members, stop.pickupAt, stop.endAt, stop.sharedStops.map(s => s.plannedAt)
    ])])
  ])).digest('hex');
  return { plan, cars, selected, fingerprint, scope };
}

function activeOffers(state, now) {
  const byTrip = new Map();
  for (const offer of state.offers) {
    if (offer.status !== 'pending' || offer.expiresAt <= now) continue;
    if (!byTrip.has(offer.tripId)) byTrip.set(offer.tripId, []);
    byTrip.get(offer.tripId).push(offer);
  }
  return byTrip;
}

function fleetProgress(state, ctx, now, offers, draft) {
  const drivers = new Map(state.drivers.filter(d => (d.demoRunId || null) === (ctx.driver.demoRunId || null))
    .map(d => [d.id, {id:d.id,name:d.name,assigned:0,completed:0,remaining:0,tentative:0,proposed:0}]));
  const left = [];
  const proposed = new Map();
  const reasons = new Map((draft?.plan.unplanned || []).map(t => [t.tripId,t.reason]));
  const previewCars = draft?.scope === 'fleet' ? draft.cars : [];
  for (const car of previewCars) {
    for (const stop of car.stops) {
      for (const tripId of stop.members) proposed.set(tripId, car.driverId);
      if (drivers.has(car.driverId)) drivers.get(car.driverId).proposed++;
    }
  }
  for (const trip of state.trips) {
    if (!ctx.includeTrip(trip) || trip.poolParentId || trip.status === 'cancelled' || proposed.has(trip.id)) continue;
    const assigned = drivers.get(trip.driverId);
    if (assigned) {
      assigned.assigned++;
      if (trip.status === 'completed') assigned.completed++;
      else assigned.remaining++;
      continue;
    }
    if (trip.status === 'completed') continue;
    const pending = offers.get(trip.id) || [];
    const scheduled = pending.length === 1 ? pending[0].driverId :
      pending.length === 0 && trip.pickupAt >= now ? trip.reservedDriverId || Planner.plannedDriver(trip) : null;
    const driver = drivers.get(scheduled);
    if (driver) { driver.tentative++; driver.remaining++; continue; }
    const reason = pending.length > 1 ? 'Waiting for a driver to accept the group offer' :
      trip.pickupAt < now ? 'Pickup time passed' : reasons.get(trip.id) || 'Awaiting assignment';
    left.push({ id:trip.id, reference:trip.reference, pickup:trip.pickup, pickupAt:trip.pickupAt, reason });
  }
  left.sort((a,b)=>a.pickupAt-b.pickupAt||a.reference.localeCompare(b.reference));
  const rows = [...drivers.values()].sort((a,b)=>a.name.localeCompare(b.name));
  return { drivers:rows, left, proposed:previewCars.reduce((n,car)=>n+car.stops.length,0) };
}

function timeline(state, ctx, now, draft) {
  const { driver, date, timezone, today, includeTrip } = ctx;
  const name = id => state.drivers.find(d => d.id === id)?.name || 'another driver';
  const byName = new Map(D.places.map(place => [place.name, place]));
  const offers = activeOffers(state, now);
  const proposed = draft?.selected?.stops || [];
  const proposedMembers = new Set(proposed.flatMap(stop => stop.members));
  const alternatives = new Map((draft?.plan.cars || []).filter(car => car.driverId !== driver.id)
    .flatMap(car => car.stops.flatMap(stop => stop.members.map(id => [id, car.name]))));
  const failures = new Map((draft?.plan.unplanned || []).map(row => [row.tripId, row.reason]));
  const rows = [];
  for (const trip of state.trips) {
    if (!includeTrip(trip) || trip.poolParentId || proposedMembers.has(trip.id)) continue;
    const regular = D.regularDriver(state, trip) === driver.id;
    const planned = Planner.plannedDriver(trip);
    let status, note;
    if (trip.driverId === driver.id) status = trip.status;
    else if (['completed','cancelled'].includes(trip.status)) continue;
    else if (offers.get(trip.id)?.some(offer => offer.driverId === driver.id)) status = 'offer';
    else if (trip.reservedDriverId === driver.id) status = 'reserved';
    else if (regular && (trip.driverId || trip.reservedDriverId)) {
      status = 'fallback';
      note = 'With ' + name(trip.driverId || trip.reservedDriverId);
    } else if (planned === driver.id && !trip.driverId && !trip.reservedDriverId && !offers.has(trip.id) && trip.pickupAt >= now) status = 'planned';
    else if (regular && (alternatives.has(trip.id) || planned && trip.pickupAt >= now)) {
      status = 'fallback';
      note = (alternatives.has(trip.id) ? 'Draft suggests ' + alternatives.get(trip.id) : 'Planned with ' + name(planned));
    } else if (regular) {
      status = 'preference';
      note = failures.get(trip.id) || (trip.pickupAt < now ? 'Pickup time passed' : 'Awaiting a feasible assignment');
    } else continue;
    const from = byName.get(trip.pickup), to = byName.get(trip.destination);
    const duration = trip.routeDurationMinutes || (from && to ? Planner.minutes(from,to) : null);
    const inProgress = ['accepted','heading_to_pickup','arrived','onboard'].includes(trip.status);
    const start = trip.startedAt || (inProgress ? Math.max(trip.pickupAt,now) : trip.pickupAt);
    const endAt = trip.completedAt || (duration === null ? null : start + (duration+5)*60000);
    rows.push({ tripId:trip.id, reference:trip.reference, pickup:trip.pickup, destination:trip.destination,
      pickupAt:trip.pickupAt, endAt, status, note, regular, shared:trip.sharedStops?.map(stop=>({
        pickup:stop.pickup, pickupAt:stop.plannedAt, passengers:stop.passengers
      })) });
  }
  for (const stop of proposed) {
    const regular = stop.members.some(id => {
      const trip = state.trips.find(t => t.id === id);
      return trip && D.regularDriver(state, trip) === driver.id;
    });
    rows.push({ tripId:stop.members.length === 1 ? stop.members[0] : null, reference:stop.reference,
      pickup:stop.pickup, destination:stop.destination, pickupAt:stop.pickupAt, endAt:stop.endAt,
      status:'proposed', regular, shared:stop.sharedStops.map(s=>({pickup:s.pickup,pickupAt:s.plannedAt,passengers:s.passengers})) });
  }
  rows.sort((a,b)=>a.pickupAt-b.pickupAt||a.reference.localeCompare(b.reference));
  let previous;
  for (const row of rows) {
    if (['fallback','preference','cancelled','completed'].includes(row.status)) continue;
    const from = previous && byName.get(previous.destination), to = byName.get(row.pickup);
    if (previous?.endAt && from && to && previous.endAt + Planner.minutes(from,to)*60000 > row.pickupAt) {
      row.conflict = 'Tight gap after ' + previous.reference;
    }
    if (!previous || (row.endAt ?? 0) > (previous.endAt ?? 0)) previous = row;
  }
  return { driver:{ id:driver.id, name:driver.name, vehicle:driver.vehicle, seats:driver.seats },
    date, today, timezone, rows, proposedCount:proposed.length, previewKey:draft?.fingerprint || null,
    previewScope:draft?.scope || null, fleet:fleetProgress(state,ctx,now,offers,draft) };
}

function view(state, input, now) {
  const ctx = context(state, input.driverId, input.date, now);
  return timeline(state, ctx, now, input.action === 'preview' ? proposal(state,ctx,now,input.scope) : null);
}
function save(state, input, actor, now) {
  const ctx = context(state, input.driverId, input.date, now);
  const draft = proposal(state, ctx, now, input.scope);
  if (input.previewKey !== draft.fingerprint || !draft.cars.length) {
    const error = Error('The schedule changed. Preview the day again before saving.');
    error.status = 409;
    throw error;
  }
  const stops = draft.cars.flatMap(car => car.stops);
  Shared.apply(state, { ...draft.plan, cars:draft.cars, unplanned:[],
    summary:{ planned:stops.length, bookings:stops.reduce((n,s)=>n+s.members.length,0), carsUsed:draft.cars.length, unplanned:0 } }, actor, now);
  const label = input.scope === 'fleet' ? draft.cars.length + ' drivers' : ctx.driver.name;
  D.event(state, 'plan.driver_day_saved', null, actor, label + ' · ' + ctx.date + ' · ' + stops.length + ' planned rides');
  return timeline(state, ctx, now);
}
module.exports = { view, save };
