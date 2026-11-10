'use strict';
// Validates device readings. Authentication must supply the driver identity.
const MAX_AGE=120000,MAX_FUTURE=30000,MAX_ACCURACY=100;
function ingest(state,user,body,now=Date.now()){
 if(user?.role!=='driver'||!user.driverId)throw Error('Driver access required');
 const driver=state.drivers.find(d=>d.id===user.driverId);if(!driver)throw Error('Driver not found');
 if(driver.trackingEnabled===false)throw Error('Location sharing is stopped');
 if(driver.status==='offline')throw Error('Go online before sharing location');
 if(!Array.isArray(body?.points)||!body.points.length||body.points.length>30)throw Error('Send 1–30 location readings');
 if(body.driverId&&body.driverId!==user.driverId)throw Error('Driver identity cannot be overridden');
 const accepted=[],rejected=[];
 // Timestamp order also handles queued or out-of-order batches.
 const points=body.points.map((point,index)=>({point,index})).sort((a,b)=>(a.point?.capturedAt||0)-(b.point?.capturedAt||0));
 for(const {point:p,index} of points){
  let reason='';
  if(!p||typeof p.id!=='string'||!/^[a-zA-Z0-9_-]{8,100}$/.test(p.id))reason='invalid_id';
  else if(!Number.isFinite(p.latitude)||Math.abs(p.latitude)>90||!Number.isFinite(p.longitude)||Math.abs(p.longitude)>180)reason='invalid_coordinates';
  else if(!Number.isFinite(p.accuracy)||p.accuracy<0||p.accuracy>MAX_ACCURACY)reason='inaccurate';
  else if(!Number.isSafeInteger(p.capturedAt)||p.capturedAt<now-MAX_AGE||p.capturedAt>now+MAX_FUTURE)reason='invalid_time';
  else if(['device','replay','scenario'].includes(driver.locationSource)&&(p.capturedAt<=driver.lastLocationAt||p.id===driver.lastLocationPointId))reason='duplicate_or_older';
  if(reason){rejected.push({index,id:typeof p?.id==='string'?p.id.slice(0,100):null,reason});continue;}
  driver.lat=p.latitude;driver.lng=p.longitude;driver.lastLocationAt=p.capturedAt;driver.locationReceivedAt=now;driver.locationAccuracy=p.accuracy;driver.lastLocationPointId=p.id;driver.locationSource=driver.locationSource==='scenario'?'scenario':driver.trackingSimulation?'replay':'device';accepted.push(p.id);
 }
 return {accepted,rejected,serverTime:now};
}
module.exports={ingest,MAX_AGE,MAX_FUTURE,MAX_ACCURACY};
