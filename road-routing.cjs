const ENDPOINT = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
const MAX_LOCATION_AGE = 120000;
const MAX_ROUTE_AGE = 30000;

function deviceReady(driver, now) {
  return driver.locationSource === 'device' && driver.trackingEnabled === true &&
    Number.isFinite(driver.lat) && Number.isFinite(driver.lng) &&
    Number.isFinite(driver.locationAccuracy) && driver.locationAccuracy <= 100 &&
    driver.lastLocationAt <= now && now - driver.lastLocationAt <= MAX_LOCATION_AGE;
}
const requiresRoad = trip => !trip.demoRunId && !trip.lgtc?.test;
const monitorsPickup = trip => !trip.poolParentId && requiresRoad(trip) && !!trip.driverId &&
  ['accepted','heading_to_pickup'].includes(trip.status);
const pointKey = point => point.lat + ',' + point.lng;
const routeKey = (driver, stop) => driver.id + '|' + pointKey(stop);

function googleMatrix(key, fetchImpl = fetch) {
  if (!key) throw Error('Road dispatch requires a separate server Routes API key.');
  const waypoint = ({lat,lng}) => ({ waypoint:{ location:{ latLng:{ latitude:lat, longitude:lng } } } });
  return async (origins, destinations) => {
    let response;
    try {
      response = await fetchImpl(ENDPOINT,{
        method:'POST', signal:AbortSignal.timeout(5000),
        headers:{'Content-Type':'application/json','X-Goog-Api-Key':key,
          'X-Goog-FieldMask':'originIndex,destinationIndex,status,condition,duration'},
        body:JSON.stringify({ origins:origins.map(waypoint), destinations:destinations.map(waypoint),
          travelMode:'DRIVE', routingPreference:'TRAFFIC_AWARE' })
      });
    } catch { throw Error('Google Routes could not be reached.'); }
    if (!response.ok) throw Error('Google Routes returned HTTP ' + response.status + '.');
    try {
      const rows = await response.json();
      if (!Array.isArray(rows)) throw Error();
      return rows;
    } catch { throw Error('Google Routes returned an invalid route matrix.'); }
  };
}

