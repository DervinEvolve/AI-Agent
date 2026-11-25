import {
  REPORT_PAGE_DEFAULT_BYTES,
  REPORT_PAGE_MAX_BYTES,
  REPORT_PAGE_MIN_BYTES,
  REPORT_SPLIT_MARKER,
  type CitationDescriptor,
  type ReportItem,
  type ReportPage,
} from "./types.js";
import { splitUtf8, utf8ByteLength } from "./utf8.js";

export interface FrozenReport {
  items: ReportItem[];
  frozen: true;
}

export function freezeReport(items: ReportItem[]): FrozenReport {
  return {
    frozen: true,
    items: items.map((item, index) => ({
      index,
      text: item.text,
      citations: item.citations.map((c) => ({ child_call_id: c.child_call_id, tool_name: c.tool_name })),
      ...(item.split_marker ? { split_marker: item.split_marker } : {}),
    })),
  };
}

function pageSkeleton(offset: number, limit: number): Omit<ReportPage, "byte_length"> {
  return {
    offset,
    limit,
    items: [],
    next_offset: offset,
    has_more: false,
    citation_elided_count: 0,
  };
}

function measure(page: Omit<ReportPage, "byte_length">): number {
  return utf8ByteLength(JSON.stringify(page));
}

function fits(page: Omit<ReportPage, "byte_length">, limit: number): boolean {
  return measure(page) <= limit;
}

export function clampPageLimit(limit: number | undefined): number {
  if (limit === undefined) return REPORT_PAGE_DEFAULT_BYTES;
  if (!Number.isInteger(limit)) return REPORT_PAGE_MIN_BYTES;
  if (limit < REPORT_PAGE_MIN_BYTES) return REPORT_PAGE_MIN_BYTES;
  if (limit > REPORT_PAGE_MAX_BYTES) return REPORT_PAGE_MAX_BYTES;
  return limit;
}

/**
 * Offset is an item index. Limit is an inclusive byte budget covering metadata
 * and whole citation descriptors. Text splits only on UTF-8 boundaries.
 */
export function buildReportPage(frozen: FrozenReport, offset: number, limitRaw?: number): ReportPage {
  const limit = clampPageLimit(limitRaw);
  const start = Math.max(0, Math.floor(offset));
  const page = pageSkeleton(start, limit);
  if (start >= frozen.items.length) {
    page.byte_length = measure(page);
    return page as ReportPage;
  }

  let cursor = start;
  while (cursor < frozen.items.length) {
    const source = frozen.items[cursor];
    const fragment = takeFragment(source, limit, page);
    if (!fragment) break;
    const trial = {
      ...page,
      items: [...page.items, fragment.item],
      next_offset: fragment.consumed ? cursor + 1 : cursor,
      citation_elided_count: page.citation_elided_count + fragment.elided,
      has_more: fragment.consumed ? cursor + 1 < frozen.items.length : true,
    };
    if (!fits(trial, limit)) {
      if (page.items.length === 0) {
        const tiny = forceMinFit(source, limit, start);
        tiny.byte_length = measure(tiny);
        return tiny;
      }
      break;
    }
    page.items.push(fragment.item);
    page.citation_elided_count += fragment.elided;
    page.next_offset = fragment.consumed ? cursor + 1 : cursor;
    page.has_more = fragment.consumed ? cursor + 1 < frozen.items.length : true;
    if (!fragment.consumed) {
      frozen.items.splice(cursor, 1, ...fragment.replacements);
      break;
    }
    cursor += 1;
  }
  page.has_more = page.next_offset < frozen.items.length;
  const out = page as ReportPage;
  out.byte_length = measure(page);
  return out;
}

function takeFragment(
  source: ReportItem,
  limit: number,
  page: Omit<ReportPage, "byte_length">,
): {
  item: ReportItem;
  consumed: boolean;
  elided: number;
  replacements: ReportItem[];
} | null {
  const withAll: ReportItem = {
    index: source.index,
    text: source.text,
    citations: source.citations.map(cloneCitation),
    ...(source.split_marker ? { split_marker: source.split_marker } : {}),
  };
  const trial = {
    ...page,
    items: [...page.items, withAll],
    next_offset: source.index + 1,
    has_more: true,
  };
  if (fits(trial, limit)) {
    return { item: withAll, consumed: true, elided: 0, replacements: [] };
  }

  const overhead = measure({
    ...page,
    items: [...page.items, { index: source.index, text: "", citations: [], split_marker: REPORT_SPLIT_MARKER }],
    has_more: true,
    next_offset: source.index,
  });
  const room = Math.max(0, limit - overhead);
  const split = splitUtf8(source.text, room);
  const head = split.head;
  const item: ReportItem = {
    index: source.index,
    text: head,
    citations: [],
    split_marker: split.split ? REPORT_SPLIT_MARKER : source.split_marker,
  };
  const citationsFit = citationsThatFit(source.citations, { ...page, items: [...page.items, item] }, limit);
  item.citations = citationsFit.kept;
  const elided = citationsFit.elided.length;
  const restText = split.rest;
  const replacements: ReportItem[] = [];
  if (restText.length > 0 || citationsFit.elided.length > 0) {
    replacements.push({
      index: source.index,
      text: restText,
      citations: citationsFit.elided,
      split_marker: split.split ? REPORT_SPLIT_MARKER : undefined,
    });
  }
  const consumed = replacements.length === 0;
  return { item, consumed, elided, replacements };
}

function citationsThatFit(
  citations: CitationDescriptor[],
  base: Omit<ReportPage, "byte_length">,
  limit: number,
): { kept: CitationDescriptor[]; elided: CitationDescriptor[] } {
  const kept: CitationDescriptor[] = [];
  const elided: CitationDescriptor[] = [];
  for (const c of citations) {
    const trialItems = base.items.map((it, i) =>
      i === base.items.length - 1 ? { ...it, citations: [...kept, cloneCitation(c)] } : it,
    );
    const trial = { ...base, items: trialItems };
    if (fits(trial, limit)) kept.push(cloneCitation(c));
    else elided.push(cloneCitation(c));
  }
  return { kept, elided };
}

function forceMinFit(source: ReportItem, limit: number, offset: number): ReportPage {
  const page = pageSkeleton(offset, limit);
  const marker = REPORT_SPLIT_MARKER;
  let text = "";
  const bytes = new TextEncoder().encode(source.text);
  const dec = new TextDecoder();
  for (let n = 0; n <= bytes.length; n += 1) {
    if (n > 0 && (bytes[n] & 0b1100_0000) === 0b1000_0000) continue;
    const candidate = dec.decode(bytes.slice(0, n));
    const item: ReportItem = {
      index: source.index,
      text: candidate,
      citations: [],
      split_marker: n < bytes.length ? marker : source.split_marker,
    };
    const trial = { ...page, items: [item], next_offset: offset, has_more: true };
    if (measure(trial) <= limit) text = candidate;
    else break;
  }
  page.items.push({
    index: source.index,
    text,
    citations: [],
    split_marker: text.length < source.text.length ? marker : source.split_marker,
  });
  page.citation_elided_count = source.citations.length;
  page.has_more = true;
  page.next_offset = offset;
  return page as ReportPage;
}

function cloneCitation(c: CitationDescriptor): CitationDescriptor {
  return { child_call_id: c.child_call_id, tool_name: c.tool_name };
}

export function exposedCitationIds(page: ReportPage): string[] {
  const ids: string[] = [];
  for (const item of page.items) {
    for (const c of item.citations) ids.push(c.child_call_id);
  }
  return ids;
}
