#!/usr/bin/env python3
"""Writes tests/fixtures/rrule-oracle.json: recurrence rules and the occurrences python-dateutil
expands them to, so the app's own expansion (src/js/rrule.js) is checked against an independent
implementation. Run it again only to add cases; the gate reads the JSON and needs no Python.

    python3 -m venv .venv && .venv/bin/pip install python-dateutil
    .venv/bin/python tools/make_rrule_fixtures.py

RFC 5545 counts DTSTART as the first occurrence even when the rule would not produce it; dateutil
does not. Where they differ the expected list is written the RFC way: DTSTART first, then dateutil's
occurrences, with COUNT including DTSTART.
"""

from __future__ import annotations

import itertools
import json
import random
from datetime import datetime
from pathlib import Path

from dateutil.rrule import rrulestr

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "tests" / "fixtures" / "rrule-oracle.json"
FMT = "%Y%m%dT%H%M%S"
TAKE = 30

# RFC 5545 3.8.5.3, with UNTIL written as floating local time (the expansion here is in wall time).
RFC_EXAMPLES = [
    ("daily, 10 times", "19970902T090000", "FREQ=DAILY;COUNT=10"),
    ("daily until 24 Dec 1997", "19970902T090000", "FREQ=DAILY;UNTIL=19971224T000000"),
    ("every other day", "19970902T090000", "FREQ=DAILY;INTERVAL=2"),
    ("every 10 days, 5 times", "19970902T090000", "FREQ=DAILY;INTERVAL=10;COUNT=5"),
    ("every day in January for 3 years (yearly)", "19980101T090000",
     "FREQ=YEARLY;UNTIL=20000131T140000;BYMONTH=1;BYDAY=SU,MO,TU,WE,TH,FR,SA"),
    ("every day in January for 3 years (daily)", "19980101T090000", "FREQ=DAILY;UNTIL=20000131T140000;BYMONTH=1"),
    ("weekly, 10 times", "19970902T090000", "FREQ=WEEKLY;COUNT=10"),
    ("weekly until 24 Dec 1997", "19970902T090000", "FREQ=WEEKLY;UNTIL=19971224T000000"),
    ("every other week", "19970902T090000", "FREQ=WEEKLY;INTERVAL=2;WKST=SU"),
    ("Tuesday and Thursday for five weeks (until)", "19970902T090000", "FREQ=WEEKLY;UNTIL=19971007T000000;WKST=SU;BYDAY=TU,TH"),
    ("Tuesday and Thursday for five weeks (count)", "19970902T090000", "FREQ=WEEKLY;COUNT=10;WKST=SU;BYDAY=TU,TH"),
    ("every other week on Mon, Wed, Fri", "19970901T090000",
     "FREQ=WEEKLY;INTERVAL=2;UNTIL=19971224T000000;WKST=SU;BYDAY=MO,WE,FR"),
    ("every other week on Tue and Thu, 8 times", "19970902T090000", "FREQ=WEEKLY;INTERVAL=2;COUNT=8;WKST=SU;BYDAY=TU,TH"),
    ("monthly on the first Friday, 10 times", "19970905T090000", "FREQ=MONTHLY;COUNT=10;BYDAY=1FR"),
    ("monthly on the first Friday until 24 Dec 1997", "19970905T090000", "FREQ=MONTHLY;UNTIL=19971224T000000;BYDAY=1FR"),
    ("every other month, first and last Sunday", "19970907T090000", "FREQ=MONTHLY;INTERVAL=2;COUNT=10;BYDAY=1SU,-1SU"),
    ("second-to-last Monday, 6 months", "19970922T090000", "FREQ=MONTHLY;COUNT=6;BYDAY=-2MO"),
    ("third-to-last day of the month", "19970928T090000", "FREQ=MONTHLY;BYMONTHDAY=-3"),
    ("2nd and 15th, 10 times", "19970902T090000", "FREQ=MONTHLY;COUNT=10;BYMONTHDAY=2,15"),
    ("first and last day, 10 times", "19970930T090000", "FREQ=MONTHLY;COUNT=10;BYMONTHDAY=1,-1"),
    ("every 18 months, 10th to 15th", "19970910T090000", "FREQ=MONTHLY;INTERVAL=18;COUNT=10;BYMONTHDAY=10,11,12,13,14,15"),
    ("every Tuesday, every other month", "19970902T090000", "FREQ=MONTHLY;INTERVAL=2;BYDAY=TU"),
    ("June and July, 10 times", "19970610T090000", "FREQ=YEARLY;COUNT=10;BYMONTH=6,7"),
    ("every other year, Jan to Mar", "19970310T090000", "FREQ=YEARLY;INTERVAL=2;COUNT=10;BYMONTH=1,2,3"),
    ("every third year, days 1, 100, 200", "19970101T090000", "FREQ=YEARLY;INTERVAL=3;COUNT=10;BYYEARDAY=1,100,200"),
    ("every 20th Monday of the year", "19970519T090000", "FREQ=YEARLY;BYDAY=20MO"),
    ("Monday of week 20", "19970512T090000", "FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO"),
    ("every Thursday in March", "19970313T090000", "FREQ=YEARLY;BYMONTH=3;BYDAY=TH"),
    ("every Thursday in June, July, August", "19970605T090000", "FREQ=YEARLY;BYDAY=TH;BYMONTH=6,7,8"),
    ("every Friday the 13th", "19970902T090000", "FREQ=MONTHLY;BYDAY=FR;BYMONTHDAY=13"),
    ("first Saturday after the first Sunday", "19970913T090000", "FREQ=MONTHLY;BYDAY=SA;BYMONTHDAY=7,8,9,10,11,12,13"),
    ("US election day", "19961105T090000", "FREQ=YEARLY;INTERVAL=4;BYMONTH=11;BYDAY=TU;BYMONTHDAY=2,3,4,5,6,7,8"),
    ("third Tue, Wed or Thu, 3 months", "19970904T090000", "FREQ=MONTHLY;COUNT=3;BYDAY=TU,WE,TH;BYSETPOS=3"),
    ("second-to-last weekday", "19970929T090000", "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-2"),
    ("every 3 hours, 9 to 5", "19970902T090000", "FREQ=HOURLY;INTERVAL=3;UNTIL=19970902T170000"),
    ("every 15 minutes, 6 times", "19970902T090000", "FREQ=MINUTELY;INTERVAL=15;COUNT=6"),
    ("every 90 minutes, 4 times", "19970902T090000", "FREQ=MINUTELY;INTERVAL=90;COUNT=4"),
    ("every 20 minutes 9:00-16:40 (daily)", "19970902T090000", "FREQ=DAILY;BYHOUR=9,10,11,12,13,14,15,16;BYMINUTE=0,20,40"),
    ("every 20 minutes 9:00-16:40 (minutely)", "19970902T090000", "FREQ=MINUTELY;INTERVAL=20;BYHOUR=9,10,11,12,13,14,15,16"),
    ("WKST=MO makes a difference", "19970805T090000", "FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=MO"),
    ("WKST=SU makes a difference", "19970805T090000", "FREQ=WEEKLY;INTERVAL=2;COUNT=4;BYDAY=TU,SU;WKST=SU"),
    ("February 30 is skipped", "20070115T090000", "FREQ=MONTHLY;BYMONTHDAY=15,30;COUNT=5"),
]

