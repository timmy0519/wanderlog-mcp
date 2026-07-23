import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogNotFoundError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolvePlaceRef } from "../resolvers/place-ref.js";
import { isPlaceBlock, type Block } from "../types.js";
import { generateBlockId, submitOp } from "./shared.js";
import { formatSectionLocation, ordinalLabel, resolveTargetSection } from "./move-shared.js";

export const copyPlaceInputSchema = {
  trip_key: z.string().min(1).describe("The trip to copy within."),
  place_ref: z
    .string()
    .min(1)
    .describe(
      "Natural-language reference to the place to copy. Same syntax as remove_place: exact/partial name, day filter ('X on day 3'), ordinal prefixes for duplicates ('2nd X').",
    ),
  to_day: z
    .string()
    .optional()
    .describe("Destination day. Accepts 'day 2', 'May 4', or ISO '2026-05-04'. Provide this OR to_section."),
  to_section: z
    .string()
    .optional()
    .describe("Destination section by heading (e.g. 'Places to visit'). Provide this OR to_day."),
  position: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based position within the destination. Omit to append to the end."),
};

export const copyPlaceDescription = `
Copies a place (or any block) to another day or section in the SAME trip, leaving the original in
place. The copy carries the original's inline note, scheduled times, and photos, but gets a fresh
block id so the two are independent (editing one does not affect the other).

Provide exactly one destination: to_day OR to_section. Use position (1-based) to control placement;
omit to append. Useful for turning an unscheduled "Places to visit" candidate into a scheduled stop
on a real day while keeping it in the candidate list.

If the reference is ambiguous, returns a numbered candidate list and makes no change.
`.trim();

type Args = {
  trip_key: string;
  place_ref: string;
  to_day?: string;
  to_section?: string;
  position?: number;
};

export async function copyPlace(
  ctx: AppContext,
  args: Args,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  try {
    const trip = await ctx.tripCache.get(args.trip_key);

    const result = resolvePlaceRef(trip, args.place_ref);
    if (result.kind === "none") {
      throw new WanderlogNotFoundError("Place", args.place_ref);
    }
    if (result.kind === "ambiguous") {
      const lines = result.candidates
        .slice(0, 10)
        .map((c, i) => {
          const name = isPlaceBlock(c.block) ? c.block.place.name : `${c.block.type} block`;
          return `  ${i + 1}. ${name} — ${formatSectionLocation(c.section)} (${ordinalLabel(i + 1)})`;
        })
        .join("\n");
      const first = isPlaceBlock(result.candidates[0]!.block)
        ? result.candidates[0]!.block.place.name
        : "the block";
      return {
        content: [
          {
            type: "text",
            text: `"${args.place_ref}" matches ${result.candidates.length} places:\n${lines}\n\nRetry with an ordinal, e.g. place_ref: "1st ${first}".`,
          },
        ],
        isError: true,
      };
    }

    const { block } = result.match;
    const dest = resolveTargetSection(trip, args.to_day, args.to_section);

    // Deep-clone and give the copy its own id so the two blocks are independent.
    const clone = structuredClone(block) as Record<string, unknown>;
    clone.id = generateBlockId();

    const dstLen = trip.itinerary.sections[dest.index]!.blocks.length;
    const dstIdx = args.position !== undefined ? clamp(args.position - 1, 0, dstLen) : dstLen;

    const ops: Json0Op[] = [
      { p: ["itinerary", "sections", dest.index, "blocks", dstIdx], li: clone as unknown as Block },
    ];
    await submitOp(ctx, args.trip_key, ops);

    const name = isPlaceBlock(block) ? block.place.name : `${block.type} block`;
    return {
      content: [{ type: "text", text: `Copied ${name} to ${dest.label} in "${trip.title}".` }],
    };
  } catch (err) {
    const msg =
      err instanceof WanderlogError
        ? err.toUserMessage()
        : `Unexpected error: ${(err as Error).message}`;
    return { content: [{ type: "text", text: msg }], isError: true };
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
