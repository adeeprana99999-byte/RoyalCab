const http = require('node:http');

const replayScript = String.raw`
<style>
.ride-progress{padding:8px;background:white;border-bottom:1px solid #d3dee8}
.ride-progress h3{font-size:14px;margin:0 0 5px}
.ride-progress ol{list-style:none;margin:0;padding:0;display:grid;gap:3px}
.ride-progress li{font-size:12px;padding:3px 6px;border-radius:4px;background:#edf3f8}
.ride-progress li[data-state=active]{background:#dbeafe;color:#193e80}
.ride-progress li[data-state=completed]{background:#dcfce7;color:#14532d}
.ride-progress li[data-state=next]{background:#fef3c7;color:#78350f}
</style>
<script>
const owner = document.querySelector('iframe[title="owner"]');
const summary = document.createElement('section');
summary.className = 'ride-progress';
summary.setAttribute('aria-label', 'LGTC ride progress');
summary.setAttribute('aria-live', 'polite');
summary.textContent = 'Loading ride progress…';
owner.before(summary);
const pickupTime = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit'
});
const activeStages = {
  accepted: 'Driver confirmed', heading_to_pickup: 'Heading to pickup',
  arrived: 'At pickup', onboard: 'Passenger onboard'
};
function showProgress(trips) {
  const rides = trips.filter(ride => /900-80[1-3]-A$/.test(ride.reference))
    .sort((a, b) => a.pickupAt - b.pickupAt);
  const next = rides.find(ride => ['offered', 'awaiting_driver', 'needs_reassignment'].includes(ride.status));
  const rows = rides.map(ride => {
    const label = activeStages[ride.status]
      ? ['active', 'Active · ' + activeStages[ride.status]]
      : ride.status === 'completed' ? ['completed', 'Completed']
      : ride.status === 'cancelled' ? ['scheduled', 'Cancelled']
      : ride === next ? ['next', ride.status === 'offered' ? 'Next · Offer pending' : 'Next pickup']
      : ['scheduled', 'Scheduled'];
    const row = document.createElement('li');
    row.dataset.state = label[0];
    row.textContent = pickupTime.format(ride.pickupAt) + ' ET · ' + ride.reference.match(/900-80[1-3]-A$/)[0] + ' · ' + label[1];
    return row;
  });
  const heading = document.createElement('h3');
  heading.textContent = 'Ride progress · ' + rides.filter(ride => ride.status === 'completed').length + ' of 3 completed';
  const list = document.createElement('ol');
  list.append(...rows);
  if (summary.textContent !== heading.textContent + list.textContent) summary.replaceChildren(heading, list);
}
let ownerEvents;
owner.addEventListener('load', () => {
  ownerEvents?.close();
  ownerEvents = new owner.contentWindow.EventSource('/api/events');
  ownerEvents.addEventListener('state', event => showProgress(JSON.parse(event.data).state.trips));
});
const driver = document.querySelector('iframe[title="driver"]');
const customer = document.querySelector('iframe[title="customer"]');
const advance = document.querySelector('#advance');
const reset = document.querySelector('#reset');
advance.hidden = true;
let completed = 0;
let advancing = false;
let awaitingOffer = false;
let completionSeen = false;

function updateReplay() {
  const driverPage = driver.contentDocument;
  const customerPage = customer.contentDocument;
  const driverStatus = Array.from(driverPage.querySelectorAll('[role="status"]'));
  const done = driverStatus.some(status => status.textContent.includes('Ride completed. Dispatch has been updated.'));
  if (!done) completionSeen = false;
  if (done && !completionSeen && !advancing && !reset.disabled) {
    completionSeen = true;
    completed += 1;
    if (completed < 3) {
      advancing = true;
      awaitingOffer = true;
      advance.click();
      advancing = false;
    } else {
      document.querySelector('#status').textContent = 'All three rides completed.';
    }
  }

  const offerVisible = Array.from(driverPage.querySelectorAll('button'))
    .some(button => button.textContent.trim() === 'Accept trip');
  const upcoming = customerPage.querySelector('#next-customer-ride');
  if (awaitingOffer && offerVisible && upcoming) {
    awaitingOffer = false;
    upcoming.click();
  }
}
reset.addEventListener('click', () => {
  completed = 0;
  awaitingOffer = false;
});
for (const panel of [driver, customer]) {
  panel.addEventListener('load', () => {
    new MutationObserver(updateReplay).observe(panel.contentDocument.body, {
      childList: true, subtree: true, characterData: true
    });
    updateReplay();
  });
}
</script>`;

http.createServer((req, res) => {
  const headers = { ...req.headers, host: 'localhost:4745' };
  if (headers.origin === 'http://localhost:4748') headers.origin = 'http://localhost:4745';
  delete headers['accept-encoding'];
  const upstream = http.request({
    hostname: 'localhost', port: 4745, path: req.url, method: req.method, headers
  }, response => {
    if (req.url !== '/' || req.method !== 'GET' || response.statusCode !== 200) {
      res.writeHead(response.statusCode, response.headers);
      response.pipe(res);
      return;
    }
    response.setEncoding('utf8');
    let html = '';
    response.on('data', chunk => { html += chunk; });
    response.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html + replayScript);
    });
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502);
    res.end('The local LGTC demo on port 4745 is unavailable.');
  });
  res.on('close', () => upstream.destroy());
  req.pipe(upstream);
}).listen(4748, 'localhost', () => console.log('Auto-advancing LGTC demo ready on http://localhost:4748/'));


