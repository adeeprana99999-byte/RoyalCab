const D = require('./domain.cjs');
function nextRideScenario(s, now = Date.now()) {
  const priorRuns=new Set(s.trips.filter(t=>t.demoRunId&&t.demoScenario==='next-ride').map(t=>t.demoRunId));
  for (const trip of s.trips.filter(t => priorRuns.has(t.demoRunId) && !['completed','cancelled'].includes(t.status))) {
    if (trip.status === 'onboard') {
      const driver=s.drivers.find(d=>d.id===trip.driverId);
      D.action(s,trip,'complete',{role:'driver',driverId:driver.id,name:driver.name},{},now);
    } else D.action(s,trip,'cancel',{role:'owner',name:'Demo setup'},{},now);
  }
  for (const d of s.drivers.filter(d=>priorRuns.has(d.demoRunId))) d.status='offline';
  const runId=D.id('turnover');
  const driver={id:D.id('driver'),demoRunId:runId,name:'Demo Alex',phone:'+15550109801',status:'online',seats:4,capabilities:[],vehicle:'Demo sedan',plate:'DEMO NEXT',lat:40.7528,lng:-73.9773,lastLocationAt:now};
  const far={...driver,id:D.id('driver'),name:'Demo Sam · far away',phone:'+15550109802',plate:'DEMO FAR',lat:40.65,lng:-74.05};
  s.drivers.push(driver,far);
  function trip(reference,pickup,destination,minutes) {return {id:D.id('trip'),reference,demoRunId:runId,demoScenario:'next-ride',customerName:'Demo passenger',customerPhone:'+15550102001',pickup,destination,pickupAt:now+minutes*60000,passengers:1,requirements:[],status:'awaiting_driver',driverId:null,redFlag:false,excluded:[],createdAt:now,autoDispatch:true};}
  const preparedAt=now-20*60000;driver.lastLocationAt=preparedAt;far.lastLocationAt=preparedAt;
  const current=trip('DEMO-FINISH','Central Station','City Hospital',-10);s.trips.push(current);
  const offer=D.offer(s,current,'Demo setup',preparedAt);
  const actor={role:'driver',driverId:driver.id,name:driver.name};
  D.action(s,current,'accept',actor,{offerId:offer.id},preparedAt);
  for(const [index,command] of ['depart','arrive','pickup'].entries())D.action(s,current,command,actor,{},preparedAt+(index+1)*3*60000);
  // Simulated car has reached the current drop-off; GPS remains explicitly demo.
  const drop=D.places.find(p=>p.name==='City Hospital');driver.lat=drop.lat;driver.lng=drop.lng;driver.lastLocationAt=now;far.lastLocationAt=now;
  const next=trip('DEMO-NEXT','City Hospital','Park Avenue',10);
  const later=trip('DEMO-LATER','City Hospital','Downtown Office',180);
  s.trips.push(next,later);D.tick(s,now);
  D.event(s,'demo.next_ride_ready',current,'Demo setup','Finish this ride; DEMO-NEXT is due soon and DEMO-LATER is outside the dispatch window.');
  return {driverId:driver.id,driverName:driver.name,currentTripId:current.id,nextTripId:next.id,laterTripId:later.id,nextPickupAt:next.pickupAt,laterPickupAt:later.pickupAt};
}
module.exports={nextRideScenario};
