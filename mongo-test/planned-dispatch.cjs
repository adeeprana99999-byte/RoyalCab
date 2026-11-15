'use strict';
const domain = require('../domain.cjs');
const LGTC = require('../lgtc.cjs');

function startDispatch(plan, intervalMs = 900) {
  const firstPickup = Math.min(...plan.runs.flatMap(run=>run.trips.map(ride=>ride.start)));
  const start = LGTC.easternPickup(plan.serviceDate,firstPickup) - 600000;
  const state = domain.seed(start);
  const [pickup,destination] = domain.places;
  const roster = plan.runs.filter(run=>run.trips.length);
  state.drivers = roster.map(run=>({id:run.driverId,name:run.label,vehicle:run.vehicle,
    status:'online',seats:run.seats,capabilities:run.accessible?['wheelchair']:[],
    lat:pickup.lat,lng:pickup.lng,lastLocationAt:start}));
  state.trips = roster.flatMap(run=>run.trips.map(ride=>({
    id:domain.id('trip'), reference:ride.reference, customerName:'LGTC test rider',
    pickup:pickup.name,destination:destination.name, pickupAt:LGTC.easternPickup(plan.serviceDate,ride.start),
    plannedEndAt:LGTC.easternPickup(plan.serviceDate,ride.end), passengers:ride.seats,
    requirements:ride.mode==='accessible'?['wheelchair']:[], status:'awaiting_driver',
    plannedDriverId:run.driverId,driverId:null,excluded:[],createdAt:start
  })));
  const events = state.trips.flatMap(ride=>[
    [ride.pickupAt-600000,'offer'],[ride.pickupAt-599000,'accept'],
    [ride.pickupAt-480000,'depart'],[ride.pickupAt-60000,'arrive'],
    [ride.pickupAt,'pickup'],[ride.plannedEndAt,'complete']
  ].map(([at,action])=>({at,action,ride}))).sort((a,b)=>a.at-b.at);
  let index = 0;
  const run = {state,at:start,remaining:events.length,error:null};
  const timer = setInterval(()=>{
    if (index===events.length) {clearInterval(timer);return;}
    const {at,action,ride} = events[index];
    try {
      run.at=at;
      for (const driver of state.drivers) driver.lastLocationAt=at;
      if (action==='offer') {

        domain.offer(state,ride,'Local dispatch test',at,{driverId:ride.plannedDriverId,mode:'manual'});
      } else {
        const driver = state.drivers.find(driver=>driver.id===ride.plannedDriverId);
        const offerId = state.offers.find(offer=>offer.tripId===ride.id)?.id;
        domain.action(state,ride,action,{role:'driver',driverId:driver.id,name:driver.name},{offerId},at);
      }
      run.remaining=events.length-++index;

    } catch (error) {
      clearInterval(timer);
      run.error=error.message;

    }
  },intervalMs);
  return run;
}
module.exports = {startDispatch};
