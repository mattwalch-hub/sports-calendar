# Sports calendar

Merges several public Google sports calendars into a single `.ics` feed that
Outlook can subscribe to.

A GitHub Action rebuilds the feed every 6 hours and commits the result only when
a schedule actually changed. GitHub Pages serves it from `docs/`.

## Adding or removing a team

Edit `calendars.json` and push. Each entry needs a short `tag` (prefixed onto
every event title, e.g. `[MSU FB]`), a human-readable `name`, and the Google
calendar `id`.

## Running locally

    node build-ics.mjs

No dependencies; Node 18+ only. Writes `docs/sports.ics`.

## Notes

- `DTSTAMP` is pinned to each event's `LAST-MODIFIED` so re-running produces a
  byte-identical file. Without that the feed would differ on every run and the
  Action would commit every 6 hours forever.
- `docs/last-build.txt` holds the current year-month. It guarantees one commit a
  month, which keeps GitHub from auto-disabling the schedule after 60 days of
  repository inactivity.
- Every event is forced to Free: `TRANSP:TRANSPARENT` plus `X-MICROSOFT-CDO-BUSYSTATUS`
  and `X-MICROSOFT-CDO-INTENDEDSTATUS` set to `FREE`. This is an informational
  calendar, so nothing on it should ever make you look booked. The values are
  set by the build rather than taken from Google, so an upstream `OPAQUE` event
  cannot turn into a Busy block.
- The build fails loudly if any upstream feed is down, rather than quietly
  publishing a calendar with a team missing.
