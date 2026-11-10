const D = require('./domain.cjs');
const Operations = require('./operations.cjs');
const Reservations = require('./reservations.cjs');
const { spots } = require('./charlotte-fleet.cjs');

function seed(state, now, { restart = false } = {}) {
  const previous = state.queueReviewDemo;
  if (previous && !restart) return previous;
  if (previous) {
    for (const trip of state.trips.filter(t=>t.demoRunId===previous.runId && !['completed','cancelled'].includes(t.status))) {
      Reservations.release(state,trip,'cancelled','Queue test restarted',now);
      Operations.outcome(state,trip,'cancelled',now);
      trip.status = 'cancelled';
      trip.cancelledAt = now;
      trip.autoDispatch = false;
    }
    for (const driver of state.drivers.filter(d=>d.demoRunId===previous.runId)) driver.status = 'offline';
    for (const offer of state.offers.filter(o=>o.status==='pending')) {
      if (state.trips.some(t=>t.demoRunId===previous.runId&&t.id===offer.tripId)) {
        offer.status = 'cancelled';
        offer.respondedAt = now;
      }
    }
  }
  const runId = D.id('queue-review');
  const drivers = Array.from({length:16},(_,i)=>{
    const place = spots[i % spots.length], number = String(i+1).padStart(2,'0');
    return {
      id:D.id('queue-driver'), name:'Queue Test Driver '+number, phone:'+120255501'+number,
      seats:i%4===0 ? 7 : 4, capabilities:i%4===0 ? ['wheelchair'] : [],
      vehicle:i%4===0 ? 'Test accessible van' : 'Test sedan', plate:'QUEUE '+runId.slice(-4)+' '+number,
      status:i<10 ? 'busy' : 'online', lat:place.lat+i*.00012, lng:place.lng-i*.00008,
      lastLocationAt:now, demoRunId:runId, testData:true
    };
  });
  state.drivers.push(...drivers);
  const lead = Operations.settings(state).dispatchLeadMinutes;
  for (const bucket of ['now','later','attention']) {
    for (let i=0;i<50;i++) {
      const from = spots[i%spots.length], to = spots[(i+1)%spots.length];
      const number = String(i+1).padStart(2,'0');
      const active = bucket==='now' && i<10;
      const review = bucket==='attention';
      const dropped = review && i>=20 && i<35;
      const noDriver = review && i>=35;
      const minutes = active ? (i<5?5:-5) : bucket==='later' ? 90+i*8 : review ? -15-i :
        i<16 ? Math.min(lead,12) : 35+(i-16)%23;
      const rider = i%5;
      const trip = {
        id:D.id('queue-trip'), reference:'QUEUE-'+runId.slice(-4)+'-'+bucket.toUpperCase()+'-'+number,
        customerName:'Queue Test Rider '+(rider+1), customerPhone:'+1202555018'+rider,
        pickup:from.name, destination:to.name, pickupAt:now+minutes*60000, passengers:1+i%4, requirements:[],
        status:dropped?'needs_reassignment':'awaiting_driver', driverId:null,
        redFlag:dropped, dispatchExhausted:noDriver, excluded:[], createdAt:now, demoRunId:runId,
        demoScenario:'queue-review', testData:true, autoDispatch:false
      };
      if (noDriver) trip.dispatchError = 'No suitable driver was available when dispatch tried.';
      if (active) {
        const driver = drivers[i], acceptedAt = now-600000;
        const offer = {id:D.id('queue-offer'), tripId:trip.id, driverId:driver.id, status:'accepted',
          offeredAt:acceptedAt-1000, respondedAt:acceptedAt, expiresAt:acceptedAt+45000, attemptNumber:1, mode:'fixture'};
        state.offers.push(offer);
        trip.driverId = driver.id;
        trip.status = i<5?'heading_to_pickup':'onboard';
        Operations.confirmed(state,trip,driver,offer,acceptedAt);
        if (trip.status==='onboard') Operations.started(state,trip,now-300000);
      }
      state.trips.push(trip);
    }
  }
  for (let i=0;i<5;i++) {
    const phone = '+1202555018'+i;
    state.customerPreferences[runId+':'+phone] = {driverId:drivers[10+i].id};
  }
  const run = {runId,createdAt:now,count:150,initial:{now:50,later:50,attention:50}};
  state.queueReviewDemo = run;
  D.event(state,'demo.queue_review_created',null,'Owner','150 isolated Charlotte bookings for queue review');
  return run;
}
module.exports = { seed };
