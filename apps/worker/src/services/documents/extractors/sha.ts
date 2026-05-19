// Task #13: Shareholders agreement extractor.

export const SHA_EXTRACTOR_VERSION = "1.0.0";

export interface ShaExtraction {
  drag_along_threshold_pct: number | null;
  tag_along: boolean;
  rofr: boolean;
  preemptive_right: boolean;
  board_size: number | null;
  information_rights: boolean;
  warnings: string[];
}

export function extractSha(text: string): ShaExtraction {
  const warnings: string[] = [];
  const dragM = /drag[-\s]?along[^%]{0,200}?(\d{1,3}(?:\.\d+)?)\s*%/i.exec(text);
  const drag_along_threshold_pct = dragM ? Number(dragM[1]) / 100 : null;
  const tag_along = /tag[-\s]?along/i.test(text);
  const rofr = /(right\s+of\s+first\s+refusal|\brofr\b)/i.test(text);
  const preemptive_right = /(preemptive\s+right|pre-?emption)/i.test(text);
  const boardM = /board\s+(?:of\s+directors\s+)?(?:shall\s+)?(?:consist|be\s+composed)\s+of\s+(\d{1,2})\s+(?:directors|members)/i.exec(text);
  const board_size = boardM ? Number(boardM[1]) : null;
  const information_rights = /information\s+rights/i.test(text);
  if (drag_along_threshold_pct == null) warnings.push("no_drag_threshold");
  return {
    drag_along_threshold_pct, tag_along, rofr, preemptive_right,
    board_size, information_rights, warnings,
  };
}
