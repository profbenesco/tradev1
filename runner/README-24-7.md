# 24/7 browser runner deployment

This runner opens the hosted Deriv Bot frontend in a separate headless Chromium
browser. It is independent of the browser on your phone/computer, but it is
**not a guarantee of uninterrupted trading**. Deriv sessions can expire, the
site can change, and the hosting provider can restart the service.

## Important Render Free limitation

A Render Free web service sleeps after 15 minutes without inbound traffic,
can restart at any time, and loses local filesystem changes when it sleeps or
restarts. Free services cannot attach persistent disks. Therefore a Free Render
service cannot provide a dependable 24/7 browser runner. Do not use a free
service for unattended live-money trading.

For continuous operation, use a paid always-on Render web service. Attach a
persistent disk mounted at `/var/data` and set `DATA_DIR=/var/data` so the last
strategy payload survives restarts. A restart can still interrupt an active
trade; this is not a high-availability trading system.

## Render configuration

Deploy the `runner/` directory as a Docker web service:

- Root Directory: `runner`
- Environment: Docker
- Dockerfile Path: `./Dockerfile`
- Health Check Path: `/health`

Set these environment variables:

| Variable | Value |
|---|---|
| `RUNNER_SECRET` | A long, random secret. Keep it private. |
| `ALLOWED_ORIGIN` | `https://tradev1.pages.dev` |
| `TARGET_URL` | `https://tradev1.pages.dev` |
| `DATA_DIR` | `/var/data` (when a persistent disk is mounted there) |
| `AUTO_RESUME` | `true` |
| `AUTO_RESTART_ON_STOP` | `false` |

Do not set `AUTO_RESTART_ON_STOP=true` unless you intentionally want a strategy
that has completed or stopped to be started again. Repeating a strategy can
place additional trades.

## Export the Deriv browser login

The frontend's Run 24/7 button sends the current page's localStorage,
sessionStorage and Blockly strategy XML. The runner can also restore cookies
and localStorage from a Playwright storageState export, which is useful when
the login depends on cookies.

On a trusted computer with Node.js installed:

```bash
cd runner
npm install
npx playwright install chromium
node export-session.js
```

A browser opens at `https://tradev1.pages.dev`. Sign in to Deriv, wait until
the bot page is fully logged in, then return to the terminal and press Enter.
The script creates `session.b64.txt` and `session.json`.

Copy the complete contents of `session.b64.txt` into a Render environment
variable named `SESSION_B64`, then redeploy the runner. Never put this value
in GitHub, frontend code, a public issue, or a chat. It is an authenticated
session and should be treated like a password. Re-export it if Deriv expires
or revokes the session.

## Use and verify

1. Open `https://tradev1.pages.dev` and sign in to Deriv.
2. Open Bot Builder and load the intended Blockly strategy.
3. Click **Run 24/7** and enter the same `RUNNER_SECRET` configured on Render.
4. Confirm the request is accepted, then use **Status**. It reports the runner
   state, restart count, and whether `SESSION_B64` is configured.
5. Check Render logs for `[auth-check]`, `[run-btns]`, `[state] running`, and
   any `[start-failed-debug]` or `[pageerror]` messages.

The runner only treats the bot as running after it sees the Deriv Bot Stop
button. That is a UI-level signal, not proof that a trade was accepted or
that the strategy is profitable. Confirm actual account activity in Deriv.

## Security and risk

- Test on a Deriv demo account first.
- Use a dedicated Deriv account/token with only the permissions needed.
- Never share `RUNNER_SECRET`, `SESSION_B64`, session files, or account tokens.
- Use conservative stake, loss, and profit limits in the strategy.
- The runner does not automatically restart a strategy that reaches its normal
  stop condition (`AUTO_RESTART_ON_STOP=false` by default). It will attempt to
  recover from browser/process errors while the Render process remains alive.
- Recheck the session after password changes, logout, security challenges, or
  Deriv authentication changes.
