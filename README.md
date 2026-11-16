# Everyday Notification Service (Pilot)

Dedicated Everyday push-notification service, independent of HeartOS, SpiritOS and JobOS.

- API: Render free web service (may sleep). HTTPS only.
- Jobs: PostgreSQL (isolated Neon Everyday database).
- Dispatcher: GitHub Actions scheduled runner every 5 minutes. GitHub may delay or skip a run, so **this is NOT an SLA-grade notification system**.
- Payloads are generic: event titles, receipts, names and PHI are not transmitted to the API.
- Authentication: high-entropy per-device bearer token; HTTPS, constrained origin and subscription host.
- Reminder updates replace future jobs; completing an item cancels pending jobs. No Google Calendar dependency.
- iOS requires installing Everyday on the Home Screen before enabling web push.
- Production requires user accounts / device authentication, encrypted device subscriptions at rest, durable always-on dispatch, monitoring, cross-device sync, privacy controls, and consent flows before real public launch.

API URLs: GET /health, GET /api/key, POST /api/device, POST /api/jobs, POST /api/test, DELETE /api/device. No PII in push message body.

Do not put DATABASE_URL, VAPID_PRIVATE_KEY or tokens into this repository.
