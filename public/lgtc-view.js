let lgtcHistory = null, lgtcDate = '', lgtcFilter = 'all', lgtcPage = 1, lgtcDraft = null, lgtcUpload = null, lgtcBusy = false;
let lgtcSearch = '', lgtcOrder = 'earliest';
let lgtcSection = 'summary';
let lgtcSelectedRun = '';
let lgtcFleetPreview = false;
const lgtcSections = [['summary','Summary'],['trips','Rides'],['day','Day plan'],['files','Files']];
const lgtcJourneyTypes = [
  ['roundTrip','Round trip'], ['oneWay','One ride in this file'],
  ['multiple','Multiple rides'], ['unmatched','Rider match missing'],
];
let lgtcSettingsData = null;
let lgtcApprovalSource = null;
const lgtcTime = v => v ? String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0') : '—';
const lgtcInputTime = v => v === 0 ? '00:00' : v ? lgtcTime(v) : '';
const lgtcDay = d => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric', timeZone:'UTC' });
const lgtcFleet = [['standard4','4-seat cars'],['standard7','7-seat cars'],['accessible4','Accessible 4-seat vehicles'],['accessible7','Accessible 7-seat vehicles']];

function lgtcSelect(value) {
  lgtcDate = value; lgtcPage = 1; lgtcFilter = 'all'; lgtcDraft = null; lgtcSearch = ''; lgtcOrder = 'earliest'; lgtcSection = 'summary';
  lgtcSelectedRun = '';
  lgtcFleetPreview = false;
}
function showLgtcSection(section, focus = false) {
  lgtcSection = section;
  for (const [key] of lgtcSections) {
    const active = key === section;
    const button = $('#lgtc-tab-' + key);
    const panel = $('#lgtc-panel-' + key);
    if (!button || !panel) continue;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    panel.hidden = !active;
    if (active && focus) button.focus();
  }
}
function lgtcHistoryView() {
  if (!lgtcHistory) return '<p class="muted">Loading saved schedules…</p>';
  return lgtcHistory.length ? lgtcHistory.map(s => '<div class="activity-row"><div><strong>' + s.summaries.map(d => esc(lgtcDay(d.serviceDate))).join(' · ') + '</strong><small>' + s.summaries.reduce((n,d)=>n+d.count,0) + ' rides · Saved ' + esc(date(s.savedAt)) + ' at ' + esc(time(s.savedAt)) + '</small></div><button class="btn small" data-lgtc-open="' + esc(s.id) + '">Open schedule</button></div>').join('') : '<p class="muted">No LGTC schedules saved yet.</p>';
}
function lgtcHandoff() {
  const schedule = lgtcHistory?.[0];
  if (!schedule) return '';
  const latest = schedule.summaries.at(-1);
  const legs = schedule.summaries.reduce((total, day) => total + day.count, 0);
  return '<aside class="planning-handoff"><div><strong>LGTC planning</strong><p>' + legs + ' rides · ' +
    esc(lgtcDay(latest.serviceDate)) + ' · Planning only</p></div><button class="btn small" data-lgtc-open="' +
    esc(schedule.id) + '">Review schedule</button></aside>';
}
function lgtcRows(rows) {
  const dispatched = new Map((state?.trips || []).filter(t=>t.lgtc).map(t=>[t.reference,t]));
  return '<div class="table-scroll"><table><thead><tr><th>Source record</th><th>Pickup → End (ET)</th><th>Stops</th><th>Review</th></tr></thead><tbody>' + rows.map(r =>
    '<tr><td><strong>' + esc(r.reference) + '</strong><small>Row ' + r.row + ' · Code ' + esc(r.code) + '</small>' +
    (r.riderJourney ? '<small>' + esc(lgtcJourneyTypes.find(([key]) => key === r.riderJourney.category)?.[1] || '') +
      (r.riderJourney.direction ? ' · ' + esc(r.riderJourney.direction) + ' · Paired with ' + esc(r.riderJourney.pairedReference) : '') + '</small>' : '') + '</td><td>' +
    (r.review?.start != null ? lgtcInputTime(r.start) : lgtcTime(r.start)) + ' → ' + lgtcTime(r.end) +
    (r.review?.start != null ? '<small>Time confirmed</small>' : '') + '</td><td>' + esc(r.from || 'Unknown') + ' → ' + esc(r.to || 'Unknown') + '</td><td>' +
    esc(r.reasons?.join(' · ') || (r.seats ? r.seats + ' seats' : [...r.issues, ...(r.hasNotes && !r.review?.notesReviewed ? ['Source notes to review'] : [])].join(' · ') || 'Time present')) +
    (r.assignment ? '<small><strong>' + esc(r.assignment) + '</strong></small>' : '') +
    (r.alternateReason ? '<small>' + esc(r.alternateReason) + '</small>' : '') +
    (r.regularDriver ? '<small>Regular driver · ' + esc(r.regularDriver.name) + '</small>' : '') +
    lgtcLiveBadge(dispatched.get('LGTC-' + r.program + '-' + r.serviceDate + '-' + r.reference)) +
    (batch.savedAt ? '<small><button class="text-btn" data-lgtc-review="' + r.row + '" aria-label="Review trip ' + esc(r.reference) + '">' + (r.review ? 'Edit review' : 'Review trip') + '</button></small>' : '') + '</td></tr>'
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
    return '<article class="lgtc-plan-ride" role="listitem"><div class="lgtc-plan-when"><strong>'+clock+'</strong><small>Ends '+lgtcInputTime(leg.end)+' ET · '+(leg.end-leg.start)+' min</small><small>'+esc(leg.reference)+'</small></div>'+
      '<div class="lgtc-plan-route"><strong>'+esc(trip?trip.pickup:leg.from||'Pickup')+' → '+esc(trip?trip.destination:leg.to||'Drop-off')+'</strong>'+
      '<small>'+leg.seats+(leg.seats===1?' rider':' riders')+(leg.mode==='accessible'?' · Wheelchair-accessible vehicle required':'')+'</small>'+
      (leg.riderJourney ? '<small>'+esc(leg.riderJourney.direction)+' · Paired with '+esc(leg.riderJourney.pairedReference)+'</small>' : '')+'</div>'+
      '<div class="lgtc-plan-person">'+(leg.regularDriver ? '<small>Regular driver</small><strong>'+esc(leg.regularDriver.name)+'</strong>' : '')+
      (leg.alternateReason?'<small>'+esc(leg.alternateReason)+'</small>':'')+'</div>'+
      '<div class="lgtc-plan-outcome"><small>Live dispatch</small><div class="lgtc-plan-live" data-lgtc-plan-ref="'+esc(ref)+'" data-planned-id="'+esc(run.driverId||'')+'">'+
      lgtcPlanDispatchView(trip,run.driverId)+'</div><button type="button" class="text-btn" data-lgtc-plan-track="'+esc(trip?.id||'')+
      '" data-lgtc-plan-row="'+leg.row+'">'+(trip?'Track ride':'Open ride details')+'</button></div></article>';
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
    const label=trip?'Track ride':'Open ride details';
    if(button.textContent!==label) button.textContent=label;
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
const lgtcNoteTopics = [
  { key:'note-time', label:'Pickup timing', pattern:/\bwill[\s-]*call\b|\b(?:call|text)\b.{0,24}\bbefore\b/i,
    action:'Check whether the workbook time is fixed or the rider needs to confirm pickup.' },
  { key:'note-access', label:'Vehicle accessibility', pattern:/\b(?:wheel[\s-]*chair|walker|stretcher|mobility scooter|wheelchair lift|accessible)\b/i,
    action:'Confirm what assistance or accessible vehicle this rider needs.' },
  { key:'note-seats', label:'Passenger count', pattern:/\b(?:companion|attendant|caregiver|escort|passengers|riders|extra seat)\b/i,
    action:'Confirm how many seats the rider and any companions need.' },
];
function lgtcNoteSuggestions(ride) {
  const notes = ride.sourceDetails?.instructions || [];
  if (!notes.length || ride.review?.notesReviewed || ride.instructionPolicy?.needsReview === false) return [];
  const suggestions = lgtcNoteTopics.flatMap(topic => {
    const evidence = notes.filter(note => topic.pattern.test(note));
    return evidence.length ? [{ ...topic, evidence }] : [];
  });
  return suggestions.length ? suggestions : [{ key:'note-other', label:'Other instructions',
    action:'Read the instructions and confirm whether they change the plan.', evidence:notes }];
}
function repeatedNoteGroups() {
  const groups = new Map();
  for (const ride of batch.rows) {
    const notes = ride.sourceDetails?.instructions;
    if (ride.serviceDate !== lgtcDate || !notes?.length || ride.review?.notesReviewed ||
        ride.instructionPolicy?.needsReview === false ||
        notes.some(note => /wheel[\s-]*chair|walker|stretcher|scooter|ramp|attendant|escort|companion|passengers?|extra seat|oxygen/i.test(note))) continue;
    const key = JSON.stringify(notes.map(note => note.trim().replace(/\s+/g,' ').toLowerCase()).sort());
    if (!groups.has(key)) groups.set(key,{ notes, rides:[] });
    groups.get(key).rides.push(ride);
  }
  return [...groups.values()].filter(group => group.rides.length > 1).sort((a,b) => b.rides.length - a.rides.length);
}
function openRepeatedNoteReview() {
  const groups = repeatedNoteGroups();
  const { id, revision = 0 } = batch, serviceDate = lgtcDate;
  modal('<h2>Review repeated instructions</h2><p>Read each set of instructions once. Mark a group reviewed only after checking that the same instructions are suitable for every listed ride. Existing time, seat, and accessibility flags still apply.</p>' +
    (groups.length ? groups.map((group,index) => '<details' + (index === 0 ? ' open' : '') + '><summary>' + group.rides.length +
      ' rides with the same instructions</summary><ul>' + group.notes.map(note => '<li>' + esc(note) + '</li>').join('') +
      '</ul><p class="help">' + group.rides.map(ride => esc(ride.reference)).join(', ') +
      '</p><button type="button" class="btn small" data-lgtc-review-note-group="' + index + '">Mark these instructions reviewed</button></details>').join('') :
      '<p>No repeated unread instructions remain for this date.</p>'));
  document.querySelectorAll('[data-lgtc-review-note-group]').forEach(button => button.onclick = () => run(async () => {
    const group = groups[Number(button.dataset.lgtcReviewNoteGroup)];
    button.disabled = true;
    try {
      const result = await api('/api/lgtc/review-repeated-notes',{ id, revision, serviceDate, row:group.rides[0].row, count:group.rides.length });
      if (tab !== 'imports' || batch?.id !== id || lgtcDate !== serviceDate) return;
      batch = result.batch;
      lgtcDraft = null;
      $('#modal').close();
      render();
      openRepeatedNoteReview();
      toast(result.count + ' rides updated. Rebuild the draft to schedule eligible rides.');
    } finally { button.disabled = false; }
  }));
}
function lgtcPreview(files = '') {
  const info = batch.summaries.find(s => s.serviceDate === lgtcDate) || batch.summaries[0];
  const rows = batch.rows.filter(r => r.serviceDate === info.serviceDate);
  const pickup = row => row.review?.start ?? (row.start || null);
  rows.sort((a, b) => {
    const startA = pickup(a), startB = pickup(b);
    if (startA === null || startB === null) return Number(startA === null) - Number(startB === null) || a.row - b.row;
    return (lgtcOrder === 'latest' ? startB - startA : startA - startB) || a.row - b.row;
  });
  const hasScheduledTime = row => row.start !== null && row.end > row.start && (row.start > 0 || row.review?.start === 0);
  const unassigned = new Map((lgtcDraft?.unplanned || []).map(leg => [leg.row,leg.reasons]));
  const noteTopics = [...lgtcNoteTopics, {key:'note-other',label:'Other instructions'}];
  if ((lgtcFilter === 'unassigned' || lgtcFilter.startsWith('note-')) && !lgtcDraft) lgtcFilter = 'review';
  const filters = {
    all: () => true,
    scheduled: hasScheduledTime,
    time: row => !hasScheduledTime(row),
    peak: row => info.peakAt !== null && hasScheduledTime(row) && row.start <= info.peakAt && row.end > info.peakAt,
    unassigned: row => unassigned.has(row.row),
    review: row => row.issues.length || row.hasNotes && !row.review?.notesReviewed,
  };
  for (const { key } of noteTopics) {
    filters[key] = row => unassigned.has(row.row) && lgtcNoteSuggestions(row).some(suggestion => suggestion.key === key);
  }
  for (const [key] of lgtcJourneyTypes) filters[key] = row => row.riderJourney?.category === key;
  const filtered = rows.filter(filters[lgtcFilter]);
  if (lgtcFilter === 'roundTrip') {
    const byRow = new Map(rows.map(ride => [ride.row,ride]));
    const groupStart = ride => Math.min(pickup(ride) ?? Infinity,
      pickup(byRow.get(ride.riderJourney.pairedRow)) ?? Infinity);
    filtered.sort((a,b) => (lgtcOrder === 'latest' ? groupStart(b) - groupStart(a) : groupStart(a) - groupStart(b)) ||
      Math.min(a.row,a.riderJourney.pairedRow) - Math.min(b.row,b.riderJourney.pairedRow) ||
      Number(a.riderJourney.direction === 'Return') - Number(b.riderJourney.direction === 'Return'));
  }
  const query = lgtcSearch.toLowerCase();
  const visible = filtered.filter(r => !query || String(r.row) === query || [r.reference,r.from,r.to].some(s => s?.toLowerCase().includes(query)));
  const pageSize = lgtcFilter === 'roundTrip' && !query ? 24 : 25;
  const pages = Math.max(1, Math.ceil(visible.length / pageSize));
  lgtcPage = Math.min(lgtcPage, pages);
  const firstRow = (lgtcPage - 1) * pageSize;
  const displayed = visible.length ? 'Showing ' + (firstRow + 1) + '–' + Math.min(firstRow + pageSize, visible.length) + ' of ' + visible.length : '0';
  const pagination = '<div class="pagination"><span>' + displayed + ' matching rides</span><button class="btn small" data-lgtc-page="' + (lgtcPage - 1) + '" ' + (lgtcPage <= 1 ? 'disabled' : '') + '>Previous</button><small>' + lgtcPage + ' / ' + pages + '</small><button class="btn small" data-lgtc-page="' + (lgtcPage + 1) + '" ' + (lgtcPage >= pages ? 'disabled' : '') + '>Next</button></div>';
  const dayDraft = batch.drafts?.[info.serviceDate];
  const riderAnalysis = info.riderAnalysis;
  const staffing = info.staffing;
  const panel = key => '<section role="tabpanel" id="lgtc-panel-' + key + '" aria-labelledby="lgtc-tab-' + key + '"' +
    (lgtcSection === key ? '' : ' hidden') + '>';
  const hours = info.hours.map((n,h)=>n ? '<li><strong>' + lgtcTime(h * 60 || 1440).replace('24:00','00:00') + '</strong> · ' + n + '</li>' : '').join('');
  return '<section class="panel lgtc-panel" id="lgtc-review"><div class="panel-heading"><div><h2>LGTC schedule · ' + esc(lgtcDay(info.serviceDate)) + '</h2><p>' + batch.rows.length + ' rides in this upload · ' + batch.dates.length + (batch.dates.length === 1 ? ' service date' : ' service dates') + '</p><p>Eastern time · ' +
    (config.mode==='pilot'?'Verified rides enter Dispatch after owner approval':'Eligible test rides enter Dispatch after owner approval') + '</p></div>' +
    (batch.savedAt ? '<div class="lgtc-heading-actions">' + badge('Saved schedule') +
      '<button class="btn primary" id="lgtc-day-jump">' + (dayDraft?.stale ? 'Rebuild day plan' : dayDraft ? 'View saved day plan' : 'Open day planner') + '</button></div>' :
      '<button class="btn primary" id="lgtc-save">Save and open day planner</button>') + '</div>' +
    (batch.dates.length > 1 ? '<label>Service date<select id="lgtc-date">' + batch.dates.map(d=>'<option value="' + esc(d) + '" ' + (d === info.serviceDate ? 'selected' : '') + '>' + esc(lgtcDay(d)) + '</option>').join('') + '</select></label>' : '') +
    '<div class="lgtc-tabs" role="tablist" aria-label="Schedule sections">' + lgtcSections.map(([key,label]) =>
      '<button type="button" role="tab" id="lgtc-tab-' + key + '" data-lgtc-section="' + key + '" aria-controls="lgtc-panel-' + key +
      '" aria-selected="' + (lgtcSection === key) + '" tabindex="' + (lgtcSection === key ? 0 : -1) + '">' + label + '</button>').join('') + '</div>' +
    panel('summary') +
    '<div class="lgtc-metrics">' + [
      ['all',info.count,'Rides'], ['scheduled',info.scheduled,'With scheduled times'],
      ['time',info.missingTime,'Need a valid time'], ['peak',info.peak,'Peak overlap' + (info.peak ? ' at ' + lgtcTime(info.peakAt) + ' ET' : '')],
    ].map(([filter,count,label]) => '<a href="#lgtc-filter" data-lgtc-metric="' + filter + '"' +
      (lgtcFilter === filter ? ' aria-current="true"' : '') + '><strong>' + count + '</strong><span>' + label + '</span></a>').join('') + '</div>' +
    (riderAnalysis ? '<section aria-label="Rider analysis"><h3>Rider analysis for this date</h3><div class="lgtc-metrics">' +
      [[riderAnalysis.identifiableRiders,'Identifiable riders'],[riderAnalysis.ridersWithMultipleLegs,'Riders with multiple rides'],
        [riderAnalysis.unmatchedLegs,'Rides without a usable name and mobile']].map(([count,label]) =>
        '<div><strong>' + count + '</strong><span>' + label + '</span></div>').join('') +
      '</div>' + (riderAnalysis.ridePatterns ? '<h4>Rider journeys</h4><div class="lgtc-metrics">' +
        lgtcJourneyTypes.filter(([key]) => key !== 'unmatched').map(([key,label]) => '<a href="#lgtc-filter" data-lgtc-metric="' +
          key + '"><strong>' + riderAnalysis.ridePatterns[key] + '</strong><span>' + label + ' · riders</span></a>').join('') +
        '</div><p class="help">Pairs share a rider, service date, and LGTC booking reference. The planner schedules outbound and return times separately.</p>' : '') +
      '</section>' : '') +
    (staffing ? '<section aria-label="Staffing estimate"><h3>Staffing estimate for this date</h3>' +
      (staffing.peak.at === null ? '<p class="help">Add valid pickup and drop-off times to estimate staffing.</p>' :
        '<div class="lgtc-metrics">' + [
          [staffing.peak.count,'Cars needed at workbook peak'], [staffing.carsAtPeak,'Roster cars counted at peak'],
          [staffing.peakGap,'Estimated extra drivers and cars at peak'],
        ].map(([count,label]) => '<div><strong>' + count + '</strong><span>' + label + '</span></div>').join('') +
        '</div><p class="help">Peak at ' + lgtcInputTime(staffing.peak.at) + ' ET with a ' + staffing.buffer + ' min buffer. ' +
        staffing.missingTimes + ' rides have no valid time and are outside this estimate. ' +
        (staffing.driversWithoutHours ? staffing.driversWithoutHours + ' roster drivers have no hours entered and are assumed available. ' : '') +
        'Build the day plan to check seats, accessibility, and full-ride shift coverage.</p>') + '</section>' : '') +
    '<p class="help">Peak overlap excludes travel between trips. ' + info.withNotes + ' rides have source notes. Use the row number or reference to check the original file.</p>' +
    (batch.linked ? '<p class="help">' + rows.filter(r=>r.regularDriver).length + ' rides match a saved regular driver. Open <strong>Review trip</strong> to set a preference for a rider.</p>' :
      '<p class="notice">Upload and save the original file again to add regular-driver matching to this saved schedule.</p>') +
    '<details><summary>Pickup demand by hour</summary><ul class="lgtc-hours">' + hours + '</ul></details></section>' +
    panel('trips') +
    '<div class="lgtc-row-tools"><label>Pickup order<select id="lgtc-order" aria-label="Pickup order"><option value="earliest">Earliest pickup first</option><option value="latest" ' + (lgtcOrder === 'latest' ? 'selected' : '') + '>Latest pickup first</option></select></label>' +
    '<label>Show rides<select id="lgtc-filter">' + [
      ['all','All rides'], ['scheduled','With scheduled times'], ['time','Missing or invalid time'],
      ['peak','Peak overlap'], ['review','Source flags or notes'],
      ...lgtcJourneyTypes,
      ...(lgtcDraft ? [['unassigned','Unassigned in day plan'], ...noteTopics.map(({key,label}) => [key,label])] : []),
    ].map(([filter,label]) => '<option value="' + filter + '"' + (lgtcFilter === filter ? ' selected' : '') + '>' + label + '</option>').join('') + '</select></label>' +
    '<form id="lgtc-search-form"><label>Find a trip<input type="search" name="query" value="' + esc(lgtcSearch) + '" placeholder="Reference, row or city" maxlength="100"></label><button class="btn small" type="submit">Search</button></form></div>' +
    pagination + (visible.length ? lgtcRows(visible.slice(firstRow, firstRow + pageSize).map(row =>
      unassigned.has(row.row) ? { ...row, reasons:unassigned.get(row.row) } : row)) : '<p class="muted">No rides match this filter.</p>') +
    '</section>' + panel('day') +
    (batch.savedAt ? lgtcPlanner(info) : '<p class="help">Save the schedule to build a day plan.</p>') +
    '</section>' + panel('files') + files + '</section></section>';
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
    'New uploads build a draft when saved. ' + automation.driverCount + ' drivers · Service codes ' + (automation.codes.join(', ') || 'none') :
    'Automatic planning is off. Build a draft below, then save its settings for future uploads.';
  const canReuse = !saved?.stale && settings?.driverIds?.length && Object.keys(settings.profiles || {}).length;
  const roster = batch.roster || [];
  const choices = roster.map(d=>'<label class="lgtc-check"><input type="checkbox" name="driverIds" value="' + esc(d.id) + '" ' +
    (settings?.driverIds?.includes(d.id) ? 'checked' : '') + '><span><strong>' + esc(d.name) + '</strong><small>' +
    esc(d.vehicle) + ' · ' + d.seats + ' seats' + (d.accessible ? ' · Accessible' : '') + '</small><small>' +
    (d.availability?.[info.serviceDate]?.unavailable ? 'Unavailable that day' :
      d.availability?.[info.serviceDate] ? lgtcInputTime(d.availability[info.serviceDate].start) + '–' +
        lgtcInputTime(d.availability[info.serviceDate].end) + ' ET' : 'No shift entered') + '</small></span></label>').join('');
  const vehicleInput = ([key,label]) => '<label>' + label + '<input type="number" name="' + key + '" min="0" max="500" value="' + (settings?.fleet[key] ?? 0) + '"></label>';
  const noteGroups = repeatedNoteGroups();
  return '<section class="panel lgtc-panel" id="lgtc-planner"><h2>Full-day driver plan</h2><p class="muted">Select your drivers to see who gets each ride, or enter how many 4-seat and 7-seat cars you have to check capacity.</p>' +
    '<div class="lgtc-defaults-status"><div><strong>Auto-scheduler</strong><p>' + esc(automationStatus) +
    '</p><p>The planner compares schedules to cover the most eligible rides. It checks shifts, travel buffer, seats, and wheelchair access before assigning a driver.</p></div>' +
    '<div><button class="btn small" data-go="lgtc-settings">Manage auto-scheduler</button>' +
    (canReuse ? '<button type="button" class="btn small" id="lgtc-use-draft-defaults">Use this draft for future uploads</button>' : '') +
    '</div></div>' +
    status + (noteGroups.length ? '<p><button type="button" class="btn" id="lgtc-repeat-notes">Review repeated instructions</button> <span class="help">' +
      noteGroups.reduce((total,group) => total + group.rides.length,0) + ' rides share instructions across ' + noteGroups.length + ' groups.</span></p>' : '') +
    '<details class="lgtc-plan-settings"' + (!saved || saved.stale ? ' open' : '') + '><summary>Planning settings</summary>' +
    '<form id="lgtc-plan-form"><label>Planning mode<select name="planMode"><option value="named" ' + (named ? 'selected' : '') +
    '>Assign rides to drivers</option><option value="estimate" ' + (!named ? 'selected' : '') + '>Check capacity by car count</option></select></label>' +
    '<fieldset id="lgtc-named-roster" ' + (!named ? 'hidden' : '') + '><legend>Drivers available for this day</legend><div class="lgtc-roster">' +
    (choices || '<p>Add an ordinary fleet driver in Manage first.</p>') + '</div></fieldset>' +
    '<fieldset id="lgtc-estimate-fleet" ' + (named ? 'hidden' : '') + '><legend>Cars available</legend><button type="button" class="btn small" id="lgtc-test-20-cars">Run 20-car test</button><p class="help">Tests 14 standard 4-seat cars, 4 standard 7-seat cars, and 2 wheelchair-accessible 7-seat vehicles without replacing the saved plan.</p><div class="lgtc-inputs">' + lgtcFleet.slice(0,2).map(vehicleInput).join('') +
    '</div><details' + (settings?.fleet.accessible4 || settings?.fleet.accessible7 ? ' open' : '') + '><summary>Wheelchair-accessible vehicles</summary><div class="lgtc-inputs">' +
    lgtcFleet.slice(2).map(vehicleInput).join('') + '</div></details></fieldset>' +
    '<div class="lgtc-inputs">' +
    '<label>Between trips (minutes)<input type="number" name="buffer" min="0" max="180" value="' + (settings?.buffer ?? 30) + '" required></label></div>' +
    '<details><summary>LGTC passenger and accessibility rules</summary><p class="help">The car’s 4 or 7 seats are its capacity. Enter the seats a booking needs here only when LGTC has confirmed the rule. Unverified rides go to Needs attention.</p>' +
    codes.map(([c,n]) => {
      const profile = settings?.profiles[c];
      return '<fieldset><legend>Code ' + esc(c) + ' · ' + n + ' rides</legend><div class="lgtc-inputs"><label>Service type<select name="mode-' + esc(c) + '">' +
        lgtcModeOptions(profile?.mode, 'Needs verification') + '</select></label><label>Seats needed per booking<input type="number" name="base-' + esc(c) + '" min="1" max="7" value="' + (profile?.base ?? '') + '" placeholder="Confirm count"></label></div><details' + (profile?.extras.length ? ' open' : '') + '><summary>Extra passenger fields</summary><div class="lgtc-checks">' +
        [30,31,32].map((n,i)=>'<label><input type="checkbox" name="extras-' + esc(c) + '" value="' + i + '" ' + (profile?.extras.includes(i) ? 'checked' : '') + '> Field ' + n + ' counts extra seats</label>').join('') + '</div></details></fieldset>';
    }).join('') + '<label class="lgtc-check"><input type="checkbox" name="notesReviewed" ' + (settings?.notesReviewed ? 'checked' : '') +
    '> I reviewed all trip notes for this date</label></details>' +
    '<button class="btn primary" type="submit">Build and save draft</button></form></details>' +
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
function lgtcFleetEstimate(demand) {
  if (!demand) return '';
  const metrics = [
    [demand.averageRideMinutes === null ? '—' : demand.averageRideMinutes + ' min','Average pickup to drop-off'],
    [demand.scheduledPeak.count,'Peak cars by workbook times'],
    [demand.recommendedVehicles,'Cars for verified rides'],
  ];
  return '<section class="notice"><h4>Fleet needed</h4><div class="lgtc-metrics">' +
    metrics.map(([value,label]) => '<div><strong>' + value + '</strong><span>' + label + '</span></div>').join('') + '</div>' +
    '<p>' + demand.timedRides + ' rides have a scheduled duration. Peak demand includes the between-ride buffer' +
    (demand.scheduledPeak.at === null ? '' : ' and reaches its highest point at ' + lgtcInputTime(demand.scheduledPeak.at) + ' ET') + '.</p>' +
    '<p>Plan for one driver per car. ' + demand.selectedVehicles + ' cars are selected for this draft, including ' + demand.selectedAccessible +
    ' accessible. The fleet mix below covers ' + demand.classifiedRides + ' rides with verified requirements. ' + demand.ridesOutsideEstimate +
    ' rides still need review before they can be included.</p>' +
    (demand.extraDrivers === undefined ? '' : '<p><strong>' + demand.extraDrivers + ' additional drivers and cars</strong> estimated for ' +
      demand.staffingHolds + ' eligible rides the current fleet could not cover.</p>') +
    '<div class="table-scroll"><table><thead><tr><th>Vehicle type</th><th>Rides</th><th>Cars and drivers</th><th>Extra needed</th></tr></thead><tbody>' +
    demand.groups.map(group => '<tr><td>' + esc(group.label) + '</td><td>' + group.rides + '</td><td>' + group.vehicles +
      '</td><td>' + (group.extraDrivers ?? '—') + (group.extraPeakAt != null ? ' at ' + lgtcInputTime(group.extraPeakAt) + ' ET' : '') + '</td></tr>').join('') +
    '</tbody></table></div><p class="help">Extra staffing assumes the current assignments stay in place and counts peak overlap for each vehicle type. Travel between rides is represented by the buffer.</p></section>';
}
function lgtcResults() {
  if (!lgtcDraft) return '';
  const d = lgtcDraft;
  const unassignedRows = new Set(d.unplanned.map(ride => ride.row));
  const topics = new Map();
  let scanned = 0;
  for (const ride of batch.rows) {
    if (ride.serviceDate !== d.serviceDate || !unassignedRows.has(ride.row)) continue;
    const suggestions = lgtcNoteSuggestions(ride);
    if (suggestions.length) scanned++;
    for (const { key, label } of suggestions) {
      const count = topics.get(key)?.count ?? 0;
      topics.set(key, { label, count:count + 1 });
    }
  }
  const reasons = new Map();
  for (const leg of d.unplanned) for (const reason of leg.reasons) reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  const breakdown = [...reasons].sort((a,b)=>b[1]-a[1]).map(([reason,count]) => '<li><strong>' + count + '</strong> · ' + esc(reason) + '</li>').join('');
  const count = (run, assignment) => run.trips.filter(t=>t.assignment === assignment).length;
  const regular = d.runs.reduce((n,r)=>n+count(r,'Regular driver'),0);
  const named = !!d.settings.driverIds;
  const metrics = [[d.allocated,'Planned rides'],[d.unplanned.length,'Need review']];
  if (d.optimization) metrics.push([d.optimization.carsUsed + ' / ' + d.optimization.carsSelected,'Cars and drivers used']);
  if (named) metrics.push([regular,'Planned with regular driver']);
  if (named && d.roundTripsWithSameDriver !== undefined) metrics.push([d.roundTripsWithSameDriver,'Round trips with one driver']);
  const dispatched=new Map(state.trips.filter(t=>t.lgtc).map(t=>[t.reference,t]));
  const runKey = run => run.driverId || run.label;
  const selected = d.runs.find(run => runKey(run) === lgtcSelectedRun) || d.runs.find(run => run.trips.length) || d.runs[0];
  return '<section class="lgtc-workspace">' + (lgtcFleetPreview ? '<p class="notice">20-car test preview</p>' : '') +
    '<header class="lgtc-workspace-head"><div><span class="eyebrow">OWNER SCHEDULE</span><h3>'+esc(lgtcDay(d.serviceDate))+
    '</h3><p>Day plan and actual dispatch · Eastern time · '+d.buffer+' min between rides</p></div>'+
    (named && d.allocated ? '<button class="btn primary" id="lgtc-dispatch-review">Review for dispatch</button>' : '') + '</header>'+
    '<div class="lgtc-metrics">' + metrics.map(([n,label])=>'<div><strong>' + n + '</strong><span>' + label + '</span></div>').join('') + '</div>' +
    (d.optimization?.recoveredRides ? '<p class="help">The planner found room for ' + d.optimization.recoveredRides +
      ' more rides by moving a conflicting assignment.</p>' : '') +
    lgtcFleetEstimate(d.fleetDemand) +
    (scanned ? '<section class="notice"><h4>Trip review assistant</h4><p>' + scanned +
      ' unassigned rides have unread workbook instructions. A ride may appear in more than one group.</p><div class="lgtc-review-topics">' +
      [...topics].map(([key,{label,count}]) => '<button type="button" class="btn small" data-lgtc-metric="' + key + '">' +
        esc(label) + ' · ' + count + '</button>').join('') + '</div></section>' : '') +
    (d.unplanned.length ? '<details class="lgtc-unassigned"><summary>Why rides need attention</summary><ul class="lgtc-hours">' + breakdown +
      '</ul></details><button class="btn small" data-lgtc-metric="unassigned">Review ' + d.unplanned.length + ' unassigned rides</button>' : '') +
    (selected ? '<label class="lgtc-run-picker">' + (named ? 'Driver schedule' : 'Vehicle schedule') + '<select id="lgtc-run-picker">' +
      d.runs.map(run => '<option value="' + esc(runKey(run)) + '"' + (run === selected ? ' selected' : '') + '>' +
        esc(run.label) + ' · ' + run.trips.length + ' planned</option>').join('') + '</select></label>' +
      (selected.vehicle ? '<p class="help">' + esc(selected.vehicle) + ' · ' + selected.seats + ' seats' + (selected.accessible ? ' · Accessible' : '') + '</p>' : '') +
      (selected.trips.length ? lgtcPlanRideCards(selected,dispatched) : '<p class="help">No rides planned for this date.</p>') : '') + '</section>';
}
function openLgtcDispatchApproval() {
  const id = batch.id, serviceDate = lgtcDate, revision = batch.revision ?? 0;
  const readySource = lgtcApprovalSource?.id === id ? lgtcApprovalSource : null;
  modal('<h2>Review LGTC rides for dispatch</h2><p>' + esc(lgtcDay(serviceDate)) +
    (config.mode==='pilot'?' · Rides need future pickup times, verified addresses, and rider phone numbers.':
      ' · Local dispatch test. Rides need a future pickup, verified demo stops, and a dummy rider number.') + '</p>' +
    '<form id="lgtc-dispatch-form"><label>Original LGTC file<input type="file" accept=".csv,.xlsx" ' + (readySource ? '' : 'required') +
    '></label><p class="help">' + (readySource ? 'This tab already has the uploaded file.' : 'Choose the exact file you used to save this schedule.') +
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
      if (file?.size > 5*1024*1024) throw Error('Choose a file that is 5 MB or smaller.');
      const base64 = file ? await new Promise((resolve,reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(Error('Could not read the file.'));
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
    if (config.sheetOnly && tab === 'imports' && !batch && schedules.length) {
      const result = await api('/api/lgtc/schedules?id=' + encodeURIComponent(schedules[0].id));
      if (user?.role !== 'owner' || tab !== 'imports' || batch) return;
      batch = result.batch;
      lgtcSelect(batch.dates[0]);
      render();
      await reopenLgtcDraft();
      return;
    }
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
  lgtcFleetPreview = false;
  $('#lgtc-plan-results').innerHTML = lgtcResults();
  bindLgtc();
}
function openLgtcReview(row) {
  const leg = batch.rows.find(r => r.row === row);
  if (!leg) return;
  const review = leg.review;
  const id = batch.id, revision = batch.revision ?? 0;
  const source = leg.sourceDetails;
  const journey = leg.riderJourney;
  const instructionPolicy = leg.instructionPolicy;
  const suggestions = lgtcNoteSuggestions(leg);
  const history = leg.riderHistory;
  const historyLabel = !history ? 'Rider history needs a valid name and mobile number.' :
    history.sameRouteDates ? 'Repeat route on ' + history.sameRouteDates + ' earlier service date(s).' :
    history.priorDates ? 'Returning rider on ' + history.priorDates + ' earlier service date(s).' :
    'No earlier service dates for this rider in the saved schedules.';
  const address = parts => esc(parts.filter(Boolean).join(', ') || 'Missing from workbook');
  const needsTime = leg.issues.some(issue => /scheduled time|must follow pickup|will.call/i.test(issue));
  const currentTime = review?.start != null ? lgtcInputTime : lgtcTime;
  modal('<h2>Review trip ' + esc(leg.reference) + '</h2><p>' + esc(lgtcDay(leg.serviceDate)) + ' · Source row ' + row + ' · Code ' + esc(leg.code) +
    '</p>' + (journey?.pairedRow ? '<p>' + esc(journey.direction) + ' · <button type="button" class="text-btn" id="lgtc-paired-ride">Open ' +
      (journey.direction === 'Outbound' ? 'return' : 'outbound') + ' ride ' + esc(journey.pairedReference) + '</button></p>' : '') +
    '<p><strong>' + (review?.start != null ? 'Reviewed schedule' : 'Workbook schedule') + ' (ET)</strong> ' +
    currentTime(leg.start) + ' → ' + currentTime(leg.end) +
    (leg.additionalTime ? ' · Additional source time ' + lgtcTime(leg.additionalTime) : '') + '</p>' +
    (source ? '<section class="notice"><h3>From the workbook</h3><p><strong>Rider</strong> ' + esc(source.name || 'Missing from workbook') +
      '</p><p><strong>Pickup</strong> ' + address(source.pickupAddress) + '</p><p><strong>Drop-off</strong> ' + address(source.destinationAddress) +
      '</p><h4>Rider history</h4><p>' + esc(historyLabel) + (history?.lastDate ? ' Last seen ' + esc(lgtcDay(history.lastDate)) + '.' : '') +
      '</p><h4>Trip instructions</h4>' + (source.instructions.length ? '<ul>' + source.instructions.map(note => '<li>' + esc(note) + '</li>').join('') + '</ul>' : '<p>No instructions in this row.</p>') + '</section>' : '') +
    (instructionPolicy?.accessible ? '<p class="notice">The workbook indicates a wheelchair requirement. The planner uses an accessible vehicle unless a reviewed vehicle setting specifies otherwise.</p>' : '') +
    (instructionPolicy?.needsReview === false ? '<p class="help">These workbook instructions can stay with the ride without a separate review.</p>' : '') +
    (suggestions.length && instructionPolicy?.needsReview !== false ? '<section class="notice"><h3>Review suggestions</h3><ul>' +
      suggestions.map(({label,action,evidence}) => '<li><strong>' + esc(label) + '</strong> ' + esc(action) +
        '<blockquote>' + evidence.map(esc).join('<br>') + '</blockquote></li>').join('') + '</ul></section>' : '') +
    '<form id="lgtc-leg-form"><details' + (needsTime ? ' open' : '') + '><summary>' +
    (needsTime ? 'Confirm the schedule for this ride' : 'Change pickup or end time') + '</summary><p class="help">' +
    (needsTime ? 'This ride has a time flag. Enter both times after you confirm them.' : 'Leave these fields empty to use the workbook schedule.') + '</p>' +
    '<div class="lgtc-inputs"><label>Pickup (ET)<input type="time" name="start" value="' + lgtcInputTime(review?.start) +
    '"></label><label>End (ET)<input type="time" name="end" value="' + lgtcInputTime(review?.end) + '"></label></div></details>' +
    '<details><summary>Change vehicle or seats for this ride</summary><div class="lgtc-inputs"><label>Vehicle requirement<select name="mode">' +
    lgtcModeOptions(review?.mode, 'Use service code setting') + '</select></label><label>Seats needed<input type="number" min="1" max="7" name="seats" value="' +
    (review?.seats ?? '') + '"></label></div></details>' +
    (leg.hasNotes ? '<label class="lgtc-check"><input type="checkbox" name="notesReviewed" ' + (review?.notesReviewed ? 'checked' : '') +
    '> I checked this trip’s instructions</label>' : '') +
    '<div class="lgtc-edit-actions"><button class="btn primary" type="submit">Save trip review</button>' +
    (review ? '<button class="btn" type="button" id="lgtc-reset-review">Restore imported details</button>' : '') + '</div></form>' +
    (leg.canMatchCustomer ? '<form id="lgtc-preference-form"><h3>Regular driver</h3><p class="help">Applies to future LGTC rows for the same rider and mobile. Verify the rider in the original file using source row ' +
      leg.row + '.</p><label>Preferred driver<select name="driverId"><option value="">Use standard booking preference if available</option>' +
      batch.roster.map(d => '<option value="' + esc(d.id) + '" ' + (leg.regularDriver?.id === d.id ? 'selected' : '') + '>' + esc(d.name) + '</option>').join('') +
      '</select></label><button class="btn" type="submit">Save regular driver</button></form>' : ''));
  const form = $('#lgtc-leg-form');
  if ($('#lgtc-paired-ride')) $('#lgtc-paired-ride').onclick = () => {
    $('#modal').close();
    openLgtcReview(journey.pairedRow);
  };
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
  if ($('#lgtc-repeat-notes')) $('#lgtc-repeat-notes').onclick = openRepeatedNoteReview;
  bindLgtcSettings();
  if ($('#lgtc-dispatch-review')) $('#lgtc-dispatch-review').onclick = openLgtcDispatchApproval;
  document.querySelectorAll('[data-lgtc-track]').forEach(button => {
    button.onclick = () => trackLgtcRide(button.dataset.lgtcTrack);
  });
  document.querySelectorAll('[data-lgtc-plan-track]').forEach(button => {
    button.onclick = () => {
      const tripId = button.dataset.lgtcPlanTrack;
      if (tripId && state.trips.some(trip => trip.id === tripId)) trackLgtcRide(tripId);
      else openLgtcReview(Number(button.dataset.lgtcPlanRow));
    };
  });
  if ($('#lgtc-day-jump')) $('#lgtc-day-jump').onclick = () => {
    showLgtcSection('day', true);
  };
  document.querySelectorAll('[data-lgtc-section]').forEach(button => {
    button.onclick = () => showLgtcSection(button.dataset.lgtcSection);
    button.onkeydown = event => {
      const keys = lgtcSections.map(([key]) => key);
      const index = keys.indexOf(button.dataset.lgtcSection);
      const target = { ArrowLeft:keys[(index + keys.length - 1) % keys.length], ArrowRight:keys[(index + 1) % keys.length],
        Home:keys[0], End:keys.at(-1) }[event.key];
      if (!target) return;
      event.preventDefault();
      showLgtcSection(target, true);
    };
  });
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
      lgtcSection = 'day';
      lgtcUpload = null; await loadLgtcHistory(); await reopenLgtcDraft();
      const auto = result.autoPlanned?.find(day => day.serviceDate === lgtcDate);
      $(lgtcDraft ? '#lgtc-plan-results' : '#lgtc-planner')?.scrollIntoView({block:'start'});
      toast(result.autoError || (auto ? auto.allocated + ' allocated · ' + auto.unassigned + ' need review. Draft saved.' : 'LGTC schedule saved. Ready for planning.'), !!result.autoError);
    } finally { lgtcBusy = false; if ($('#lgtc-save')) $('#lgtc-save').disabled = false; }
  });
  if ($('#lgtc-date')) $('#lgtc-date').onchange = e => {
    const section = lgtcSection;
    lgtcSelect(e.target.value);
    lgtcSection = section;
    render();
    run(reopenLgtcDraft);
  };
  const updateRows = () => {
    const old = $('#lgtc-panel-trips'), pageTop = window.scrollY;
    const next = document.createElement('template'); next.innerHTML = lgtcPreview();
    old.replaceWith(next.content.querySelector('#lgtc-panel-trips'));
    document.querySelectorAll('[data-lgtc-metric]').forEach(link => {
      if (link.dataset.lgtcMetric === lgtcFilter) link.setAttribute('aria-current','true');
      else link.removeAttribute('aria-current');
    });
    bindLgtc(); window.scrollTo(0,pageTop);
  };
  if ($('#lgtc-filter')) $('#lgtc-filter').onchange = e => { lgtcFilter = e.target.value; lgtcPage = 1; updateRows(); $('#lgtc-filter')?.focus({preventScroll:true}); };
  document.querySelectorAll('[data-lgtc-metric]').forEach(link => link.onclick = event => {
    event.preventDefault();
    lgtcFilter = link.dataset.lgtcMetric;
    lgtcSearch = '';
    lgtcPage = 1;
    showLgtcSection('trips');
    updateRows();
    const filter = $('#lgtc-filter');
    filter?.focus({preventScroll:true});
    filter?.scrollIntoView({block:'center'});
  });
  if ($('#lgtc-order')) $('#lgtc-order').onchange = e => { lgtcOrder = e.target.value; lgtcPage = 1; updateRows(); $('#lgtc-order')?.focus({preventScroll:true}); };
  if ($('#lgtc-search-form')) $('#lgtc-search-form').onsubmit = e => {
    e.preventDefault();
    lgtcSearch = new FormData(e.currentTarget).get('query').trim(); lgtcPage = 1; updateRows();
    $('#lgtc-search-form input')?.focus({preventScroll:true});
  };
  document.querySelectorAll('[data-lgtc-page]').forEach(el => el.onclick = () => { lgtcPage = Number(el.dataset.lgtcPage); updateRows(); });
  const planMode = $('#lgtc-plan-form select[name="planMode"]');
  if ($('#lgtc-test-20-cars')) $('#lgtc-test-20-cars').onclick = event => run(async () => {
    const button = event.currentTarget, fields = new FormData(button.form);
    const id = batch.id, serviceDate = lgtcDate;
    button.disabled = true;
    try {
      const { plan } = await api('/api/lgtc/plan', { id, serviceDate, buffer:Number(fields.get('buffer')),
        profiles:lgtcProfiles(fields), notesReviewed:fields.has('notesReviewed'),
        fleet:{ standard4:14, standard7:4, accessible7:2 } });
      if (tab !== 'imports' || batch?.id !== id || lgtcDate !== serviceDate) return;
      lgtcDraft = plan;
      lgtcFleetPreview = true;
      $('#lgtc-plan-results').innerHTML = lgtcResults();
      bindLgtc();
      $('#lgtc-plan-results').scrollIntoView({block:'start'});
    } finally { button.disabled = false; }
  });
  if ($('#lgtc-use-draft-defaults')) $('#lgtc-use-draft-defaults').onclick = () => {
    const { driverIds, buffer, profiles } = batch.drafts[lgtcDate].settings;
    const id = batch.id;
    modal('<h2>Turn on automatic planning</h2><p>New uploads will use these drivers, time buffer, and service code rules when you save the schedule. Confirm the drivers and service codes before reusing these settings.</p>' +
      '<button type="button" class="btn primary" id="lgtc-confirm-auto-defaults">Enable for future uploads</button>');
    $('#lgtc-confirm-auto-defaults').onclick = event => run(async () => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const result = await api('/api/lgtc/settings', { enabled:true, driverIds, buffer, profiles });
        if (tab !== 'imports' || batch?.id !== id) return;
        batch.automation = { enabled:result.settings.enabled, driverCount:result.settings.driverIds.length, codes:Object.keys(result.settings.profiles) };
        $('#modal').close();
        render();
        toast('Automatic planning is enabled for future uploads.');
      } finally { button.disabled = false; }
    });
  };
  if ($('#lgtc-run-picker')) $('#lgtc-run-picker').onchange = event => {
    lgtcSelectedRun = event.target.value;
    $('#lgtc-plan-results').innerHTML = lgtcResults();
    bindLgtc();
    $('#lgtc-run-picker')?.focus({preventScroll:true});
  };
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
          lgtcDraft = response.plan; lgtcFleetPreview = false; render(); $('#lgtc-plan-results').scrollIntoView({block:'nearest'});
        }
      }
    } finally { submit.disabled = false; }
  }); };
}
