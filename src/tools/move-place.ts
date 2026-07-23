import { z } from "zod";
import type { AppContext } from "../context.js";
import { WanderlogError, WanderlogNotFoundError } from "../errors.js";
import type { Json0Op } from "../ot/apply.js";
import { resolvePlaceRef } from "../resolvers/place-ref.js";
import { isPlaceBlock } from "../types.js";
import { submitOp } from "./shared.js";
import { formatSectionLocation, ordinalLabel, resolveTargetSection } from "./move-shared.js";

export const movePlaceInputSchema = {
  trip_key: z.string().min(1).describe("The trip to move within."),
  place_ref: z
    .string()
    .min(1)
    .describe(
      "Natural-language reference to the place to move. Same syntax as remove_place: exact/partial name, role keyword ('the hotel'), day filter ('X on day 3'), and ordinal prefixes for duplicates ('2nd X').",
    ),
  to_day: z
    .string()
    .optional()
    .describe("Destination day. Accepts 'day 2', 'May 4', or ISO '2026-05-04'. Provide this OR to_section."),
  to_section: z
    .string()
    .optional()
    .describe(
      "Destination section by heading (e.g. 'Places to visit', 'Food & Drink'). Provide this OR to_day.",
    ),
  position: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("1-based position within the destination. Omit to append to the end."),
};

export const movePlaceDescription = `
Moves a place (or any block) from its current location to another day or section in the SAME trip,
in a single atomic operation. The block's inline note, scheduled times, photos, and all other
fields ride along — nothing is lost (unlike a manual remove + re-add).

Provide exactly one destination: to_day OR to_section. Use position (1-based) to control where it
lands; omit to append to the end.

If the place reference is ambiguous, returns a numbered candidate list and makes no change — retry
with an ordinal prefix ("1st X", "2nd X") or a day filter.
`.trim();

type Args = {
  trip_key: string;
  place_ref: string;
  to_day?: string;
  to_section?: string;
  position?: number;
};

export async function movePlace(
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
            text: `"${args.place_ref}" matches ${result.candidates.length} places:\n${lines}\n\nRetry with an ordinal, e.g. place_ref: "1st ${first}" or "2nd ${first} on day 2".`,
          },
        ],
        isError: true,
      };
    }

    const { sectionIndex: srcSi, blockIndex: srcBi, block, section: srcSection } = result.match;

    const dest = resolveTargetSection(trip, args.to_day, args.to_section);

    const name = isPlaceBlock(block) ? block.place.name : `${block.type} block`;

    // Same section → in-place reorder via list-move (lm). No-op guard when the
    // target index equals the current one.
    if (dest.index === srcSi) {
      const len = trip.itinerary.sections[srcSi]!.blocks.length;
      const toIndex = args.position !== undefined ? clamp(args.position - 1, 0, len - 1) : len - 1;
      if (toIndex === srcBi) {
        return {
          content: [
            { type: "text", text: `${name} is already at that position in ${dest.label}.` },
          ],
        };
      }
      const ops: Json0Op[] = [
        { p: ["itinerary", "sections", srcSi, "blocks", srcBi], lm: toIndex },
      ];
      await submitOp(ctx, args.trip_key, ops);
      return {
        content: [{ type: "text", text: `Moved ${name} to position ${toIndex + 1} in ${dest.label}.` }],
      };
    }

    // Cross-section → atomic delete-from-source + insert-into-dest. Because the
    // two arrays are different, sequential apply keeps both indices valid.
    const dstLen = trip.itinerary.sections[dest.index]!.blocks.length;
    const dstIdx = args.position !== undefined ? clamp(args.position - 1, 0, dstLen) : dstLen;
    const ops: Json0Op[] = [
      { p: ["itinerary", "sections", srcSi, "blocks", srcBi], ld: block },
      { p: ["itinerary", "sections", dest.index, "blocks", dstIdx], li: block },
    ];
    await submitOp(ctx, args.trip_key, ops);

    return {
      content: [
        {
          type: "text",
          text: `Moved ${name} from ${formatSectionLocation(srcSection)} to ${dest.label} in "${trip.title}".`,
        },
      ],
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
