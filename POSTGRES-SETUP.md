# RoyalCab PostgreSQL setup

This schema prepares bookings, drivers, vehicles, offers and audit events for the first migration. The Wi-Fi demo continues to use SQLite on port 4781.

## Create the local database

With PostgreSQL and its command-line tools installed, run these commands in the RoyalCab folder. Replace postgres with your local database administrator account if needed.

```powershell
createdb -h localhost -U postgres royalcab
psql -h localhost -U postgres -d royalcab -v ON_ERROR_STOP=1 -f postgres-dispatch.sql
psql -h localhost -U postgres -d royalcab -c "\dt"
```

Keep connection credentials outside source control. Use a dedicated database account before wiring up the app.

## Connect and verify dispatch

Wire booking, offer creation and acceptance through a PostgreSQL adapter before moving any existing records. Acceptance must lock the trip row, then recheck the offer, driver, vehicle and assignment eligibility inside the same transaction. Lock the relevant fleet rows in a consistent order to serialize acceptance across rides. Confirm the winner, close competing offers and write the audit event before committing. Releasing an assignment must close its accepted offer in the same transaction before a new driver can accept.

Use dummy rides to verify simultaneous acceptance, duplicate requests, driver release and reassignment, and persistence after a restart. Current ride, fleet, schedule and customer data remain in SQLite until a migration is implemented and verified.
