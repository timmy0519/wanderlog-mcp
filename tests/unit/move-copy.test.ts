import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyOp, type Json0Op } from "../../src/ot/apply.ts";
import { queenstownTrip } from "../fixtures/queenstown-trip.ts";
import type { PlaceBlock, TripPlan } from "../../src/types.ts";

// Mock ONLY the network layer (submitOp). Every other helper — resolvers,
// section lookups, generateBlockId — stays real, so the tool's index math and
// op shapes are genuinely exercised. Submitted ops are applied to an in-memory
// doc via the real applyOp, mirroring what the server would do.
const holder: { doc: TripPlan; lastOps: Json0Op[] } = {
  doc: structuredClone(queenstownTrip),
  lastOps: [],
};

vi.mock("../../src/tools/shared.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/tools/shared.ts")>();
  return {
    ...actual,
    submitOp: vi.fn(async (_ctx: unknown, _key: string, ops: Json0Op[]) => {
      holder.lastOps = ops;
      holder.doc = applyOp(holder.doc, ops);
    }),
  };
});

const { movePlace } = await import("../../src/tools/move-place.ts");
const { copyPlace } = await import("../../src/tools/copy-place.ts");

const ctx = {
  tripCache: { get: async () => holder.doc },
} as unknown as Parameters<typeof movePlace>[0];

function sectionByDate(trip: TripPlan, date: string) {
  return trip.itinerary.sections.find((s) => s.mode === "dayPlan" && s.date === date)!;
}
function placesToVisit(trip: TripPlan) {
  return trip.itinerary.sections.find((s) => s.heading === "Places to visit")!;
}

beforeEach(() => {
  holder.doc = structuredClone(queenstownTrip);
  holder.lastOps = [];
});

describe("movePlace", () => {
  it("moves a place from Places-to-visit to a day, preserving the whole block (note included)", async () => {
    // Give the source block a note so we can prove it rides along.
    const src = placesToVisit(holder.doc).blocks[0] as PlaceBlock & { text?: unknown };
    (src as Record<string, unknown>).text = { ops: [{ insert: "海鮮義大利麵\n" }] };

    const res = await movePlace(ctx, {
      trip_key: "vzyrsyhgxvonvxcz",
      place_ref: "Queenstown Gardens",
      to_day: "2026-05-03",
    });

    expect(res.isError).toBeFalsy();
    // gone from source
    expect(placesToVisit(holder.doc).blocks).toHaveLength(0);
    // present in destination day, with note + id intact
    const dst = sectionByDate(holder.doc, "2026-05-03").blocks;
    expect(dst).toHaveLength(1);
    const moved = dst[0] as PlaceBlock & { text?: { ops: Array<{ insert: string }> } };
    expect(moved.place.name).toBe("Queenstown Gardens");
    expect(moved.id).toBe(321690565);
    expect(moved.text?.ops[0]?.insert).toBe("海鮮義大利麵\n");
    // atomic: single submit, two ops (ld + li)
    expect(holder.lastOps).toHaveLength(2);
    expect(holder.lastOps[0]).toHaveProperty("ld");
    expect(holder.lastOps[1]).toHaveProperty("li");
  });

  it("uses a single lm op for same-section reorder", async () => {
    // Add a second block so there's something to reorder against.
    const pv = placesToVisit(holder.doc);
    pv.blocks.push({ id: 111, type: "place", place: { name: "Second", place_id: "x" } } as PlaceBlock);

    const res = await movePlace(ctx, {
      trip_key: "vzyrsyhgxvonvxcz",
      place_ref: "Queenstown Gardens",
      to_section: "Places to visit",
      position: 2,
    });

    expect(res.isError).toBeFalsy();
    expect(holder.lastOps).toHaveLength(1);
    expect(holder.lastOps[0]).toHaveProperty("lm", 1);
    // Queenstown Gardens now at index 1
    expect((placesToVisit(holder.doc).blocks[1] as PlaceBlock).place.name).toBe("Queenstown Gardens");
  });

  it("rejects when both to_day and to_section are given", async () => {
    const res = await movePlace(ctx, {
      trip_key: "vzyrsyhgxvonvxcz",
      place_ref: "Queenstown Gardens",
      to_day: "2026-05-03",
      to_section: "Places to visit",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/exactly one destination/i);
  });
});

describe("copyPlace", () => {
  it("copies to a day, keeps the original, and gives the copy a fresh id", async () => {
    const res = await copyPlace(ctx, {
      trip_key: "vzyrsyhgxvonvxcz",
      place_ref: "Queenstown Gardens",
      to_day: "2026-05-04",
    });

    expect(res.isError).toBeFalsy();
    // original still in Places to visit
    expect(placesToVisit(holder.doc).blocks).toHaveLength(1);
    // copy in destination day
    const dst = sectionByDate(holder.doc, "2026-05-04").blocks;
    expect(dst).toHaveLength(1);
    const copy = dst[0] as PlaceBlock;
    expect(copy.place.name).toBe("Queenstown Gardens");
    // fresh id — independent from the original
    expect(copy.id).not.toBe(321690565);
    // single insert op
    expect(holder.lastOps).toHaveLength(1);
    expect(holder.lastOps[0]).toHaveProperty("li");
  });
});