function createRoadRouting(matrix) {
  const cache = new Map();
  const direct = new Map();
  let status = 'waiting', lastMatrixAt = null, lastError = null, inFlight, retryAfter = 0, monitorCursor = 0;
  function get(driver, stop, now) {
    if (!stop || !deviceReady(driver,now)) return null;
    const row = cache.get(routeKey(driver,stop));
    if (!row || now - row.at >= MAX_ROUTE_AGE) return null;
    // Refresh after a material change in GPS position. Invalidate immediately if sharing stops.
    const delta = Math.hypot((row.lat-driver.lat)*111000,(row.lng-driver.lng)*111000);
    return delta <= 50 ? row : null;
  }
  async function quote(origins, stop, clock) {
    const result = await matrix(origins.map(({lat,lng})=>({lat,lng})),[{lat:stop.lat,lng:stop.lng}]);
    const at=clock(), seen=new Set();
    for (const element of result) {
      const i=element.originIndex ?? 0;
      if (!Number.isInteger(i) || (element.destinationIndex ?? 0)!==0 || !origins[i] || seen.has(i) || (element.status?.code ?? 0)!==0) continue;
      const duration=typeof element.duration==='string' && /^(\d+(?:\.\d+)?)s$/.exec(element.duration);
      const noRoute=element.condition==='ROUTE_NOT_FOUND';
      if (!noRoute && (element.condition!=='ROUTE_EXISTS' || !duration || !Number.isFinite(+duration[1]))) continue;
      seen.add(i);
      const driver=origins[i], key=routeKey(driver,stop);
      if ((cache.get(key)?.fixAt ?? 0)>driver.lastLocationAt) continue;
      const seconds=noRoute?null:+duration[1];
      cache.set(key,{lat:driver.lat,lng:driver.lng,at,fixAt:driver.lastLocationAt,seconds,
        minutes:seconds===null?null:Math.max(1,Math.ceil(seconds/60))});
    }
    if (seen.size!==origins.length) throw Error('Google Routes did not verify every candidate route.');
  }
  function ready(clock) { status='ready';lastError=null;lastMatrixAt=clock(); }
  function blocked(error,clock) { status='blocked';lastError=error.message;retryAfter=clock()+10000; }
  async function prepareOffer(driver, stop, clock) {
    const now=clock();
    if (!stop || !driver || !deviceReady(driver,now) || get(driver,stop,now) || now<retryAfter) return;
    const key=routeKey(driver,stop);
    if (direct.has(key)) return direct.get(key);
    const pending=(async()=>{
      try { await quote([driver],stop,clock);ready(clock); }
      catch (error) { blocked(error,clock); }
    })();
    direct.set(key,pending);
    try { await pending; } finally { direct.delete(key); }
  }
  async function prepare(state, trips, places, clock) {
    if (inFlight) return inFlight;
    const now = clock();
    for (const [key,row] of cache) if (now-row.at>=MAX_ROUTE_AGE) cache.delete(key);
    if (now < retryAfter) return;
    const pickupNames = new Set(trips.filter(requiresRoad).map(trip=>trip.pickup));
    const byName = new Map(places.map(p=>[p.name,p]));
    const stops = [...new Map([...pickupNames].map(name=>byName.get(name)).filter(Boolean).map(p=>[pointKey(p),p])).values()];
    const drivers = state.drivers.filter(d=>!d.demoRunId && d.status==='online' && deviceReady(d,now));
    if (!stops.length || !drivers.length || !stops.some(stop=>drivers.some(d=>!get(d,stop,now)))) return;
    inFlight = (async()=>{
      try {
        // One pickup per request keeps repeated pickups cheap and bounds each provider call.
        const targets = stops.filter(stop=>drivers.some(d=>!get(d,stop,now)));
        let budget = 4;
        quotes: for (const stop of targets) {
          const needed = drivers.filter(d=>!get(d,stop,now));
          for (let start=0;start<needed.length;start+=25) {
            if (!budget--) break quotes;
            await quote(needed.slice(start,start+25),stop,clock);
          }
        }
        ready(clock);
      } catch (error) { blocked(error,clock); }
    })();
    try { await inFlight; } finally { inFlight = null; }
  }
  async function monitorPickups(state, places, clock) {
    const now=clock(), drivers=new Map(state.drivers.map(d=>[d.id,d])), stops=new Map(places.map(p=>[p.name,p]));
    const pending=state.trips.filter(monitorsPickup).map(trip=>({driver:drivers.get(trip.driverId),stop:stops.get(trip.pickup)}))
      .filter(({driver,stop})=>driver&&stop&&deviceReady(driver,now)&&!get(driver,stop,now));
    if(!pending.length||now<retryAfter) return;
    const index=monitorCursor%pending.length;
    monitorCursor=index+1;
    const {driver,stop}=pending[index];
    // Refresh one confirmed pickup per worker pass. New offers keep their existing routing budget.
    await prepareOffer(driver,stop,clock);
    return true;
  }
  function pickupForecast(trip, driver, stop, now) {
    if(!monitorsPickup(trip)) return null;
    if(!driver||!deviceReady(driver,now)) return {status:'gps_unavailable'};
    const route=get(driver,stop,now);
    if(!route||route.minutes===null) return {status:'eta_unavailable'};
    const arrivalAt=route.at+route.seconds*1000;
    return {status:'available',arrivalAt,checkedAt:route.at,expiresAt:route.at+MAX_ROUTE_AGE,
      lateMinutes:Math.max(0,Math.ceil((arrivalAt-trip.pickupAt)/60000))};
  }
  return { get, prepare, prepareOffer, monitorPickups, pickupForecast, health:()=>({mode:'road',status,lastMatrixAt,lastError}) };
}
module.exports = { googleMatrix, createRoadRouting, deviceReady, requiresRoad };
