// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { currentTimeTool } from "./time";

const ctx = { signal: new AbortController().signal, conversationId: "test" };

afterEach(() => {
  vi.useRealTimers();
});

describe("get_current_time", () => {
  it("returns UTC and the local time in the requested zone", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-10T12:30:00Z"));
    const result = await currentTimeTool.run({ timezone: "Asia/Kolkata" }, ctx);
    expect(result.status).toBe("ok");
    // ICU versions differ on whether a narrow no-break space precedes "PM", hence \s.
    expect(result.content).toMatch(
      /^UTC: 2026-10-10T12:30:00\.000Z\nLocal \(Asia\/Kolkata\): Saturday, October 10, 2026 at 6:00:00\sPM India Standard Time\nUTC offset: GMT\+05:30$/,
    );
  });

  it("defaults to the server zone", async () => {
    const result = await currentTimeTool.run({}, ctx);
    expect(result.status).toBe("ok");
    expect(result.content).toMatch(/^UTC: \d{4}-\d\d-\d\dT[\d:.]+Z\nLocal \(.+\): /);
  });

  it("rejects unknown zones", async () => {
    const result = await currentTimeTool.run({ timezone: "Mars/Olympus_Mons" }, ctx);
    expect(result).toEqual({
      status: "error",
      content: 'Unknown time zone: Mars/Olympus_Mons. Use an IANA name such as "America/New_York".',
    });
  });
});
