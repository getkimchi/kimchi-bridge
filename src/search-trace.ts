import { readBody } from "./kimchi.ts";

const TRACE_PATHS = new Set([
  "/anthropic/v1/messages",
  "/openai/v1/responses",
  "/openai/v1/chat/completions",
]);
const MAX_TRACE_CATEGORIES = 8;
const MAX_OTHER_ITEMS = 999;

interface SearchSchemaTrace {
  event: "search_schema";
  method: string;
  path: string;
  model?: string;
  categories: string[];
  otherTools: number;
  parse?: "unparsed";
}

interface SearchResponseTrace {
  event: "search_items";
  path: string;
  status: number;
  categories: string[];
  otherItems: number;
  parse?: "unparsed";
}

function modelLabel(model: unknown): string | undefined {
  if (typeof model !== "string" || !model.length || model.length > 128) return undefined;
  return [...model].every(
    (character) =>
      (character >= "a" && character <= "z") ||
      (character >= "A" && character <= "Z") ||
      (character >= "0" && character <= "9") ||
      ["_", "-", ".", ":", "/"].includes(character),
  )
    ? model
    : undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function requestSearchTrace(
  method: string,
  path: string,
  body: ArrayBuffer | Uint8Array | undefined,
  model: unknown,
): SearchSchemaTrace | undefined {
  if (!TRACE_PATHS.has(path)) return undefined;
  const base: SearchSchemaTrace = {
    event: "search_schema",
    method,
    path,
    categories: [],
    otherTools: 0,
    ...(modelLabel(model) ? { model: modelLabel(model) } : {}),
  };
  try {
    if (!body) throw new Error();
    const parsed = JSON.parse(new TextDecoder().decode(body)) as unknown;
    const root = object(parsed);
    if (!root) throw new Error();
    const categories = new Set<string>();
    let otherTools = 0;
    const tools = Array.isArray(root.tools) ? root.tools : [];
    for (const value of tools) {
      const tool = object(value);
      if (!tool) {
        otherTools++;
        continue;
      }
      if (tool.type === "web_search" || tool.type === "web_search_preview") {
        if (categories.size < MAX_TRACE_CATEGORIES) categories.add(tool.type);
        continue;
      }
      if (tool.type === "namespace" && tool.name === "web") {
        const children = Array.isArray(tool.tools) ? tool.tools : [];
        if (children.some((child) => object(child)?.name === "run")) {
          if (categories.size < MAX_TRACE_CATEGORIES) categories.add("namespace_web_run");
        } else {
          otherTools++;
        }
        continue;
      }
      otherTools++;
    }
    return {
      ...base,
      categories: [...categories],
      otherTools: Math.min(otherTools, MAX_OTHER_ITEMS),
    };
  } catch {
    return { ...base, parse: "unparsed" };
  }
}

function itemCategories(item: Record<string, unknown>, categories: Set<string>): boolean {
  const type = item.type;
  let categorized = false;
  const add = (category: string) => {
    if (categories.size < MAX_TRACE_CATEGORIES) categories.add(category);
    categorized = true;
  };
  if (type === "web_search_call") add("web_search_call");
  if (type === "function_call" || type === "function_call_output") add(type);
  if (
    (type === "function_call" || type === "function_call_output") &&
    item.namespace === "web" &&
    item.name === "run"
  )
    add("namespace_web_run");
  if (
    ["mcp_call", "mcp_tool_call", "custom_tool_call"].includes(String(type)) &&
    ["web_search", "web.run", "search_service.web_run"].includes(String(item.name))
  )
    add("host_connector_search");
  if (type === "function_call_output") {
    const output = typeof item.output === "string" ? item.output : "";
    if (output.includes("unsupported call: webrun")) add("unsupported_call_webrun");
    else if (output.includes("unsupported call")) add("unsupported_call");
  }
  return categorized;
}

function collectItems(value: unknown, categories: Set<string>): number {
  let otherItems = 0;
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let visited = 0;
  while (pending.length && visited < 64) {
    const current = pending.pop()!;
    visited++;
    if (Array.isArray(current.value)) {
      if (current.depth < 8)
        for (const value of current.value.slice(0, 64))
          pending.push({ value, depth: current.depth + 1 });
      continue;
    }
    const item = object(current.value);
    if (!item) continue;
    if (typeof item.type === "string" && !itemCategories(item, categories))
      otherItems = Math.min(otherItems + 1, MAX_OTHER_ITEMS);
    if (current.depth === 8) continue;
    for (const [key, child] of Object.entries(item).slice(0, 32)) {
      if (["output", "item", "response", "items", "content", "error"].includes(key))
        pending.push({ value: child, depth: current.depth + 1 });
    }
  }
  return otherItems;
}

export function responseSearchTrace(
  path: string,
  status: number,
  contentType: string | null,
  text: string,
): SearchResponseTrace | undefined {
  if (!TRACE_PATHS.has(path)) return undefined;
  const base: SearchResponseTrace = {
    event: "search_items",
    path,
    status,
    categories: [],
    otherItems: 0,
  };
  const categories = new Set<string>();
  let otherItems = 0;
  try {
    if (contentType?.toLowerCase().includes("text/event-stream")) {
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data.startsWith("{")) continue;
        otherItems += collectItems(JSON.parse(data), categories);
      }
    } else {
      otherItems = collectItems(JSON.parse(text), categories);
    }
  } catch {
    return { ...base, parse: "unparsed" };
  }
  return { ...base, categories: [...categories], otherItems };
}

export async function observeSearchResponse(
  stream: ReadableStream<Uint8Array>,
  path: string,
  status: number,
  contentType: string | null,
): Promise<SearchResponseTrace | undefined> {
  const text = await readBody(new Response(stream), 1 << 20);
  return responseSearchTrace(path, status, contentType, text);
}
