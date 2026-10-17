const MAX_MINUTES = 18 * 60;

// TZ_OFFSET_MINUTES is a fixed offset. Named zones use the offset in effect at `now`,
// so a later daylight-saving change needs another setup run.
export function timezoneOffsetMinutes(input, now = new Date()) {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("timezone is required");
  if (/^(utc|gmt|z)$/i.test(raw)) return 0;

  const clock = /^([+-])(\d{1,2}):(\d{2})$/.exec(raw);
  if (clock) {
    const sign = clock[1] === "-" ? -1 : 1;
    const hours = Number(clock[2]);
    const mins = Number(clock[3]);
    if (hours > 18 || mins > 59) throw new Error(`timezone offset ${raw} is out of range`);
    return sign * (hours * 60 + mins);
  }
  // A signed 1-2 digit number is hours (`+5`, `-8`). Three or more digits, and
  // an unsigned number, are minutes east of UTC (`-300`, `480`).
  const hoursOnly = /^([+-])(\d{1,2})$/.exec(raw);
  if (hoursOnly) {
    const sign = hoursOnly[1] === "-" ? -1 : 1;
    const hours = Number(hoursOnly[2]);
    if (hours > 18) throw new Error(`timezone offset ${raw} is out of range`);
    return sign * hours * 60;
  }

  if (/^[+-]?\d+$/.test(raw)) {
    const minutes = Number(raw);
    if (!Number.isInteger(minutes) || Math.abs(minutes) > MAX_MINUTES) {
      throw new Error(`timezone offset ${raw} is out of range`);
    }
    return minutes;
  }

  let formatted;
  try {
    formatted = new Intl.DateTimeFormat("en-US", {
      timeZone: raw,
      timeZoneName: "shortOffset",
      year: "numeric",
    }).format(now);
  } catch {
    throw new Error(`unknown timezone: ${raw}`);
  }
  const match = /GMT(?:([+-])(\d{1,2})(?::(\d{2}))?)?/.exec(formatted);
  if (!match) throw new Error(`unknown timezone: ${raw}`);
  if (!match[1]) return 0;
  const sign = match[1] === "-" ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3] ?? "0"));
}
