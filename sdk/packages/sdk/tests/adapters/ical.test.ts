import { describe, expect, it } from "vitest";
import { ICalAdapter, normalizeICalEvents, parseICal, parseICalDate } from "../../src/adapters/ical.js";
import { Transport } from "../../src/core/transport.js";
import { mockFetch, textResponse } from "../helpers.js";

const ICS_SAMPLE = `BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:holiday-1@example.com
DTSTART;VALUE=DATE:20261225
DTEND;VALUE=DATE:20261226
SUMMARY:Christmas Day
END:VEVENT
BEGIN:VEVENT
UID:match-1@example.com
DTSTART:20260922T190000Z
DTEND:20260922T210000Z
SUMMARY:Team A vs Team B\\, semifinal
LOCATION:Stadium
END:VEVENT
END:VCALENDAR`;

describe("parseICalDate", () => {
  it("parses UTC, floating, and all-day dates", () => {
    expect(parseICalDate("20260922T190000Z")).toBe("2026-09-22T19:00:00.000Z");
    expect(parseICalDate("20260922T190000")).toBe("2026-09-22T19:00:00.000Z");
    expect(parseICalDate("20261225")).toBe("2026-12-25T00:00:00.000Z");
    expect(parseICalDate("garbage")).toBeUndefined();
  });
});

describe("parseICal", () => {
  it("extracts VEVENTs with unescaped text", () => {
    const events = parseICal(ICS_SAMPLE);
    expect(events).toHaveLength(2);
    expect(events[0].uid).toBe("holiday-1@example.com");
    expect(events[0].summary).toBe("Christmas Day");
    expect(events[1].summary).toBe("Team A vs Team B, semifinal");
    expect(events[1].location).toBe("Stadium");
  });

  it("handles folded lines", () => {
    const folded = "BEGIN:VEVENT\r\nUID:x\r\nSUMMARY:Long ti\r\n tle here\r\nDTSTART:20260922T190000Z\r\nEND:VEVENT";
    expect(parseICal(folded)[0].summary).toBe("Long title here");
  });
});

describe("normalizeICalEvents", () => {
  it("normalizes to CalendarEvent with provenance", () => {
    const events = normalizeICalEvents(parseICal(ICS_SAMPLE), "holidays", "2026-09-22T00:00:00.000Z");
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      id: "holiday-1@example.com",
      title: "Christmas Day",
      startsAt: "2026-12-25T00:00:00.000Z",
      source: "holidays",
      freshness: "LIVE",
    });
    expect(events[1].endsAt).toBe("2026-09-22T21:00:00.000Z");
  });

  it("drops events without a parseable start", () => {
    expect(normalizeICalEvents([{ uid: "x", summary: "no date" }], "s", "2026-09-22T00:00:00.000Z")).toHaveLength(0);
  });
});

describe("ICalAdapter", () => {
  it("fetchEvents fetches ICS text and normalizes", async () => {
    const fetch = mockFetch([{ match: (u) => u.includes("/holidays.ics"), respond: () => textResponse(ICS_SAMPLE) }]);
    const adapter = new ICalAdapter({
      transport: new Transport({ baseUrl: "https://example.com", source: "holidays", fetch }),
      source: "holidays",
    });
    const events = await adapter.fetchEvents("/holidays.ics");
    expect(events).toHaveLength(2);
    expect(events[0].source).toBe("holidays");
  });

  it("poller emits normalized CalendarEvents", async () => {
    const fetch = mockFetch([{ match: (u) => u.includes("/holidays.ics"), respond: () => textResponse(ICS_SAMPLE) }]);
    const adapter = new ICalAdapter({
      transport: new Transport({ baseUrl: "https://example.com", source: "holidays", fetch }),
      source: "holidays",
    });
    const poller = adapter.poller("/holidays.ics", 60_000);
    const seen: string[] = [];
    poller.on("items", (items) => seen.push(...items.map((i) => i.title)));
    await poller.pollOnce();
    expect(seen).toEqual(["Christmas Day", "Team A vs Team B, semifinal"]);
    poller.stop();
  });
});
