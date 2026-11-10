# RoyalCab

RoyalCab contains ProLift, a local ride-dispatch app with owner, driver, and customer workspaces.

## Run the demo

Install Node.js 24 or newer. Open a terminal in this repository and run:

```powershell
node start-demo.cjs
```

Open [ProLift on localhost](http://localhost:4720/) and select **Open owner dashboard**. If port 4720 is already in use, set `$env:PORT = '4725'` before starting and open port 4725 instead.

The demo rebuilds its synthetic bookings in memory on each start. It creates fresh import examples for the next day under `demo-generated/`. The `examples/` directory contains fixed-date copies for reference.

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
