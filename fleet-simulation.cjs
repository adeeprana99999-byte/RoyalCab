const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname,'data','lgtc-20261114-simulation-ready.csv');
const parse = line => Array.from(line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g), match=>match[1].replaceAll('""','"'));
const minute = time => Number(time.slice(0,2))*60+Number(time.slice(3));
const rides = fs.readFileSync(file,'utf8').trim().split(/\r?\n/).slice(1).map(line=>{
  const [driver,car,type,row,reference,pickup,end,basis] = parse(line);
  return {driver,car,type,row,reference,pickup,end,basis};
});
if (rides.length!==284 || new Set(rides.map(ride=>ride.row)).size!==284 ||
    new Set(rides.map(ride=>ride.driver)).size!==37) throw Error('Invalid full-fleet simulation file.');
const start = Math.min(...rides.map(ride=>minute(ride.pickup)-15));
const finish = Math.max(...rides.map(ride=>minute(ride.end)));
const offerTimes = [...new Set(rides.map(ride=>minute(ride.pickup)-15))].sort((a,b)=>a-b);
let startedAt = null;
let elapsed = 0;
let speed = 1;
const elapsedAt = now => elapsed+(startedAt===null?0:(now-startedAt)*speed);
const clock = () => Math.min(finish,start+Math.floor(elapsedAt(performance.now())/250));
const format = value => String(Math.floor(value/60)).padStart(2,'0')+':'+String(value%60).padStart(2,'0');

function serveFleet(req,res) {
  const speedRequest = /^\/owner\/fleet-simulation\/speed\?rate=([^&]+)$/.exec(req.url);
  const jumpRequest = /^\/owner\/fleet-simulation\/jump\?time=([^&]*)$/.exec(req.url);
  if (req.method==='POST' && (jumpRequest || speedRequest || ['/owner/fleet-simulation/restart','/owner/fleet-simulation/start','/owner/fleet-simulation/pause','/owner/fleet-simulation/next-offer','/owner/fleet-simulation/previous-offer'].includes(req.url))) {
    if (req.headers.origin && req.headers.origin!=='http://'+req.headers.host) {
      res.writeHead(403);res.end();return true;
    }
    const now = performance.now();
    if (jumpRequest) {
      const time = jumpRequest[1];
      if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) || minute(time)<start || minute(time)>=finish) {
        res.writeHead(400);res.end();return true;
      }
      if (startedAt!==null) {
        res.writeHead(409);res.end();return true;
      }
      elapsed=(minute(time)-start)*250;
    } else if (speedRequest) {
      const rate = Number(speedRequest[1]);
      if (![0.25,0.5,1,2,4].includes(rate)) {
        res.writeHead(400);res.end();return true;
      }
      elapsed=elapsedAt(now);
      if (startedAt!==null) startedAt=now;
      speed=rate;
    } else if (req.url.endsWith('/restart')) {
      startedAt=null;
      elapsed=0;
    } else if (req.url.endsWith('/pause')) {
      elapsed=elapsedAt(now);
      startedAt=null;
    } else if (req.url.endsWith('/next-offer') || req.url.endsWith('/previous-offer')) {
      const current = clock();
      const next = req.url.endsWith('/previous-offer') ? offerTimes.findLast(time=>time<current) : offerTimes.find(time=>time>current);
      if (startedAt!==null || next===undefined) {
        res.writeHead(409);res.end();return true;
      }
      elapsed=(next-start)*250;
    } else if (clock()<finish) startedAt ??= now;
    res.writeHead(204);res.end();return true;
  }
  if (req.method!=='GET') return false;
  if (req.url==='/owner/fleet-simulation/progress') {
    const now=clock();
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify({clock:format(now),firstTime:format(start),lastTime:format(finish-1),speed,phase:now===finish?'Finished':startedAt===null?'Paused':'Running',canResume:elapsed>0,
      canRewindOffer:startedAt===null&&offerTimes.some(time=>time<now), canAdvanceOffer:startedAt===null&&offerTimes.some(time=>time>now),rides:rides.map(ride=>{
      const pickup=minute(ride.pickup);
      const status=now>=minute(ride.end)?'Completed':now>=pickup?'Onboard':now>=pickup-10?'Heading to pickup':now>=pickup-15?'Offer pending':'Scheduled';
      return {...ride,status};
    })}));
    return true;
  }
  if (req.url!=='/owner/fleet-simulation') return false;
  res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
  res.end(fs.readFileSync(path.join(__dirname,'public','fleet-simulation.html')));
  return true;
}
const simulationDrivers = [...new Map(rides.map(ride=>[ride.driver,ride])).values()];
module.exports={serveFleet,simulationDrivers,simulationRides:rides};
