# RoyalCab

RoyalCab contains ProLift, a local ride-dispatch app with owner, driver, and customer workspaces.

## Run the demo

Install Node.js 24 or newer. Open a terminal in this repository and run:

```powershell
node start-demo.cjs
```

Open [ProLift on localhost](http://localhost:4720/) and select **Open owner dashboard**. If port 4720 is already in use, set `$env:PORT = '4725'` before starting and open port 4725 instead.

The demo rebuilds its synthetic bookings in memory on each start. It creates fresh import examples for the next day under `demo-generated/`. The `examples/` directory contains fixed-date copies for reference.

## Preview on Render

For a public testing site, set `PROLIFT_HOSTED_DEMO=1` and `PROLIFT_PUBLIC_DEMO=1` in Render. Use `node start-demo.cjs` as the start command and `/healthz` as the health check path. The service URL opens the same workspace chooser as localhost with sample owner, driver, and customer accounts. The public demo uses shared synthetic rides, disables file uploads and phone GPS, and resets on restart.

### Private preview

In the existing Render web service, use `node start-demo.cjs` or `yarn start` as the **Start Command** and set the **Health Check Path** to `/healthz`. In **Environment**, set `PROLIFT_HOSTED_DEMO=1` and create `PROLIFT_PREVIEW_PASSWORD` with a new random password of at least 24 characters. Keep `NODE_ENV=production` and let Render supply `PORT`.

Deploy the latest commit and open the Render HTTPS URL. Sign in on the RoyalCab page as `preview` with the password you set in Render. Every viewer with that password can open the demo owner, driver, and customer roles. Use synthetic records only. The demo stores changes in memory and starts fresh whenever Render restarts the service.

For a one-click testing link, generate a separate random token:

```powershell
node -p "require('node:crypto').randomBytes(32).toString('base64url')"
```

Set `PROLIFT_PREVIEW_INVITE_TOKEN` to the generated value in Render and redeploy. Share `https://YOUR-SERVICE.onrender.com/preview#YOUR-INVITE-TOKEN` privately with testers. The link opens the demo without asking for credentials and remembers preview access in that browser for 12 hours. Anyone with the link can use the demo roles. Rotate or remove the token and redeploy to revoke the link and its browser sessions.

On the workspace chooser, open the owner dashboard, select a sample driver, or open the sample customer Alex Morgan. Each demo account is ready to use. The customer tab also has a separate option to test mobile verification. To preselect a role for a signed-out tester, use `/preview?demo=driver#YOUR-INVITE-TOKEN` or replace `driver` with `owner` or `customer`.

## Included test data

| Example | Where to find it |
| --- | --- |
| 500 synthetic rides and 20 vehicles | **Dispatch → Test fleets → 500-trip test** |
| 150 synthetic rides across Now, Later, and Attention | **Dispatch → Test fleets → 150-trip queue test** |
| Charlotte fleet, shared rides, GPS replay, driver offer, and next-ride walkthroughs | **Dispatch → Test fleets** and the demo tools under **Manage** |
| Two next-day LGTC pickups for the same rider | Import `demo-generated/LGTC-next-day.csv`. The preset regular driver is Maya Chen. Save the schedule to see the plan, then review it before approving dispatch. |
| One Excel booking | Import `demo-generated/Planned-rides.xlsx`. |

Use another browser profile or a private window to view the driver and customer workspaces alongside the owner. The customer demo uses an on-screen verification code.

## Validate the app

```powershell
node --test tests.cjs
```

The demo uses simulated data and delivery. The repository ships source, tests, and synthetic fixtures. Local credentials and runtime databases belong outside version control.
