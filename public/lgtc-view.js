let lgtcHistory = null, lgtcDate = '', lgtcFilter = 'all', lgtcPage = 1, lgtcDraft = null, lgtcUpload = null, lgtcBusy = false;
let lgtcSearch = '', lgtcOrder = 'earliest';
let lgtcSettingsData = null;
let lgtcApprovalSource = null;
const lgtcTime = v => v ? String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0') : '—';
const lgtcInputTime = v => v === 0 ? '00:00' : v ? lgtcTime(v) : '';
const lgtcDay = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric', timeZone:'UTC' });
const lgtcFleet = [['standard4','4-seat cars'],['standard7','7-seat cars'],['accessible4','Accessible 4-seat vehicles'],['accessible7','Accessible 7-seat vehicles']];

function lgtcSelect(value) {
  lgtcDate = value; lgtcPage = 1; lgtcFilter = 'all'; lgtcDraft = null; lgtcSearch = ''; lgtcOrder = 'earliest';
}
function lgtcHistoryView() {
  if (!lgtcHistory) return '<p class="muted">Loading saved schedules…</p>';
  return lgtcHistory.length ? lgtcHistory.map(s => '<div class="activity-row"><div><strong>' + s.summaries.map(d => esc(lgtcDay(d.serviceDate))).join(' · ') + '</strong><small>' + s.summaries.reduce((n,d)=>n+d.count,0) + ' trip legs · Saved ' + esc(date(s.savedAt)) + ' at ' + esc(time(s.savedAt)) + '</small></div><button class="btn small" data-lgtc-open="' + esc(s.id) + '">Open schedule</button></div>').join('') : '<p class="muted">No LGTC schedules saved yet.</p>';
}
function lgtcHandoff() {
  const schedule = lgtcHistory?.[0];
  if (!schedule) return '';
  const latest = schedule.summaries.at(-1);
  const legs = schedule.summaries.reduce((total, day) => total + day.count, 0);
  return '<aside class="planning-handoff"><div><strong>LGTC planning</strong><p>' + legs + ' legs · ' +
    esc(lgtcDay(latest.serviceDate)) + ' · Planning only</p></div><button class="btn small" data-lgtc-open="' +
    esc(schedule.id) + '">Review schedule</button></aside>';
}
function lgtcRows(rows, withPlan = false) {
  const dispatched = new Map((state?.trips || []).filter(t=>t.lgtc).map(t=>[t.reference,t]));
  return '<div class="table-scroll"><table><thead><tr><th>Source record</th><th>Pickup → End (ET)</th><th>Stops</th><th>' + (withPlan ? 'Result' : 'Review') + '</th></tr></thead><tbody>' + rows.map(r =>
    '<tr><td><strong>' + esc(r.reference) + '</strong><small>Row ' + r.row + ' · Code ' + esc(r.code) + '</small></td><td>' +
    (r.review?.start != null ? lgtcInputTime(r.start) : lgtcTime(r.start)) + ' → ' + lgtcTime(r.end) +
    (r.review?.start != null ? '<small>Time confirmed</small>' : '') + '</td><td>' + esc(r.from || 'Unknown') + ' → ' + esc(r.to || 'Unknown') + '</td><td>' +
    esc(r.reasons?.join(' · ') || (r.seats ? r.seats + ' seats' : [...r.issues, ...(r.hasNotes && !r.review?.notesReviewed ? ['Source notes to review'] : [])].join(' · ') || 'Time present')) +
    (r.assignment ? '<small><strong>' + esc(r.assignment) + '</strong></small>' : '') +
    (r.alternateReason ? '<small>' + esc(r.alternateReason) + '</small>' : '') +
    (r.regularDriver ? '<small>Regular driver · ' + esc(r.regularDriver.name) + '</small>' : '') +
    lgtcLiveBadge(dispatched.get('LGTC-' + r.program + '-' + r.serviceDate + '-' + r.reference)) +
    (batch.savedAt && (!withPlan || r.reasons) ? '<small><button class="text-btn" data-lgtc-review="' + r.row + '" aria-label="Review trip ' + esc(r.reference) + '">' + (r.review ? 'Edit review' : 'Review trip') + '</button></small>' : '') + '</td></tr>'
  ).join('') + '</tbody></table></div>';
}
function lgtcLiveBadge(trip) {
  if (!trip) return '';
  return '<small data-lgtc-live="' + esc(trip.id) + '">' + lgtcLiveLabel(trip) + '</small>' +
    '<button class="text-btn" data-lgtc-track="' + esc(trip.id) + '">Track ride</button>';
}
function lgtcLiveLabel(trip) {
  const driver = state.drivers.find(d=>d.id===trip.driverId);
  return esc((labels[trip.status] || trip.status) + (driver ? ' · ' + driver.name : ''));
}
function lgtcPlanDispatch(trip, plannedId) {
  if (!trip) return {title:'Awaiting approval',tone:'planned'};
  const driver = state.drivers.find(d=>d.id===trip.driverId);
  const pending = state.offers.filter(o=>o.tripId===trip.id&&o.status==='pending'&&o.expiresAt>Date.now());
  const alternate = plannedId&&driver&&driver.id!==plannedId;
  const status = {accepted:'Confirmed',heading_to_pickup:'En route to pickup',arrived:'At pickup',onboard:'Onboard',completed:'Completed',cancelled:'Cancelled'}[trip.status];
  const issue = ProLiftBoard.attentionReason(trip,Date.now(),dispatchLead());
  if (status) return {title:status,name:driver?.name||trip.confirmedDriver?.name,
    tone:trip.status==='cancelled'?'planned':issue?'warning':alternate?'pending':'confirmed',note:issue||(alternate?'Different from day plan':'')};
  if (pending.length) return {title:pending.length===1?'Offer pending':pending.length+' offers pending',
    name:pending.map(o=>state.drivers.find(d=>d.id===o.driverId)?.name).filter(Boolean).join(', '),tone:'pending',
    note:plannedId&&pending.every(o=>o.driverId!==plannedId)?'Different from day plan':''};
  if (issue) return {title:'Needs attention',tone:'warning',note:issue};
  return {title:'Queued for dispatch',tone:'planned'};
}
function lgtcPlanDispatchView(trip, plannedId) {
  const result=lgtcPlanDispatch(trip,plannedId);
  return '<span class="lgtc-dispatch-status lgtc-status-'+result.tone+'">'+esc(result.title)+'</span>'+
    (result.name?'<strong>'+esc(result.name)+'</strong>':'')+(result.note?'<small>'+esc(result.note)+'</small>':'');
}
function lgtcPlanRideCards(run, dispatched) {
  return '<div class="lgtc-plan-rides" role="list">'+run.trips.map(leg=>{
    const ref='LGTC-'+leg.program+'-'+leg.serviceDate+'-'+leg.reference;
    const trip=dispatched.get(ref);
    const ampm=leg.start<720?'AM':'PM';
    const clock=(Math.floor(leg.start/60)%12||12)+':'+String(leg.start%60).padStart(2,'0')+' '+ampm;
    return '<article class="lgtc-plan-ride" role="listitem"><div class="lgtc-plan-when"><strong>'+clock+'</strong><small>'+esc(leg.reference)+'</small></div>'+
      '<div class="lgtc-plan-route"><strong>'+esc(trip?trip.pickup:leg.from||'Pickup')+' → '+esc(trip?trip.destination:leg.to||'Drop-off')+'</strong>'+
      '<small>'+leg.seats+(leg.seats===1?' rider':' riders')+'</small></div>'+
      '<div class="lgtc-plan-person"><small>Regular driver</small><strong>'+esc(leg.regularDriver?.name||'None set')+'</strong></div>'+
      '<div class="lgtc-plan-person"><small>Day plan</small><strong>'+esc(run.label)+'</strong>'+
      (leg.alternateReason?'<small>'+esc(leg.alternateReason)+'</small>':'')+'</div>'+
      '<div class="lgtc-plan-outcome"><small>Live dispatch</small><div class="lgtc-plan-live" data-lgtc-plan-ref="'+esc(ref)+'" data-planned-id="'+esc(run.driverId||'')+'">'+
      lgtcPlanDispatchView(trip,run.driverId)+'</div><button class="text-btn" data-lgtc-plan-track="'+esc(trip?.id||'')+'" '+(trip?'':'hidden')+'>Open ride</button></div></article>';
  }).join('')+'</div>';
}
function updateLgtcLiveStatus() {
  const byId = new Map(state.trips.map(t=>[t.id,t]));
  document.querySelectorAll('[data-lgtc-live]').forEach(el => {
    const trip = byId.get(el.dataset.lgtcLive);
    if (trip) el.innerHTML = lgtcLiveLabel(trip);
  });
  const planned=document.querySelectorAll('[data-lgtc-plan-ref]');
  if(!planned.length) return;
  const byReference=new Map(state.trips.filter(t=>t.lgtc).map(t=>[t.reference,t]));
  planned.forEach(el=>{
    const trip=byReference.get(el.dataset.lgtcPlanRef);
    const view=lgtcPlanDispatchView(trip,el.dataset.plannedId);
    if(el.innerHTML!==view) el.innerHTML=view;
    const button=el.nextElementSibling;
    button.dataset.lgtcPlanTrack=trip?.id||'';
    button.hidden=!trip;
    if(trip){
      const route=el.closest('.lgtc-plan-ride').querySelector('.lgtc-plan-route strong');
      const text=trip.pickup+' → '+trip.destination;
      if(route.textContent!==text) route.textContent=text;
    }
  });
}
function trackLgtcRide(id) {
  const trip = state.trips.find(t=>t.id===id);
  if (!trip) return;
  if (canShowInDispatch(trip)) focusDispatchRide(id);
  else tripDetail(id);
}
function lgtcPreview() {
  const info = batch.summaries.find(s => s.serviceDate === lgtcDate) || batch.summaries[0];
  const rows = batch.rows.filter(r => r.serviceDate === info.serviceDate);
  const pickup = row => row.review?.start ?? (row.start || null);
  rows.sort((a, b) => {
    const startA = pickup(a), startB = pickup(b);
    if (startA === null || startB === null) return Number(startA === null) - Number(startB === null) || a.row - b.row;
    return (lgtcOrder === 'latest' ? startB - startA : startA - startB) || a.row - b.row;
  });
  const filtered = lgtcFilter === 'review' ? rows.filter(r => r.issues.length || r.hasNotes && !r.review?.notesReviewed) :
    lgtcFilter === 'time' ? rows.filter(r => r.issues.some(issue => /scheduled time|must follow pickup/.test(issue))) : rows;
  const query = lgtcSearch.toLowerCase();
  const visible = filtered.filter(r => !query || String(r.row) === query || [r.reference,r.from,r.to].some(s => s?.toLowerCase().includes(query)));
  const pages = Math.max(1, Math.ceil(visible.length / 25));
  lgtcPage = Math.min(lgtcPage, pages);
  const dayDraft = batch.drafts?.[info.serviceDate];
  const hours = info.hours.map((n,h)=>n ? '<li><strong>' + lgtcTime(h * 60 || 1440).replace('24:00','00:00') + '</strong> · ' + n + '</li>' : '').join('');
  return '<section class="panel lgtc-panel" id="lgtc-review"><div class="panel-heading"><div><h2>LGTC schedule · ' + esc(lgtcDay(info.serviceDate)) + '</h2><p>Eastern time · ' +
    (config.mode==='pilot'?'Verified rides enter Dispatch after owner approval':'Eligible test rides enter Dispatch after owner approval') + '</p></div>' +
    (batch.savedAt ? '<div class="lgtc-heading-actions">' + badge('Saved schedule') +
      '<button class="btn small" id="lgtc-day-jump">' + (dayDraft?.stale ? 'Rebuild day plan' : dayDraft ? 'View saved day plan' : 'Plan this day') + '</button></div>' :
      '<button class="btn primary" id="lgtc-save">Save schedule</button>') + '</div>' +
    (batch.dates.length > 1 ? '<label>Service date<select id="lgtc-date">' + batch.dates.map(d=>'<option value="' + esc(d) + '" ' + (d === info.serviceDate ? 'selected' : '') + '>' + esc(lgtcDay(d)) + '</option>').join('') + '</select></label>' : '') +
    '<div class="lgtc-metrics">' + [[info.count,'Trip legs'],[info.scheduled,'With scheduled times'],[info.missingTime,'Need a valid time'],[info.peak,'Peak overlap' + (info.peak ? ' at ' + lgtcTime(info.peakAt) + ' ET' : '')]].map(([n,label])=>'<div><strong>' + n + '</strong><span>' + label + '</span></div>').join('') + '</div>' +
    '<p class="help">Peak overlap excludes travel between trips. ' + info.withNotes + ' legs have source notes. Use the row number or reference to check the original file.</p>' +
    (batch.linked ? '<p class="help">' + rows.filter(r=>r.regularDriver).length + ' legs match a saved regular driver. Open <strong>Review trip</strong> to set a preference for a rider.</p>' :
      '<p class="notice">Upload and save the original file again to add regular-driver matching to this saved schedule.</p>') +
    '<details><summary>Pickup demand by hour</summary><ul class="lgtc-hours">' + hours + '</ul></details>' +
    '<div class="lgtc-row-tools"><label>Pickup order<select id="lgtc-order" aria-label="Pickup order"><option value="earliest">Earliest pickup first</option><option value="latest" ' + (lgtcOrder === 'latest' ? 'selected' : '') + '>Latest pickup first</option></select></label>' +
    '<label>Show trip legs<select id="lgtc-filter"><option value="all">All trip legs</option><option value="time" ' + (lgtcFilter==='time'?'selected':'') + '>Missing or invalid time</option><option value="review" ' + (lgtcFilter==='review'?'selected':'') + '>Source flags or notes</option></select></label>' +
    '<form id="lgtc-search-form"><label>Find a trip<input type="search" name="query" value="' + esc(lgtcSearch) + '" placeholder="Reference, row or city" maxlength="100"></label><button class="btn small" type="submit">Search</button></form></div>' +
    (visible.length ? lgtcRows(visible.slice((lgtcPage - 1) * 25, lgtcPage * 25)) : '<p class="muted">No trip legs match this filter.</p>') +
    '<div class="pagination"><span>' + visible.length + ' matching legs</span><button class="btn small" data-lgtc-page="' + (lgtcPage - 1) + '" ' + (lgtcPage <= 1 ? 'disabled' : '') + '>Previous</button><small>' + lgtcPage + ' / ' + pages + '</small><button class="btn small" data-lgtc-page="' + (lgtcPage + 1) + '" ' + (lgtcPage >= pages ? 'disabled' : '') + '>Next</button></div></section>' +
    (batch.savedAt ? lgtcPlanner(info) : '');
}
function lgtcPlanner(info) {
  const codes = Object.entries(info.codes);
  const saved = batch.drafts?.[info.serviceDate];
  const settings = saved?.settings;
  const named = !settings || !!settings.driverIds;
  const status = saved?.stale ? '<p class="notice">Trips, preferences or fleet details changed. Rebuild the saved draft.</p>' :
    saved ? '<p class="help">' + (saved.automatic ? 'Draft built automatically' : 'Draft saved') +
      ' on ' + esc(date(saved.savedAt)) + ' at ' + esc(time(saved.savedAt)) + '.</p>' : '';
  const automation = batch.automation;
  const automationStatus = automation?.enabled ?
    automation.driverCount + ' default drivers · Verified codes ' + (automation.codes.join(', ') || 'none') : 'Automatic planning is off';
  const roster = batch.roster || [];
  const choices = roster.map(d=>'<label class="lgtc-check"><input type="checkbox" name="driverIds" value="' + esc(d.id) + '" ' +
    (settings?.driverIds?.includes(d.id) ? 'checked' : '') + '><span><strong>' + esc(d.name) + '</strong><small>' +
    esc(d.vehicle) + ' · ' + d.seats + ' seats' + (d.accessible ? ' · Accessible' : '') + '</small></span></label>').join('');
  return '<section class="panel lgtc-panel" id="lgtc-planner"><h2>Full-day driver plan</h2><p class="muted">Choose who can work this date. ProLift fits regular drivers first, then uses suitable alternates for the remaining rides. Travel between trips uses your time buffer.</p>' +
    '<div class="lgtc-defaults-status"><div><strong>Upload defaults</strong><p>' + esc(automationStatus) +
    '</p></div><button class="btn small" data-go="lgtc-settings">Manage LGTC settings</button></div>' +
    status + '<form id="lgtc-plan-form"><label>Planning mode<select name="planMode"><option value="named" ' + (named ? 'selected' : '') +
    '>Named drivers</option><option value="estimate" ' + (!named ? 'selected' : '') + '>Estimate with vehicle counts</option></select></label>' +
    '<fieldset id="lgtc-named-roster" ' + (!named ? 'hidden' : '') + '><legend>Drivers available for this day</legend><div class="lgtc-roster">' +
    (choices || '<p>Add an ordinary fleet driver in Manage first.</p>') + '</div></fieldset>' +
    '<fieldset id="lgtc-estimate-fleet" ' + (named ? 'hidden' : '') + '><legend>Estimated vehicles</legend><div class="lgtc-inputs">' + lgtcFleet.map(([key,label])=>'<label>' + label + '<input type="number" name="' + key + '" min="0" max="500" value="' + (settings?.fleet[key] ?? 0) + '"></label>').join('') + '</div></fieldset>' +
    '<div class="lgtc-inputs">' +
    '<label>Between trips (minutes)<input type="number" name="buffer" min="0" max="180" value="' + (settings?.buffer ?? 30) + '" required></label></div>' +
    '<details><summary>Verify service codes and seats</summary><p class="help">Confirm the codes against the LGTC guide, or verify individual trips in the list above. Only select a field that counts extra occupied seats.</p>' +
    codes.map(([c,n]) => {
      const profile = settings?.profiles[c];
      return '<fieldset><legend>Code ' + esc(c) + ' · ' + n + ' legs</legend><div class="lgtc-inputs"><label>Service type<select name="mode-' + esc(c) + '">' +
        lgtcModeOptions(profile?.mode, 'Needs verification') + '</select></label><label>Base occupied seats<input type="number" name="base-' + esc(c) + '" min="1" max="7" value="' + (profile?.base ?? '') + '" placeholder="Confirm count"></label></div><div class="lgtc-checks">' +
        [30,31,32].map((n,i)=>'<label><input type="checkbox" name="extras-' + esc(c) + '" value="' + i + '" ' + (profile?.extras.includes(i) ? 'checked' : '') + '> Field ' + n + ' counts extra seats</label>').join('') + '</div></fieldset>';
    }).join('') + '<label class="lgtc-check"><input type="checkbox" name="notesReviewed" ' + (settings?.notesReviewed ? 'checked' : '') +
    '> I reviewed all original notes for this date and confirmed the draft can include those legs</label></details>' +
    '<button class="btn primary" type="submit">Build and save draft</button></form>' +
    '<div id="lgtc-plan-results" aria-live="polite">' + lgtcResults() + '</div></section>';
}
function lgtcModeOptions(value, defaultLabel) {
  return [['',defaultLabel],['standard','Standard'],['accessible','Wheelchair-accessible']].map(([mode,label]) =>
    '<option value="' + mode + '" ' + (value === mode ? 'selected' : '') + '>' + label + '</option>').join('');
}
function lgtcSettingsPage() {
  if (!lgtcSettingsData) return '<section class="panel"><h1>LGTC dispatch settings</h1><p role="status">Loading settings…</p></section>';
  const { settings, roster } = lgtcSettingsData;
  const codes = [...new Set(['A','W',...Object.keys(settings.profiles),
    ...(batch?.kind === 'lgtc' ? batch.summaries.flatMap(day=>Object.keys(day.codes)) : [])])].sort();
  return '<section class="simple-page-head"><div><h1>LGTC dispatch settings</h1><p>Set regular drivers and the defaults for future LGTC imports.</p></div></section>' +
    '<section class="panel lgtc-panel"><h2>Regular driver for a rider</h2><p class="help">Use the rider’s name and mobile as they appear in the export. This preference applies to later LGTC uploads.</p>' +
    '<form id="lgtc-customer-settings"><div class="lgtc-inputs"><label>Rider name<input name="name" maxlength="150" required autocomplete="off"></label>' +
    '<label>Rider mobile<input type="tel" name="phone" maxlength="40" required autocomplete="off"></label>' +
    '<label>Regular driver<select name="driverId"><option value="">Use standard booking preference if available</option>' +
    roster.map(d=>'<option value="' + esc(d.id) + '">' + esc(d.name) + '</option>').join('') + '</select></label></div>' +
    '<div class="lgtc-edit-actions"><button class="btn" name="action" value="lookup">Find saved preference</button>' +
    '<button class="btn primary" name="action" value="save">Save regular driver</button></div><p id="lgtc-customer-message" role="status"></p></form></section>' +
    '<section class="panel lgtc-panel"><h2>Automatic day plans</h2><p class="help">After you save an upload, ProLift drafts each service date using this roster. Confirm driver availability for the day. Trips with missing times, unverified requirements, or source notes stay in review.</p>' +
    '<form id="lgtc-automation-form"><label class="lgtc-check"><input type="checkbox" name="enabled" ' + (settings.enabled ? 'checked' : '') +
    '> Build a draft automatically after upload</label><fieldset><legend>Default available drivers</legend><div class="lgtc-roster">' +
    roster.map(d=>'<label class="lgtc-check"><input type="checkbox" name="driverIds" value="' + esc(d.id) + '" ' +
      (settings.driverIds.includes(d.id) ? 'checked' : '') + '><span>' + esc(d.name) + '<small>' + esc(d.vehicle) + ' · ' +
      d.seats + ' seats' + (d.accessible ? ' · Accessible' : '') + '</small></span></label>').join('') +
    '</div></fieldset><label>Between trips (minutes)<input type="number" name="buffer" min="0" max="180" value="' + settings.buffer + '" required></label>' +
    '<fieldset><legend>Verified LGTC service codes</legend><p class="help">Only enter rules you’ve verified against the source guide. Select extra-seat fields only when their values count occupied seats.</p>' +
    codes.map(code => {
      const profile = settings.profiles[code];
      return '<fieldset><legend>Code ' + esc(code) + '</legend><div class="lgtc-inputs"><label>Service type<select name="mode-' + esc(code) + '">' +
        lgtcModeOptions(profile?.mode,'Needs verification') + '</select></label><label>Base occupied seats<input type="number" name="base-' + esc(code) +
        '" min="1" max="7" value="' + (profile?.base ?? '') + '"></label></div><div class="lgtc-checks">' +
        [30,31,32].map((field,i)=>'<label><input type="checkbox" name="extras-' + esc(code) + '" value="' + i + '" ' +
          (profile?.extras.includes(i) ? 'checked' : '') + '> Field ' + field + ' counts extra seats</label>').join('') + '</div></fieldset>';
    }).join('') + '</fieldset><button class="btn primary" type="submit">Save planning defaults</button></form></section>';
}
async function loadLgtcSettings() {
  lgtcSettingsData = await api('/api/lgtc/settings');
  if (tab === 'lgtc-settings') render();
}
function lgtcProfiles(fields) {
  return Object.fromEntries([...fields.keys()].filter(key=>key.startsWith('mode-')).map(key=>{
    const code = key.slice(5);
    return [code, { mode:fields.get(key), base:Number(fields.get('base-' + code)), extras:fields.getAll('extras-' + code).map(Number) }];
  }));
}
function bindLgtcSettings() {
  const customer = $('#lgtc-customer-settings'), automation = $('#lgtc-automation-form');
  if (customer) customer.onsubmit = event => {
    event.preventDefault();
    const fields = new FormData(customer), action = event.submitter?.value || 'lookup';
    run(async () => {
      const result = await api('/api/lgtc/customer', { action, name:fields.get('name'), phone:fields.get('phone'), driverId:fields.get('driverId') || null });
      if (!customer.isConnected) return;
      customer.elements.driverId.value = result.regularDriver?.id || '';
      $('#lgtc-customer-message').textContent = result.regularDriver ? 'Regular driver · ' + result.regularDriver.name : 'No regular driver found for this rider.';
      if (action === 'save') toast('LGTC rider preference saved.');
    });
  };
  if (automation) automation.onsubmit = event => {
    event.preventDefault();
    const fields = new FormData(automation);
    run(async () => {
      lgtcSettingsData = await api('/api/lgtc/settings', { enabled:fields.has('enabled'), driverIds:fields.getAll('driverIds'),
        buffer:Number(fields.get('buffer')), profiles:lgtcProfiles(fields) });
      if (tab === 'lgtc-settings') render();
      toast('LGTC planning defaults saved.');
    });
  };
}
function lgtcResults() {
  if (!lgtcDraft) return '';
  const d = lgtcDraft;
  const reasons = new Map();
  for (const leg of d.unplanned) for (const reason of leg.reasons) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  const breakdown = [...reasons].sort((a,b)=>b[1]-a[1]).map(([reason,count]) => '<li><strong>' + count + '</strong> · ' + esc(reason) + '</li>').join('');
  const count = (run, assignment) => run.trips.filter(t=>t.assignment === assignment).length;
  const regular = d.runs.reduce((n,r)=>n+count(r,'Regular driver'),0);
  const named = !!d.settings.driverIds;
  const metrics = [[d.allocated,'Planned rides'],[d.unplanned.length,'Need review']];
  if (named) metrics.push([regular,'Planned with regular driver']);
  const dispatched=new Map(state.trips.filter(t=>t.lgtc).map(t=>[t.reference,t]));
  const first=d.runs.findIndex(run=>run.trips.length);
  return '<section class="lgtc-workspace"><header class="lgtc-workspace-head"><div><span class="eyebrow">OWNER SCHEDULE</span><h3>'+esc(lgtcDay(d.serviceDate))+
    '</h3><p>Day plan and actual dispatch · Eastern time · '+d.buffer+' min between rides</p></div>'+
    (named && d.allocated ? '<button class="btn primary" id="lgtc-dispatch-review">Review for dispatch</button>' : '') + '</header>'+
    '<div class="lgtc-metrics">' + metrics.map(([n,label])=>'<div><strong>' + n + '</strong><span>' + label + '</span></div>').join('') + '</div>' +
    (d.unplanned.length ? '<details open class="lgtc-unassigned"><summary>Review ' + d.unplanned.length + ' unassigned ' +
      (d.unplanned.length === 1 ? 'leg' : 'legs') + '</summary><ul class="lgtc-hours">' + breakdown + '</ul>' + lgtcRows(d.unplanned, true) + '</details>' : '') +
    d.runs.map((run,i)=>'<details class="lgtc-driver-day" id="lgtc-run-'+i+'" '+(i===first?'open':'')+'><summary aria-label="View day for '+esc(run.label)+'"><span>'+
      '<strong>'+esc(run.label)+'</strong>'+(run.vehicle?'<small>'+esc(run.vehicle)+'</small>':'')+'</span><span class="lgtc-run-count">'+run.trips.length+' planned</span></summary>'+
      (run.trips.length?lgtcPlanRideCards(run,dispatched):'<p class="help">No rides planned for this date.</p>')+'</details>').join('')+'</section>';
}
function openLgtcDispatchApproval() {
  const id = batch.id, serviceDate = lgtcDate, revision = batch.revision ?? 0;
  const readySource = lgtcApprovalSource?.id === id ? lgtcApprovalSource : null;
  modal('<h2>Review LGTC rides for dispatch</h2><p>' + esc(lgtcDay(serviceDate)) +
    (config.mode==='pilot'?' · Rides need future pickup times, verified addresses, and rider phone numbers.':
      ' · Local dispatch test. Rides need a future pickup, verified demo stops, and a dummy rider number.') + '</p>' +
    '<form id="lgtc-dispatch-form"><label>Original LGTC CSV<input type="file" accept=".csv" ' + (readySource ? '' : 'required') +
    '></label><p class="help">' + (readySource ? 'This tab already has the uploaded CSV.' : 'Choose the exact CSV you used to save this schedule.') +
    '</p><button class="btn primary" type="submit">Check rides</button></form><p id="lgtc-dispatch-error" class="validation-error" role="alert"></p>' +
    '<div id="lgtc-dispatch-result" aria-live="polite"></div>');
  const form = $('#lgtc-dispatch-form'), error = $('#lgtc-dispatch-error'), output = $('#lgtc-dispatch-result');
  const input = form.querySelector('input'), check = form.querySelector('button');
  const clock = new Intl.DateTimeFormat('en-US', {timeZone:'America/New_York',hour:'numeric',minute:'2-digit'});
  const heldList = held => held.length ? '<details class="lgtc-release-held"><summary>' + held.length +
    ' held for review</summary><ul>' + held.map(row=>'<li><strong>' + esc(row.reference) + '</strong> · ' +
      esc(row.reasons.join(' · ')) + '</li>').join('') + '</ul></details>' : '';
  const trackButtons = rows => rows.map(row=>'<button class="btn small" data-lgtc-release-track="' + esc(row.tripId) +
    '">Track ' + esc(row.reference) + '</button>').join('');
  const bindTrack = () => output.querySelectorAll('[data-lgtc-release-track]').forEach(button => {
    button.onclick = () => trackLgtcRide(button.dataset.lgtcReleaseTrack);
  });
  form.onsubmit = async event => {
    event.preventDefault();
    check.disabled = input.disabled = true;
    error.textContent = '';
    output.innerHTML = '';
    try {
      const file = input.files[0];
      if (file?.size > 5*1024*1024) throw Error('Choose a CSV that is 5 MB or smaller.');
      const base64 = file ? await new Promise((resolve,reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(Error('Could not read the CSV.'));
        reader.readAsDataURL(file);
      }) : readySource?.base64;
      const params = { id, serviceDate, revision, filename:file?.name || readySource?.filename, base64 };
      const preview = await api('/api/lgtc/dispatch', { ...params, action:'preview' });
      if (!output.isConnected) return;
      const list = preview.ready.map(row=>'<li><strong>' + esc(row.reference) + '</strong> · ' +
        esc(clock.format(row.pickupAt) + ' ET · ' + row.pickup + ' → ' + row.destination + ' · ' + row.driver) + '</li>').join('');
      output.innerHTML = '<h3>' + preview.ready.length + ' ready for dispatch · ' + preview.existing.length + ' already sent</h3>' +
        (list ? '<ul class="lgtc-release-list">' + list + '</ul>' : '') + heldList(preview.held) + trackButtons(preview.existing) +
        (preview.ready.length ? '<button class="btn primary" id="lgtc-send-dispatch">Approve and send to Dispatch</button>' : '');
      bindTrack();
      const approve = $('#lgtc-send-dispatch');
      if (approve) approve.onclick = async () => {
        approve.disabled = check.disabled = input.disabled = true;
        error.textContent = '';
        try {
          const result = await api('/api/lgtc/dispatch', { ...params, action:'approve', references:preview.ready.map(row=>row.dispatchRef) });
          state = (await api('/api/state')).state;
          updateLgtcLiveStatus();
          if (!output.isConnected) return;
          output.innerHTML = '<h3>' + result.approved.length + ' sent to Dispatch</h3><p>Driver offers follow the pickup window.</p>' +
            trackButtons([...result.approved,...result.existing]) + heldList(result.held);
          bindTrack();
        } catch (err) {
          if (error.isConnected) error.textContent = err.message;
          approve.disabled = false;
        } finally { check.disabled = input.disabled = false; }
      };
    } catch (err) { if (error.isConnected) error.textContent = err.message; }
    finally { check.disabled = input.disabled = false; }
  };
}
async function loadLgtcHistory() {
  try {
    const schedules = (await api('/api/lgtc/schedules')).schedules;
    if (user?.role !== 'owner') return;
    lgtcHistory = schedules;
    if (['imports', 'overview', 'trips'].includes(tab) && !$('dialog[open]') && !document.activeElement?.matches('input, select, textarea')) render();
  }
  catch (e) { if (tab === 'imports' && $('#lgtc-history')) $('#lgtc-history').textContent = e.message; }
}
async function reopenLgtcDraft() {
  if (!batch.drafts?.[lgtcDate] || batch.drafts[lgtcDate].stale) return;
  const id = batch.id, serviceDate = lgtcDate;
  const result = await api('/api/lgtc/plan', { id, serviceDate, reopen: true });
  if (tab !== 'imports' || batch?.id !== id || lgtcDate !== serviceDate || result.revision !== batch.revision) return;
  lgtcDraft = result.plan;
  $('#lgtc-plan-results').innerHTML = lgtcResults();
  bindLgtc();
}
function openLgtcReview(row) {
  const leg = batch.rows.find(r => r.row === row);
  if (!leg) return;
  const review = leg.review;
  const id = batch.id, revision = batch.revision ?? 0;
  modal('<h2>Review trip ' + esc(leg.reference) + '</h2><p>' + esc(lgtcDay(leg.serviceDate)) + ' · Source row ' + row + ' · Code ' + esc(leg.code) +
    '</p><p>Imported times (ET) ' + lgtcTime(review ? leg.originalStart : leg.start) + ' → ' + lgtcTime(review ? leg.originalEnd : leg.end) +
    (leg.additionalTime ? ' · Additional source time ' + lgtcTime(leg.additionalTime) : '') + '</p>' +
    '<form id="lgtc-leg-form"><p class="help">Enter both confirmed times to correct the schedule or resolve a will-call leg. Use the source row to check instructions.</p>' +
    '<div class="lgtc-inputs"><label>Confirmed pickup (ET)<input type="time" name="start" value="' + lgtcInputTime(review?.start) +
    '"></label><label>Confirmed end (ET)<input type="time" name="end" value="' + lgtcInputTime(review?.end) + '"></label></div>' +
    '<div class="lgtc-inputs"><label>Vehicle requirement<select name="mode">' + lgtcModeOptions(review?.mode, 'Use service code setting') +
    '</select></label><label>Occupied seats<input type="number" min="1" max="7" name="seats" value="' + (review?.seats ?? '') + '"></label></div>' +
    (leg.hasNotes ? '<label class="lgtc-check"><input type="checkbox" name="notesReviewed" ' + (review?.notesReviewed ? 'checked' : '') +
    '> I checked this trip’s instructions in the original file</label>' : '') +
    '<div class="lgtc-edit-actions"><button class="btn primary" type="submit">Save trip review</button>' +
    (review ? '<button class="btn" type="button" id="lgtc-reset-review">Restore imported details</button>' : '') + '</div></form>' +
    (leg.canMatchCustomer ? '<form id="lgtc-preference-form"><h3>Regular driver</h3><p class="help">Applies to future LGTC rows for the same rider and mobile. Verify the rider in the original file using source row ' +
      leg.row + '.</p><label>Preferred driver<select name="driverId"><option value="">Use standard booking preference if available</option>' +
      batch.roster.map(d => '<option value="' + esc(d.id) + '" ' + (leg.regularDriver?.id === d.id ? 'selected' : '') + '>' + esc(d.name) + '</option>').join('') +
      '</select></label><button class="btn" type="submit">Save regular driver</button></form>' : ''));
  const form = $('#lgtc-leg-form');
  const submit = async reset => {
    const data = new FormData(form);
    const buttons = [...form.querySelectorAll('button')];
    buttons.forEach(b => b.disabled = true);
    try {
      const result = await api('/api/lgtc/review', { id, row, revision, reset,
        start: data.get('start'), end: data.get('end'), mode: data.get('mode'),
        seats: Number(data.get('seats')), notesReviewed: data.has('notesReviewed') });
      if (tab !== 'imports' || batch?.id !== id) return;
      batch = result.batch;
      lgtcDraft = null;
      $('#modal').close();
      render();
      toast(reset ? 'Imported trip details restored.' : 'Trip review saved.');
    } finally { buttons.forEach(b => b.disabled = false); }
  };
  form.onsubmit = e => { e.preventDefault(); run(() => submit(false)); };
  if ($('#lgtc-reset-review')) $('#lgtc-reset-review').onclick = () => run(() => submit(true));
  if ($('#lgtc-preference-form')) $('#lgtc-preference-form').onsubmit = event => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button');
    const driverId = new FormData(form).get('driverId') || null;
    run(async () => {
      button.disabled = true;
      try {
        const result = await api('/api/lgtc/preference', { id, row, revision, driverId });
        if (tab !== 'imports' || batch?.id !== id) return;
        batch = result.batch;
        lgtcDraft = null;
        $('#modal').close();
        render();
        await reopenLgtcDraft();
        toast('LGTC regular-driver preference updated.');
      } finally { button.disabled = false; }
    });
  };
}
function bindLgtc() {
  bindLgtcSettings();
  if ($('#lgtc-dispatch-review')) $('#lgtc-dispatch-review').onclick = openLgtcDispatchApproval;
  document.querySelectorAll('[data-lgtc-track]').forEach(button => {
    button.onclick = () => trackLgtcRide(button.dataset.lgtcTrack);
  });
  document.querySelectorAll('[data-lgtc-plan-track]').forEach(button => {
    button.onclick = () => trackLgtcRide(button.dataset.lgtcPlanTrack);
  });
  if ($('#lgtc-day-jump')) $('#lgtc-day-jump').onclick = () => {
    $(lgtcDraft ? '#lgtc-plan-results' : '#lgtc-planner')?.scrollIntoView({block:'start'});
  };
  document.querySelectorAll('[data-lgtc-review]').forEach(el => el.onclick = () => openLgtcReview(Number(el.dataset.lgtcReview)));
  document.querySelectorAll('[data-lgtc-open]').forEach(el => el.onclick = () => run(async () => {
    batch = (await api('/api/lgtc/schedules?id=' + encodeURIComponent(el.dataset.lgtcOpen))).batch;
    tab = 'imports';
    lgtcUpload = null; lgtcSelect(batch.dates[0]); render(); $('#lgtc-review')?.scrollIntoView({block:'start'});
    await reopenLgtcDraft();
  }));
  if ($('#lgtc-save')) $('#lgtc-save').onclick = () => run(async () => {
    if (!lgtcUpload || lgtcBusy) return;
    lgtcBusy = true; $('#lgtc-save').disabled = true;
    try {
      const result = await api('/api/lgtc/schedules', { ...lgtcUpload, id:batch.id });
      batch = result.batch;
      lgtcApprovalSource = { ...lgtcUpload, id:batch.id };
      lgtcUpload = null; await loadLgtcHistory(); await reopenLgtcDraft();
      const auto = result.autoPlanned?.find(day => day.serviceDate === lgtcDate);
      if (auto) $('#lgtc-plan-results')?.scrollIntoView({block:'start'});
      toast(result.autoError || (auto ? auto.allocated + ' allocated · ' + auto.unassigned + ' need review. Draft saved.' : 'LGTC schedule saved. Ready for planning.'), !!result.autoError);
    } finally { lgtcBusy = false; if ($('#lgtc-save')) $('#lgtc-save').disabled = false; }
  });
  if ($('#lgtc-date')) $('#lgtc-date').onchange = e => { lgtcSelect(e.target.value); render(); run(reopenLgtcDraft); };
  const updateRows = () => {
    const old = $('#lgtc-review'), pageTop = window.scrollY;
    const next = document.createElement('template'); next.innerHTML = lgtcPreview();
    old.replaceWith(next.content.firstElementChild); bindLgtc(); window.scrollTo(0,pageTop);
  };
  if ($('#lgtc-filter')) $('#lgtc-filter').onchange = e => { lgtcFilter = e.target.value; lgtcPage = 1; updateRows(); $('#lgtc-filter')?.focus({preventScroll:true}); };
  if ($('#lgtc-order')) $('#lgtc-order').onchange = e => { lgtcOrder = e.target.value; lgtcPage = 1; updateRows(); $('#lgtc-order')?.focus({preventScroll:true}); };
  if ($('#lgtc-search-form')) $('#lgtc-search-form').onsubmit = e => {
    e.preventDefault();
    lgtcSearch = new FormData(e.currentTarget).get('query').trim(); lgtcPage = 1; updateRows();
    $('#lgtc-search-form input')?.focus({preventScroll:true});
  };
  document.querySelectorAll('[data-lgtc-page]').forEach(el => el.onclick = () => { lgtcPage = Number(el.dataset.lgtcPage); updateRows(); });
  const planMode = $('#lgtc-plan-form select[name="planMode"]');
  if (planMode) planMode.onchange = () => {
    $('#lgtc-named-roster').hidden = planMode.value !== 'named';
    $('#lgtc-estimate-fleet').hidden = planMode.value === 'named';
  };
  if ($('#lgtc-plan-form')) $('#lgtc-plan-form').onsubmit = e => { e.preventDefault(); run(async () => {
    const form = e.currentTarget, fields = new FormData(form), submit = form.querySelector('button');
    const currentBatch = batch.id, currentDate = lgtcDate;
    const profiles = lgtcProfiles(fields);
    submit.disabled = true;
    try {
      const driverIds = fields.get('planMode') === 'named' ? fields.getAll('driverIds') : undefined;
      const response = await api('/api/lgtc/plan', { id:currentBatch, serviceDate:currentDate, profiles, save:true, revision:batch.revision ?? 0, driverIds,
        fleet:Object.fromEntries(lgtcFleet.map(([k])=>[k,Number(fields.get(k))])), buffer:Number(fields.get('buffer')), notesReviewed:fields.has('notesReviewed') });
      if (batch?.id === currentBatch) {
        batch.revision = response.revision;
        (batch.drafts ??= {})[currentDate] = response.draft;
        if (tab === 'imports' && lgtcDate === currentDate) {
          lgtcDraft = response.plan; render(); $('#lgtc-plan-results').scrollIntoView({block:'nearest'});
        }
      }
    } finally { submit.disabled = false; }
  }); };
}
