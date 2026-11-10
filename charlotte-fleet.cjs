'use strict';
const D=require('./domain.cjs'),Location=require('./location.cjs'),Ops=require('./operations.cjs');
const spots=[{name:'CLT Uptown · demo pickup',lat:35.2271,lng:-80.8431},{name:'CLT Government Center · demo pickup',lat:35.2211,lng:-80.8392},{name:'CLT South End · demo pickup',lat:35.2135,lng:-80.8560},{name:'CLT First Ward · demo pickup',lat:35.2310,lng:-80.8340}];
function installPlaces(){for(const p of spots)if(!D.places.some(x=>x.name===p.name))D.places.push(p);}installPlaces();
function stop(s,now=Date.now()){
 const run=s.fleetScenario;if(!run)return;
 for(const t of s.trips.filter(t=>t.demoRunId===run.runId&&!['completed','cancelled'].includes(t.status))){Ops.outcome(s,t,'cancelled',now);t.status='cancelled';t.driverId=null;t.autoDispatch=false;t.demoStopped=true;for(const o of s.offers.filter(o=>o.tripId===t.id&&o.status==='pending'))o.status='cancelled';}
 for(const d of s.drivers.filter(d=>d.demoRunId===run.runId)){d.status='offline';d.trackingEnabled=false;}run.status='stopped';run.stoppedAt=now;
}
function point(s,d,p,now){const r=Location.ingest(s,{role:'driver',driverId:d.id},{points:[{id:'fleet-'+now+'-'+d.id,latitude:p.lat,longitude:p.lng,accuracy:8,capturedAt:now}]},now);if(!r.accepted.length)throw Error('Scenario location rejected');const trail=s.fleetScenario.trails[d.id]||[];trail.push({lat:p.lat,lng:p.lng,at:now});s.fleetScenario.trails[d.id]=trail.slice(-100);}
function start(s,now=Date.now()){
 stop(s,now);const runId=D.id('clt-fleet');s.fleetScenario={runId,status:'running',city:'Charlotte, NC',startedAt:now,lastTickAt:now,trails:{},tripIds:[],driverIds:[]};
 const positions=[{lat:35.2268,lng:-80.8436},{lat:35.2205,lng:-80.8397},{lat:35.2130,lng:-80.8565},{lat:35.2330,lng:-80.8325}];
 positions.forEach((p,i)=>{const d={id:D.id('clt-car'),name:'CLT Car '+(i+1),phone:'+1555010900'+i,seats:i===1?7:4,capabilities:[],vehicle:['Blue sedan','White SUV','Black sedan','Silver sedan'][i],plate:'TEST CLT '+(i+1),status:'online',demoRunId:runId,demoScenario:'charlotte-fleet',testCarNumber:i+1,locationSource:'scenario',trackingSimulation:true,trackingEnabled:true,lat:p.lat,lng:p.lng,lastLocationAt:0};s.drivers.push(d);s.fleetScenario.driverIds.push(d.id);point(s,d,p,now);});
 [[0,1],[1,2],[2,0],[3,1],[0,2],[1,3]].forEach(([from,to],i)=>{const t={id:D.id('clt-trip'),reference:'CLT-DEMO-'+(i+1),demoRunId:runId,demoScenario:'charlotte-fleet',customerName:'Test passenger '+(i+1),customerPhone:'+15550102001',pickup:spots[from].name,destination:spots[to].name,pickupAt:now+(60+i*10)*1000,passengers:1,requirements:[],status:'awaiting_driver',driverId:null,redFlag:false,excluded:[],autoDispatch:true,createdAt:now};s.trips.push(t);s.fleetScenario.tripIds.push(t.id);});
 D.tick(s,now);return s.fleetScenario;
}
function tick(s,now=Date.now()){
 const run=s.fleetScenario;if(!run||run.status!=='running'||now-run.lastTickAt<2500)return false;run.lastTickAt=now;
 const trips=s.trips.filter(t=>t.demoRunId===run.runId),drivers=s.drivers.filter(d=>d.demoRunId===run.runId);

 for(const t of trips){
  const pending=s.offers.find(o=>o.tripId===t.id&&o.status==='pending');
  if(t.status==='offered'&&pending&&now-pending.offeredAt>=6000){const d=s.drivers.find(d=>d.id===pending.driverId);D.action(s,t,'accept',{role:'driver',driverId:d.id,name:d.name},{offerId:pending.id},now);t.demoStageAt=now;continue;}
  if(!t.driverId||['completed','cancelled'].includes(t.status))continue;const d=drivers.find(d=>d.id===t.driverId),u={role:'driver',driverId:d.id,name:d.name};
  if(t.status==='accepted'&&now-t.demoStageAt>=3000){D.action(s,t,'depart',u,{},now);t.demoStageAt=now;t.demoMotion={from:{lat:d.lat,lng:d.lng},to:spots.find(p=>p.name===t.pickup),startedAt:now,duration:18000+d.testCarNumber*3000};}
  else if(t.status==='arrived'&&now-t.demoStageAt>=6000){D.action(s,t,'pickup',u,{},now);t.demoStageAt=now;t.demoMotion={from:{lat:d.lat,lng:d.lng},to:spots.find(p=>p.name===t.destination),startedAt:now,duration:27000+d.testCarNumber*3000};}
  else if(['heading_to_pickup','onboard'].includes(t.status)&&t.demoMotion){const m=t.demoMotion,f=Math.min(1,(now-m.startedAt)/m.duration);t.demoLegProgress=f;
   // Interpolated test points, not a road-navigation route.
   const p={lat:m.from.lat+(m.to.lat-m.from.lat)*f,lng:m.from.lng+(m.to.lng-m.from.lng)*f};
   point(s,d,p,now);
   if(f===1){D.action(s,t,t.status==='onboard'?'complete':'arrive',u,{},now);t.demoStageAt=now;t.demoMotion=null;}
  }
 }
 for(const d of drivers)if(d.status!=='offline'&&d.lastLocationAt<now)point(s,d,d,now);
 D.tick(s,now);
 if(trips.every(t=>['completed','cancelled'].includes(t.status))){run.status='finished';run.finishedAt=now;}return true;
}
module.exports={start,stop,tick,spots};
