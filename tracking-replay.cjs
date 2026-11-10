'use strict';
const Location=require('./location.cjs');
const DRIVER='tracking-test-driver';
// Synthetic Charlotte waypoints for UI testing, not a navigation route.
const route=[{lat:35.2211,lng:-80.8392},{lat:35.2224,lng:-80.8402},{lat:35.2238,lng:-80.8413},{lat:35.2250,lng:-80.8423},{lat:35.2260,lng:-80.8428},{lat:35.2271,lng:-80.8431}];
function start(s,now=Date.now()){
 let d=s.drivers.find(d=>d.id===DRIVER);if(!d){d={id:DRIVER,name:'TEST · Moving driver',phone:'+15550109990',plate:'TEST GPS',vehicle:'Coordinate replay',seats:4,capabilities:[],demoRunId:'tracking-replay'};s.drivers.push(d);}
 Object.assign(d,{status:'online',trackingSimulation:true,trackingEnabled:true,locationSource:'replay',lat:null,lng:null,lastLocationAt:0,lastLocationPointId:null});
 s.trackingReplay={routeKey:'charlotte-v1',city:'Charlotte, NC',status:'running',driverId:DRIVER,startedAt:now,lastTickAt:now,durationMs:120000,progress:0,sequence:0,trail:[],route};tick(s,now);return s.trackingReplay;
}
function control(s,action,now=Date.now()){
 const r=s.trackingReplay;if(!r)throw Error('Start a tracking test first');
 if(action==='pause'&&r.status==='running'){r.pausedAt=now;r.status='paused';}
 else if(action==='resume'&&r.status==='paused'){r.startedAt+=now-r.pausedAt;r.status='running';}
 else if(action==='stop'){r.status='stopped';const d=s.drivers.find(d=>d.id===DRIVER);d.trackingEnabled=false;d.status='offline';}
 else throw Error('This tracking test action is unavailable');return r;
}
function tick(s,now=Date.now()){
 const r=s.trackingReplay;if(!r||r.routeKey!=='charlotte-v1'||r.status!=='running'||now<r.lastTickAt||r.sequence>0&&now-r.lastTickAt<2500)return false;
 const progress=Math.min(1,Math.max(0,(now-r.startedAt)/r.durationMs)),n=progress*(route.length-1),i=Math.min(route.length-2,Math.floor(n)),f=n-i;
 const lat=route[i].lat+(route[i+1].lat-route[i].lat)*f,lng=route[i].lng+(route[i+1].lng-route[i].lng)*f;
 const result=Location.ingest(s,{role:'driver',driverId:DRIVER},{points:[{id:'replay-point-'+r.startedAt+'-'+r.sequence,latitude:lat,longitude:lng,accuracy:8,capturedAt:now}]},now);
 if(!result.accepted.length)throw Error('Replay point rejected: '+result.rejected[0]?.reason);
 r.sequence++;r.lastTickAt=now;r.progress=progress;r.trail.push({lat,lng,at:now});r.trail=r.trail.slice(-60);if(progress===1)r.status='finished';return true;
}
module.exports={start,control,tick,DRIVER,route};
