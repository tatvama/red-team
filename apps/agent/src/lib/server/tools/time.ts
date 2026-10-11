import { z } from "zod";
import type { ToolDefinition } from "./types";

const schema = z
  .object({
    timezone: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('IANA time zone such as "Europe/London" or "Asia/Kolkata". Defaults to the server time zone.'),
  })
  .strict();

export const currentTimeTool: ToolDefinition<typeof schema> = {
  name: "get_current_time",
  title: "Current time",
  description:
    "Get the current date and time, in UTC and in a given IANA time zone. Use it whenever the answer depends on " +
    "today's date or the time of day; do not guess.",
  schema,
  defaultPolicy: "auto",
  risk: "read",
  available: () => ({ ok: true }),
  summarize: (input) => (input.timezone ? `Get the current time in ${input.timezone}` : "Get the current time"),
  async run(input) {
    const now = new Date();
    let full: Intl.DateTimeFormat;
    let offset: Intl.DateTimeFormat;
    try {
      full = new Intl.DateTimeFormat("en-US", { timeZone: input.timezone, dateStyle: "full", timeStyle: "full" });
      offset = new Intl.DateTimeFormat("en-US", { timeZone: input.timezone, timeZoneName: "longOffset" });
    } catch {
      return {
        status: "error",
        content: `Unknown time zone: ${input.timezone}. Use an IANA name such as "America/New_York".`,
      };
    }
    // Echo the requested name: ICU may canonicalise it (Asia/Kolkata becomes Asia/Calcutta).
    const zone = input.timezone ?? full.resolvedOptions().timeZone;
    const utcOffset = offset.formatToParts(now).find((part) => part.type === "timeZoneName")?.value ?? "";
    return {
      status: "ok",
      content: [
        `UTC: ${now.toISOString()}`,
        `Local (${zone}): ${full.format(now)}`,
        utcOffset ? `UTC offset: ${utcOffset}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    };
  },
};
