/**
 * iCal adapter (§2.7): fetches `.ics` feeds (holidays, sports fixtures) and
 * normalizes VEVENTs → CalendarEvent.
 *
 * Minimal RFC 5545 parser: handles line folding, VEVENT blocks, and the
 * common DTSTART/DTEND/SUMMARY/UID/LOCATION properties. Date parsing is
 * best-effort (UTC `Z` suffix, floating local time treated as UTC, and plain
 * `YYYYMMDD` all-day dates); exotic TZIDs are passed through as-is.
 */
import { Transport } from "../core/transport.js";
import { PollingAdapter, RestAdapter } from "./rest.js";
import type { CalendarEvent } from "../types/index.js";

export interface ICalAdapterOptions {
  transport: Transport;
  source: string;
}

export interface RawICalEvent {
  uid?: string;
  summary?: string;
  dtstart?: string;
  dtend?: string;
  location?: string;
}

function unfoldLines(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    if ((raw.startsWith(" ") || raw.startsWith("\t")) && out.length > 0) {
      out[out.length - 1] += raw.slice(1);
    } else {
      out.push(raw);
    }
  }
  return out;
}

/** Parse an iCal date value → ISO string (best-effort). */
export function parseICalDate(value: string): string | undefined {
  const v = value.trim();
  // YYYYMMDDTHHMMSSZ
  let m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(v);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
  // YYYYMMDDTHHMMSS (floating — treated as UTC; documented limitation)
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(v);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
  // YYYYMMDD (all-day)
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString();
  return undefined;
}

/** Parse raw ICS text → VEVENT records. Exported for tests. */
export function parseICal(text: string): RawICalEvent[] {
  const events: RawICalEvent[] = [];
  let current: RawICalEvent | undefined;
  for (const line of unfoldLines(text)) {
    if (line === "BEGIN:VEVENT") {
      current = {};
    } else if (line === "END:VEVENT") {
      if (current) events.push(current);
      current = undefined;
    } else if (current) {
      const idx = line.indexOf(":");
      if (idx < 0) continue;
      const name = line.slice(0, idx).split(";")[0];
      const value = line.slice(idx + 1).replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\n/gi, "\n");
      switch (name) {
        case "UID":
          current.uid = value;
          break;
        case "SUMMARY":
          current.summary = value;
          break;
        case "DTSTART":
          current.dtstart = value;
          break;
        case "DTEND":
          current.dtend = value;
          break;
        case "LOCATION":
          current.location = value;
          break;
      }
    }
  }
  return events;
}

/** Normalize parsed VEVENTs → CalendarEvent (drops events without a start). */
export function normalizeICalEvents(raw: RawICalEvent[], source: string, fetchedAt: string): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const r of raw) {
    const startsAt = r.dtstart ? parseICalDate(r.dtstart) : undefined;
    if (!startsAt) continue;
    out.push({
      id: r.uid ?? `${r.summary ?? "event"}@${r.dtstart}`,
      title: r.summary ?? "(untitled)",
      startsAt,
      endsAt: r.dtend ? parseICalDate(r.dtend) : undefined,
      source,
      fetchedAt,
      freshness: "LIVE",
    });
  }
  return out;
}

export class ICalAdapter {
  private readonly transport: Transport;
  readonly source: string;

  constructor(opts: ICalAdapterOptions) {
    this.transport = opts.transport;
    this.source = opts.source;
  }

  /** One-shot fetch of an ICS feed → normalized events (without provenance wrapper). */
  async fetchRaw(path: string): Promise<RawICalEvent[]> {
    const { data } = await this.transport.request<string>({ path, response: "text" });
    return parseICal(data);
  }

  /** One-shot fetch → normalized CalendarEvent list (freshness LIVE). */
  async fetchEvents(path: string): Promise<CalendarEvent[]> {
    const fetchedAt = new Date().toISOString();
    return normalizeICalEvents(await this.fetchRaw(path), this.source, fetchedAt);
  }

  /**
   * Continuous polling variant with the uniform adapter surface
   * (connect/disconnect/on/snapshot/health).
   */
  poller(path: string, intervalMs = 24 * 60 * 60 * 1000): PollingAdapter<CalendarEvent> {
    const rest = new RestAdapter({ transport: this.transport });
    const source = this.source;
    return new PollingAdapter<CalendarEvent>({
      adapter: rest,
      path,
      intervalMs,
      source,
      response: "text",
      guard: (raw) => {
        if (typeof raw !== "string") throw new Error("expected ICS text");
        return normalizeICalEvents(parseICal(raw), source, new Date().toISOString());
      },
      idOf: (e) => e.id,
    });
  }
}
