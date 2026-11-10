(function(root) {
  function attentionReason(trip, now = Date.now(), leadMinutes = 15) {
    if (trip.poolParentId || ['completed','cancelled'].includes(trip.status)) return '';
    if (trip.reservationIssue) return 'Reserved driver unavailable';
    if (trip.redFlag) return 'Driver replacement needed';
    if (trip.dispatchExhausted) return 'Driver search exhausted';
    if (trip.driverId && ['accepted','heading_to_pickup'].includes(trip.status) && trip.pickupAt < now) return 'Driver confirmed · pickup overdue';
    if (trip.pickupForecast?.status==='available'&&trip.pickupForecast.expiresAt>now&&trip.pickupForecast.lateMinutes>0) {
      return 'Road ETA · '+trip.pickupForecast.lateMinutes+' min late';
    }
    if (!trip.driverId && trip.pickupAt < now) return 'Pickup time passed';
    if (!trip.driverId && trip.dispatchError && trip.pickupAt <= now + leadMinutes * 60000 && trip.status !== 'offered') {
      return trip.dispatchError;
    }
    return '';
  }
  function group(trip, now = Date.now(), leadMinutes = 15) {
    if (trip.status === 'completed') return 'completed';
    if (trip.status === 'cancelled') return 'cancelled';
    if (attentionReason(trip,now,leadMinutes)) return 'attention';
    if (trip.driverId) return 'assigned';
    if (trip.status === 'offered') return 'offered';
    return 'waiting';
  }
  function priority(t,now=Date.now()){
    if(['completed','cancelled'].includes(t.status)||t.poolParentId)return 'later';
    if(t.driverId&&['accepted','heading_to_pickup','arrived','onboard'].includes(t.status))return 'current';
    if(t.pickupAt<now)return 'overdue';
    return t.pickupAt<=now+3600000?'hour':'later';
  }
  function compare(a,b,now=Date.now()){
    const rank={current:0,overdue:1,hour:2,later:3};
    return (['completed','cancelled'].includes(a.status)?4:rank[priority(a,now)])-(['completed','cancelled'].includes(b.status)?4:rank[priority(b,now)])||a.pickupAt-b.pickupAt||a.reference.localeCompare(b.reference);
  }
  function dispatchBucket(trip, now = Date.now(), leadMinutes = 15) {
    const kind = priority(trip, now);
    if (kind === 'overdue' || attentionReason(trip,now,leadMinutes)) return 'attention';
    return kind === 'later' ? 'later' : 'now';
  }
  function dispatchQueue(trips, runId, now = Date.now(), leadMinutes = 15) {
    const lists = { now: [], later: [], attention: [] };
    if (runId === undefined) return lists;
    for (const trip of trips) {
      if (trip.poolParentId || ['completed', 'cancelled'].includes(trip.status) || (trip.demoRunId || null) !== runId) continue;
      lists[dispatchBucket(trip, now, leadMinutes)].push(trip);
    }
    for (const list of Object.values(lists)) list.sort((a, b) => compare(a, b, now));
    return lists;
  }
  function compareBookings(a, b, order, now) {
    if (order === 'priority') return compare(a, b, now);
    const referenceOrder = () => a.reference.localeCompare(b.reference);
    if (order !== 'next') return b.pickupAt - a.pickupAt || referenceOrder();
    const rank = trip => {
      if (['completed', 'cancelled'].includes(trip.status)) return 2;
      return trip.pickupAt >= now ? 0 : 1;
    };
    const aRank = rank(a), bRank = rank(b);
    const timeOrder = aRank === 0 ? a.pickupAt - b.pickupAt : b.pickupAt - a.pickupAt;
    return aRank - bRank || timeOrder || referenceOrder();
  }
  function searchTrips(trips, search, drivers = []) {
    const needle = search.trim().toLowerCase();
    if (!needle) return trips;
    const names = new Map(drivers.map(d => [d.id,d.name]));
    return trips.filter(t => [t.reference,t.customerName,t.customerPhone,t.pickup,t.destination,names.get(t.driverId)].join(' ').toLowerCase().includes(needle));
  }
  function select(trips, { filter = 'all', search = '', page = 1, pageSize = 25, drivers = [], scope = 'all', order = 'priority', now = Date.now(), leadMinutes = 15 } = {}) {
    const list = trips.filter(t => scope==='all'||(scope==='live'?!t.demoRunId:t.demoRunId===scope));
    const counts = { all: list.length, waiting: 0, offered: 0, assigned: 0, attention: 0, completed: 0, cancelled: 0 };
    for (const t of list) counts[group(t, now,leadMinutes)]++;
    const found = searchTrips(list,search,drivers).filter(t => (order !== 'past' || t.pickupAt < now) && (filter === 'all' || group(t, now,leadMinutes) === filter))
      .sort((a,b)=>compareBookings(a,b,order,now));
    const pages = Math.max(1, Math.ceil(found.length / pageSize)), current = Math.min(pages, Math.max(1, page));
    return { counts, total: found.length, pages, page: current, start: found.length ? (current - 1) * pageSize + 1 : 0,
      end: Math.min(current * pageSize, found.length), rows: found.slice((current - 1) * pageSize, current * pageSize) };
  }
  function fleet(state, now = Date.now()) {
    return state.drivers.map(driver => {
      const trip = state.trips.find(t => t.driverId === driver.id && !['completed','cancelled'].includes(t.status));
      const offer = state.offers.find(o => o.driverId === driver.id && o.status === 'pending' && o.expiresAt > now);
      const age = Math.max(0, now - driver.lastLocationAt);
      const hasLocation = Number.isFinite(driver.lat) && Number.isFinite(driver.lng) && Number.isFinite(driver.lastLocationAt);
      const status = driver.status === 'offline' ? 'offline' : !hasLocation || age > 120000 || driver.locationSource==='device'&&driver.trackingEnabled===false ? 'stale' : trip ? 'onride' : offer ? 'offered' : 'available';
      return { driver, trip, offer, status, age, hasLocation };
    });
  }
  function schedule(trips,{now=Date.now(),period='today',search='',page=1,pageSize=25}={}){
    const start=new Date(now);start.setHours(0,0,0,0);
    const tomorrow=new Date(start);tomorrow.setDate(tomorrow.getDate()+1);
    const afterTomorrow=new Date(tomorrow);afterTomorrow.setDate(afterTomorrow.getDate()+1);
    const week=new Date(start);week.setDate(week.getDate()+7);
    const needle=search.trim().toLowerCase();
    const rows=trips.filter(t=>!['completed','cancelled'].includes(t.status)&&!t.poolParentId&&(period==='priority'?priority(t,now)!=='later':t.pickupAt>=now)&&
      (period==='today'?t.pickupAt<tomorrow.getTime():period==='tomorrow'?t.pickupAt>=tomorrow.getTime()&&t.pickupAt<afterTomorrow.getTime():period==='week'?t.pickupAt<week.getTime():true)&&
      (!needle||[t.reference,t.customerName,t.pickup,t.destination].join(' ').toLowerCase().includes(needle)))
      .sort((a,b)=>period==='priority'?compare(a,b,now):a.pickupAt-b.pickupAt||a.reference.localeCompare(b.reference));
    const pages=Math.max(1,Math.ceil(rows.length/pageSize)),current=Math.max(1,Math.min(page,pages));
    return {total:rows.length,pages,page:current,rows:rows.slice((current-1)*pageSize,current*pageSize),start:rows.length?(current-1)*pageSize+1:0,end:Math.min(current*pageSize,rows.length)};
  }
  function mapPriorities(state,places,drivers,now=Date.now(),filter='all',queueRows){
    const runs=new Set(drivers.map(d=>d.demoRunId||null));
    const rides=queueRows ?? state.trips.filter(t=>!t.poolParentId&&!['completed','cancelled'].includes(t.status)&&runs.has(t.demoRunId||null)&&(priority(t,now)!=='later'||['later','attention'].includes(filter)));
    const groups=new Map(),missing=[];const counts={current:0,hour:0,overdue:0};
    for(const t of rides){
      const kind = queueRows && filter === 'attention' ? 'overdue' : priority(t,now);
      counts[kind]=(counts[kind]||0)+1;
      if(!queueRows && (filter==='now'?!['current','hour'].includes(kind):filter==='attention'?!(kind==='overdue'||t.redFlag||t.dispatchExhausted):filter!=='all'&&filter!==kind))continue;
      const name=t.status==='onboard'?t.destination:t.pickup,p=places.find(p=>p.name===name);
      if(!p||!Number.isFinite(p.lat)||!Number.isFinite(p.lng)){missing.push(t.id);continue;}
      const key=p.lat+','+p.lng+':'+kind;let g=groups.get(key);if(!g){g={lat:p.lat,lng:p.lng,name,rides:[]};groups.set(key,g);}g.rides.push({id:t.id,kind,target:t.status==='onboard'?'Drop-off':'Pickup'});
    }
    for(const g of groups.values()){g.kind=g.rides.some(t=>t.kind==='overdue')?'overdue':g.rides.some(t=>t.kind==='current')?'current':g.rides[0].kind;}
    const pins=[...groups.values()];for(const g of pins){const colocated=pins.filter(p=>p.lat===g.lat&&p.lng===g.lng),index=colocated.indexOf(g);g.offset=colocated.length===1?'center':colocated.length===2?(index===0?'left':'right'):['left','center','right'][index];}
    return {groups:pins,counts,missing,total:rides.length};
  }
  function dispatchLabel(state,t,now=Date.now()){
    if(t.driverId)return {label:'Driver confirmed',detail:''};
    const pending=state.offers.filter(o=>o.tripId===t.id&&o.status==='pending'&&o.expiresAt>now);
    if(pending.length){const d=state.drivers.find(d=>d.id===pending[0].driverId);return {label:pending.length>1?'Waiting for '+pending.length+' drivers':'Waiting: '+(d?.name||'driver'),detail:'Confirmation requires driver acceptance'};}
    if(t.poolParentId)return {label:'In shared run',detail:'Dispatch is managed on the shared car run'};
    if(!t.autoDispatch)return {label:'Not queued',detail:'Plan or enable dispatch for this ride'};
    const opens=t.pickupAt-(state.settings?.dispatchLeadMinutes||15)*60000;
    if(opens>now)return {label:'Scheduled',detail:'Offers open '+new Date(opens).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})};
    if(t.pickupAt+300000<now)return {label:'Pickup missed · review',detail:'Use Assign to send a recovery offer'};
    const suitable=state.drivers.filter(d=>(d.demoRunId||null)===(t.demoRunId||null)&&d.locationSource!=='replay'&&(d.locationSource!=='device'||t.lgtc?.test)&&['online','busy'].includes(d.status)&&now-d.lastLocationAt<=120000&&d.seats>=t.passengers&&(t.requirements||[]).every(r=>(d.capabilities||[]).includes(r))&&!(t.excluded||[]).includes(d.id));
    if(suitable.length&&suitable.every(d=>d.status==='busy'||state.offers.some(o=>o.driverId===d.id&&o.status==='pending'&&o.expiresAt>now)))return {label:'Waiting for a free car',detail:'Dispatch retries when a driver becomes available'};
    if(t.dispatchError||t.dispatchExhausted)return {label:'No eligible driver',detail:t.dispatchError||'Owner review required'};
    return {label:'Searching automatically',detail:'Nearest eligible driver gets the next offer'};
  }
  const api = { attentionReason, group, select, searchTrips, fleet, schedule, priority, compare, dispatchBucket, dispatchQueue, mapPriorities, dispatchLabel };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ProLiftBoard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
