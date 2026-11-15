# Private Owner records on Render

Use a separate Render Web Service for the Owner records workspace. Connect it to the RoyalCab repository and the `private-owner-render` branch.

- Root Directory: `mongo-test`
- Build Command: `npm ci`
- Start Command: `node render-owner.cjs`
- Health Check Path: `/healthz`

Set `ROYALCAB_MONGO_URI`, `ROYALCAB_OWNER_USERNAME`, and `ROYALCAB_OWNER_PASSWORD` in the service environment. Use a unique password of at least 16 characters and a separate MongoDB credential with read-only access to `royalcab_dispatch_test`. If using Atlas, configure network access for the Render service's outbound addresses.

Open the new HTTPS service at `/owner/records`. A signed-out browser should get a sign-in challenge before the page loads. After signing in, check the Vehicles, Drivers, and LGTC rides tabs. The health endpoint returns only a process status.
