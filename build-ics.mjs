#!/usr/bin/env node
// Merge several public Google "sports" calendars into one .ics feed.
//
// Output is deterministic: it changes only when the upstream schedules change,
// never merely because we re-ran it. That keeps the committed docs/sports.ics
// from churning a commit on every scheduled build.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = join(ROOT, 'docs', 'sports.ics');

const CAL_NAME = 'Sports';
const REFRESH = 'PT6H'; // hint to clients; Outlook largely ignores it

const feedUrl = (id) =>
  `https://calendar.google.com/calendar/ical/${encodeURIComponent(id)}/public/basic.ics`;

// RFC 5545 line folding: continuation lines begin with a space or tab.
const unfold = (text) => text.replace(/\r?\n[ \t]/g, '');

// Fold to 75 *octets* per line, never splitting a multi-byte character.
function fold(line) {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const out = [];
  let start = 0;
  let limit = 75; // first line gets 75; continuations lose one octet to the leading space
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // don't split inside a UTF-8 sequence: back off over continuation bytes (10xxxxxx)
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    out.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74;
  }
  return out.join('\r\n ');
}

const getProp = (block, name) => {
  const m = block.match(new RegExp(`^${name}(?:;[^:\n]*)?:(.*)$`, 'm'));
  return m ? m[1].trim() : '';
};

// DTSTART may be a UTC timestamp or a VALUE=DATE all-day value (TBD kickoff).
const getDtStart = (block) => {
  const m = block.match(/^DTSTART(?:;[^:\n]*)?:(.*)$/m);
  return m ? m[1].trim() : '';
};

async function fetchCalendar({ tag, name, id }) {
  const res = await fetch(feedUrl(id), {
    headers: { 'User-Agent': 'sports-calendar-merge/1.0' },
  });
  if (!res.ok) throw new Error(`${name}: HTTP ${res.status} ${res.statusText}`);
  const text = unfold(await res.text());
  const blocks = text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/g) ?? [];
  if (blocks.length === 0) throw new Error(`${name}: feed parsed but contained no events`);
  return blocks.map((block) => ({ tag, source: name, block }));
}

function transform({ tag, block }) {
  const lines = block.split(/\r?\n/).filter((l) => l !== '');
  const uid = getProp(block, 'UID');
  const lastMod = getProp(block, 'LAST-MODIFIED') || getProp(block, 'CREATED');

  const out = [];
  for (const line of lines) {
    if (/^SUMMARY(?:;|:)/.test(line)) {
      // Prefix the tag, leaving any property parameters intact.
      out.push(line.replace(/^(SUMMARY(?:;[^:]*)?:)\s*/, `$1[${tag}] `));
    } else if (/^DTSTAMP(?:;|:)/.test(line)) {
      // Pin to LAST-MODIFIED so re-running produces a byte-identical file.
      out.push(`DTSTAMP:${lastMod || getProp(block, 'DTSTAMP')}`);
    } else if (/^(TRANSP|X-MICROSOFT-CDO-BUSYSTATUS|X-MICROSOFT-CDO-INTENDEDSTATUS)(?:;|:)/.test(line)) {
      // Dropped here and re-added below, so we set them rather than trust upstream.
    } else if (line !== 'END:VEVENT') {
      out.push(line);
    }
  }

  // This is an informational calendar -- nothing on it should ever make Matt
  // look booked. TRANSP is the standard free/busy property; the X-MICROSOFT-CDO-*
  // pair is what Outlook and Exchange actually read. Forcing all three means a
  // stray OPAQUE event upstream can't quietly turn into a Busy block.
  out.push('TRANSP:TRANSPARENT');
  out.push('X-MICROSOFT-CDO-BUSYSTATUS:FREE');
  out.push('X-MICROSOFT-CDO-INTENDEDSTATUS:FREE');
  out.push('END:VEVENT');

  return { uid, dtstart: getDtStart(block), lines: out };
}

async function main() {
  const calendars = JSON.parse(await readFile(join(ROOT, 'calendars.json'), 'utf8'));

  // Fail the build if ANY feed is down, rather than silently publishing a
  // calendar that's quietly missing a team.
  const results = await Promise.all(calendars.map(fetchCalendar));

  const seen = new Set();
  const events = [];
  for (const raw of results.flat()) {
    const ev = transform(raw);
    if (ev.uid && seen.has(ev.uid)) continue; // safety net; not expected across these feeds
    if (ev.uid) seen.add(ev.uid);
    events.push(ev);
  }

  // All-day values ("20261003") sort before same-day timed values ("20261003T193000Z")
  // under a plain string compare, which is the ordering we want.
  events.sort((a, b) => a.dtstart.localeCompare(b.dtstart) || a.uid.localeCompare(b.uid));

  const body = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//mwalch//sports-calendar-merge//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${CAL_NAME}`,
    'X-WR-TIMEZONE:UTC',
    `X-WR-CALDESC:Merged schedules: ${calendars.map((c) => c.tag).join(', ')}`,
    `REFRESH-INTERVAL;VALUE=DURATION:${REFRESH}`,
    `X-PUBLISHED-TTL:${REFRESH}`,
    ...events.flatMap((e) => e.lines),
    'END:VCALENDAR',
  ];

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, body.map(fold).join('\r\n') + '\r\n', 'utf8');

  // Heartbeat: GitHub disables scheduled workflows after 60 days of repo
  // inactivity. sports.ics only changes when a schedule changes, which can be
  // never during the offseason -- so stamp a month here to guarantee at least
  // one commit a month without churning a commit on every 6-hourly run.
  const month = new Date().toISOString().slice(0, 7);
  await writeFile(join(ROOT, 'docs', 'last-build.txt'), `${month}\n`, 'utf8');

  for (const c of calendars) {
    const n = events.filter((e) => e.lines.some((l) => l.includes(`[${c.tag}] `))).length;
    console.log(`  ${String(n).padStart(3)} events  ${c.tag} (${c.name})`);
  }
  console.log(`\nWrote ${events.length} events to ${OUT}`);
}

main().catch((err) => {
  console.error(`build failed: ${err.message}`);
  process.exit(1);
});