CALENDAR_CASES = [
    ("birthday on 29 February", "20240229T000000", "FREQ=YEARLY"),
    ("monthly on the 31st", "20260131T100000", "FREQ=MONTHLY;COUNT=12"),
    ("last Friday of the month", "20261030T170000", "FREQ=MONTHLY;BYDAY=-1FR;COUNT=14"),
    ("weekdays at 08:30", "20261005T083000", "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=25"),
    ("every two weeks on Thursday until spring", "20261008T190000", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TH;UNTIL=20270401T000000"),
    ("yearly on the second Sunday of May", "20260510T120000", "FREQ=YEARLY;BYMONTH=5;BYDAY=2SU;COUNT=8"),
    ("quarterly on the first workday", "20260101T090000", "FREQ=MONTHLY;INTERVAL=3;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=1;COUNT=10"),
    ("last day of the year", "20261231T235900", "FREQ=YEARLY;BYYEARDAY=-1;COUNT=5"),
]

WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"]


def random_rule(rng: random.Random) -> tuple[str, str]:
    year = rng.randint(2019, 2031)
    month = rng.randint(1, 12)
    day = rng.randint(1, 28)
    hour = rng.choice([0, 7, 9, 13, 18, 23])
    minute = rng.choice([0, 15, 30, 45])
    dtstart = datetime(year, month, day, hour, minute)
    freq = rng.choice(["DAILY", "WEEKLY", "MONTHLY", "YEARLY"])
    parts = [f"FREQ={freq}"]
    if rng.random() < 0.4:
        parts.append(f"INTERVAL={rng.randint(2, 4)}")
    if freq in ("MONTHLY", "YEARLY") and rng.random() < 0.45:
        days = rng.sample(WEEKDAYS, rng.randint(1, 3))
        nth = rng.choice([None, 1, 2, -1, 3])
        parts.append("BYDAY=" + ",".join(f"{nth}{d}" if nth else d for d in days))
    elif freq == "WEEKLY" and rng.random() < 0.7:
        parts.append("BYDAY=" + ",".join(rng.sample(WEEKDAYS, rng.randint(1, 4))))
    elif freq == "DAILY" and rng.random() < 0.3:
        parts.append("BYDAY=" + ",".join(rng.sample(WEEKDAYS, rng.randint(2, 5))))
    if freq in ("MONTHLY", "YEARLY") and rng.random() < 0.3:
        parts.append("BYMONTHDAY=" + ",".join(str(v) for v in rng.sample([1, 5, 10, 15, 20, 28, 30, 31, -1, -2], rng.randint(1, 3))))
    if freq == "YEARLY" and rng.random() < 0.5:
        parts.append("BYMONTH=" + ",".join(str(v) for v in sorted(rng.sample(range(1, 13), rng.randint(1, 3)))))
    if freq in ("MONTHLY", "YEARLY") and any(p.startswith("BYDAY") for p in parts) and rng.random() < 0.3:
        parts.append(f"BYSETPOS={rng.choice([1, -1, 2])}")
    if rng.random() < 0.15:
        parts.append("BYHOUR=" + ",".join(str(v) for v in sorted(rng.sample(range(0, 24), 2))))
    if rng.random() < 0.3:
        parts.append(f"WKST={rng.choice(WEEKDAYS)}")
    end = rng.random()
    if end < 0.4:
        parts.append(f"COUNT={rng.randint(1, 25)}")
    elif end < 0.7:
        until = datetime(year + rng.randint(0, 3), rng.randint(1, 12), rng.randint(1, 28), rng.choice([0, 12, 23]), 59)
        parts.append("UNTIL=" + until.strftime(FMT))
    return dtstart.strftime(FMT), ";".join(parts)


def expand(dtstart: str, rule: str) -> list[str]:
    start = datetime.strptime(dtstart, FMT)
    rr = rrulestr(rule, dtstart=start)
    produced = [d for d in itertools.islice(rr, TAKE + 1)]
    count = None
    for part in rule.split(";"):
        if part.startswith("COUNT="):
            count = int(part[6:])
    if not produced or produced[0] != start:
        # RFC 5545: DTSTART is the first occurrence and counts toward COUNT.
        produced = [start] + produced
        if count is not None:
            produced = produced[:count]
    return [d.strftime(FMT) for d in produced[:TAKE]]


def main() -> None:
    cases = []
    for name, dtstart, rule in RFC_EXAMPLES:
        cases.append({"name": f"RFC 5545: {name}", "dtstart": dtstart, "rrule": rule, "expected": expand(dtstart, rule)})
    for name, dtstart, rule in CALENDAR_CASES:
        cases.append({"name": name, "dtstart": dtstart, "rrule": rule, "expected": expand(dtstart, rule)})
    rng = random.Random(20261008)
    seen = set()
    while len([c for c in cases if c["name"].startswith("random")]) < 400:
        dtstart, rule = random_rule(rng)
        if (dtstart, rule) in seen:
            continue
        seen.add((dtstart, rule))
        try:
            expected = expand(dtstart, rule)
        except Exception:  # dateutil refuses a few combinations; they are not cases then
            continue
        cases.append({"name": f"random {len(seen)}", "dtstart": dtstart, "rrule": rule, "expected": expected})
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"take": TAKE, "cases": cases}, indent=1) + "\n", encoding="utf-8")
    print(f"wrote {len(cases)} cases to {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
