'use strict';
const LGTC = require('../lgtc.cjs');
const domain = require('../domain.cjs');
const { workbook } = require('../excel.cjs');
const { startDispatch } = require('./planned-dispatch.cjs');

const serviceDate = '2026-11-03';
const runId = 'mongo-lgtc-replay';
const isEnabled = (record, status, disabled) => record[status] === 'Enabled' && !record[disabled];

function hostedReplay(db, {intervalMs} = {}) {
  let run, plan, starting, revision = 0;
  async function start() {
    if (run?.remaining && !run.error) return;
    if (starting) return starting;
    starting = (async()=>{
      const [rows,drivers,vehicles] = await Promise.all([
        db.collection('lgtc_rides').find({service_date:serviceDate}).sort({source_row:1}).toArray(),
        db.collection('drivers').find({}).toArray(),
        db.collection('vehicles').find({}).toArray()
      ]);
      const fleet = vehicles.filter(vehicle=>isEnabled(vehicle,'Vehicle Status','vehicleDisabled'));
      const roster = drivers.filter(driver=>isEnabled(driver,'Driver Status','driverDisabled'))
        .sort((a,b)=>a.name.localeCompare(b.name)).slice(0,fleet.length).map((driver,index)=>{
          const vehicle=fleet[index];
          return {id:driver._id,name:driver.name,vehicleId:vehicle._id,vehicle:vehicle['Vehicle Name'],
            seats:vehicle.seats ?? 4,capabilities:vehicle.wheelchairAccessible === true ? ['wheelchair'] : [],
            recurringShift:{days:[2],start:0,end:1439},rosterManaged:true};
        });
      const batch = LGTC.detect('LGTC_MongoDB.xlsx',workbook(rows.map(row=>row.details.sourceFields)).toString('base64'));
      if (!batch || batch.rows.length !== 284) throw Error('The November 3 replay requires the 284 imported LGTC rides.');
      const profiles = {A:{mode:'standard',base:1,extras:[]},W:{mode:'accessible',base:1,extras:[]}};
      const nextPlan=LGTC.plan(batch,{serviceDate,buffer:30,profiles,driverIds:roster.map(driver=>driver.id)},
        {roster,allowEmptyRoster:true});
      if (nextPlan.allocated !== 51 || nextPlan.unplanned.length !== 233) {
        throw Error('The current fleet and ride data produced '+nextPlan.allocated+' assigned and '+
          nextPlan.unplanned.length+' for review. The 51-ride replay requires the original test plan.');
      }
      plan=nextPlan;
      run=startDispatch(plan,intervalMs);
      revision+=10000;
    })();
    try { await starting; } finally { starting=null; }
  }
  function project(snapshot) {
    if (!run) return;
    const {state,at,remaining,error} = run;
    const [pickup,dropoff] = domain.places;
    snapshot.drivers.push(...state.drivers.map((driver,index)=>{
      const trip=state.trips.find(ride=>ride.driverId===driver.id && ride.status==='onboard');
      const progress=trip?Math.min(1,Math.max(0,(at-trip.pickupAt)/Math.max(1,trip.plannedEndAt-trip.pickupAt))):0;
      const angle=index*2.399963;
      return {...driver,demoRunId:runId,
        lat:pickup.lat+(dropoff.lat-pickup.lat)*progress+Math.cos(angle)*0.0015,
        lng:pickup.lng+(dropoff.lng-pickup.lng)*progress+Math.sin(angle)*0.0015};
    }));
    snapshot.trips.push(...state.trips.map(ride=>({...ride,demoRunId:runId})));
    snapshot.offers.push(...state.offers);
    snapshot.events.push(...state.events);
    snapshot.lgtcReplay={runId,serviceDate,at,held:plan.unplanned.length,running:!!remaining&&!error,error};
    snapshot.revision+=revision+state.trips.length*6-remaining;
  }
  return {start,project,review:()=>plan?.unplanned.map(ride=>({reference:ride.reference,reasons:ride.reasons})) || []};
}
module.exports = { hostedReplay };
