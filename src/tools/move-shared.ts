import { WanderlogValidationError } from "../errors.js";
import { resolveDay } from "../resolvers/day.js";
import type { Section, TripPlan } from "../types.js";
import { findDaySectionByDate, findSectionByRef } from "./shared.js";

/**
 * Resolve a move/copy destination from either a day ref or a section heading.
 * Exactly one of `toDay` / `toSection` must be provided.
 */
export function resolveTargetSection(
  trip: TripPlan,
  toDay: string | undefined,
  toSection: string | undefined,
): { index: number; label: string } {
  if ((toDay && toSection) || (!toDay && !toSection)) {
    throw new WanderlogValidationError(
      "Provide exactly one destination: to_day OR to_section.",
      "Example: to_day: 'day 2', or to_section: 'Places to visit'.",
    );
  }

  if (toDay) {
    const daySection = resolveDay(trip, toDay);
    const found = findDaySectionByDate(trip, daySection.date!);
    if (!found) {
      throw new WanderlogValidationError(`Day ${toDay} not found in trip`);
    }
    return { index: found.index, label: `day ${daySection.date}` };
  }

  const found = findSectionByRef(trip, toSection!);
  if (!found) {
    throw new WanderlogValidationError(
      `Section "${toSection}" not found in trip "${trip.title}". Use wanderlog_get_trip to see available sections.`,
    );
  }
  return { index: found.index, label: `section "${toSection}"` };
}

export function formatSectionLocation(section: {
  heading?: string;
  type?: string;
  mode?: string;
  date?: string | null;
}): string {
  if (section.mode === "dayPlan" && section.date) {
    return `day ${section.date}`;
  }
  if (section.heading) return `"${section.heading}"`;
  return `"${section.type ?? "section"}"`;
}

export function ordinalLabel(n: number): string {
  const suffix = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${suffix[(v - 20) % 10] ?? suffix[v] ?? suffix[0]}`;
}

// Silence unused-type lint if Section import is only used structurally.
export type { Section };
