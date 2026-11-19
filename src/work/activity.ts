import { randomUUID, createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { integer, stringifyJson } from "./protocol.ts";

export const TOOL_ACTIVITY_LIMITS = {
  maxPayloadBytes: 64 << 10,
  maxIdentifierBytes: 512,
  maxMetadataBytes: 4096,
} as const;

type Harness = "claude-code" | "codex";
type Outcome = "OUTCOME_COMPLETED" | "OUTCOME_FAILED" | "OUTCOME_INTERRUPTED";
type ToolOutcome = Outcome;

export interface ActivityInput {
  source: Harness;
  stage?: string;
  event: Record<string, any>;
  result?: Record<string, any>;
  sessionId?: string;
  cwd?: string;
  version?: string;
  eventId?: string;
  occurredAt?: string;
}

export interface ToolPayload {
  encoding: "PAYLOAD_ENCODING_JSON" | "PAYLOAD_ENCODING_UTF8";
  data: string;
  complete: boolean;
  capturedBytes: string;
  originalBytes?: string;
  dataSha256: string;
  originalSha256?: string;
}

export type ToolCall = {
  callId: string;
  tool: string;
  arguments?: ToolPayload;
};
export type ShellCommand = {
  callId: string;
  command: string;
  workingDir?: string;
};
export type WebFetch = {
  callId: string;
  url: string;
  prompt?: string;
};
export type FileOperation = {
  callId: string;
  operation:
    | "FILE_OP_TYPE_READ"
    | "FILE_OP_TYPE_WRITE"
    | "FILE_OP_TYPE_EDIT"
    | "FILE_OP_TYPE_DELETE";
  path: string;
  content?: string;
  oldContent?: string;
};
export type Action =
  | { toolCall: ToolCall; shellCommand?: never; webFetch?: never; fileOperation?: never }
  | { toolCall?: never; shellCommand: ShellCommand; webFetch?: never; fileOperation?: never }
  | { toolCall?: never; shellCommand?: never; webFetch: WebFetch; fileOperation?: never }
  | { toolCall?: never; shellCommand?: never; webFetch?: never; fileOperation: FileOperation };

export interface GenericToolOutput {
  callId: string;
  success: boolean;
  output?: ToolPayload;
  error?: string;
  outcome: ToolOutcome;
  durationMs?: string;
}
interface ObservationBase {
  invocation?: Action;
}
export type Observation = ObservationBase &
  (
    | {
        toolOutput: GenericToolOutput;
        shellCommandOutput?: never;
        webFetchOutput?: never;
        fileOperationResult?: never;
      }
    | {
        toolOutput?: never;
        shellCommandOutput: {
          callId: string;
          exitCode?: number;
          stdout?: string;
          stderr?: string;
          outcome: ToolOutcome;
          durationMs?: string;
        };
        webFetchOutput?: never;
        fileOperationResult?: never;
      }
    | {
        toolOutput?: never;
        shellCommandOutput?: never;
        webFetchOutput: {
          callId: string;
          url?: string;
          code?: number;
          result?: string;
          outcome: ToolOutcome;
          durationMs?: string;
        };
        fileOperationResult?: never;
      }
    | {
        toolOutput?: never;
        shellCommandOutput?: never;
        webFetchOutput?: never;
        fileOperationResult: {
          callId: string;
          success: boolean;
          path?: string;
          content?: string;
          error?: string;
          outcome: ToolOutcome;
          durationMs?: string;
        };
      }
  );

type EventHeader = {
  eventId: string;
  occurredAt: string;
  trajectoryId?: string;
  turnId?: string;
  agent?: {
    id?: string;
    provider?: string;
    platform: Harness;
    platformVersion?: string;
  };
  actor?: {
    id: string;
    type: "ACTOR_TYPE_AGENT" | "ACTOR_TYPE_HUMAN" | "ACTOR_TYPE_SYSTEM" | "ACTOR_TYPE_POLICY";
  };
  causality?: {
    correlationId?: string;
    causationId?: string;
    parentId?: string;
  };
};
export type WorkspaceActionEvent = EventHeader & {
  action: Action;
  observation?: never;
  control?: never;
};
export type WorkspaceObservationEvent = EventHeader & {
  observation: Observation;
  action?: never;
  control?: never;
};
export type WorkspaceActivityEvent = WorkspaceActionEvent | WorkspaceObservationEvent;

const sha256 = (data: string) => createHash("sha256").update(data).digest("hex");

function text(value: unknown, limit: number = TOOL_ACTIVITY_LIMITS.maxIdentifierBytes): string {
  if (typeof value !== "string") return "";
  const result = value.trim();
  if (!result || result.includes("\0") || Buffer.byteLength(result) > limit)
    throw new Error("invalid activity text or metadata bound exceeded");
  return result;
}
function firstText(values: unknown[], limit?: number): string {
  for (const value of values) {
    const result = text(value, limit);
    if (result) return result;
  }
  return "";
}
function boundedText(s: string, limit: number): string {
  if (Buffer.byteLength(s) > limit) throw new Error("activity metadata bound exceeded");
  return s;
}
function nativeBody(value: ActivityInput): Record<string, any> {
  return value.event && typeof value.event === "object" ? value.event : {};
}
function callIdentity(event: Record<string, any>): { tool: string; callId: string } {
  return {
    tool: firstText([event.tool_name, event.tool], TOOL_ACTIVITY_LIMITS.maxIdentifierBytes),
    callId: firstText(
      [event.tool_use_id, event.call_id, event.toolCallId],
      TOOL_ACTIVITY_LIMITS.maxIdentifierBytes,
    ),
  };
}
function inputBody(event: Record<string, any>): unknown {
  if (event != null && event.tool_input !== undefined) return event.tool_input;
  // Flat harness events combine request arguments with after-hook metadata.
  // Do not let response/stage/timing fields change invocation identity or args.
  if (event == null || typeof event !== "object" || Array.isArray(event)) return event;
  const { tool_response, duration_ms, durationMs, hook_event_name, stage, ...projection } = event;
  return projection;
}
function firstField(body: unknown, keys: string[]): string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  for (const key of keys) {
    const value = (body as any)[key];
    if (typeof value === "string" && value.length) return value;
  }
  return "";
}
function optionalStringField(body: unknown, keys: string[]): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  for (const key of keys) {
    const value = (body as any)[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}
function integerField(body: unknown, keys: string[]): number | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  for (const key of keys) {
    const value = integer((body as any)[key]);
    if (value !== undefined && value >= -2147483648 && value <= 2147483647) return value;
  }
  return undefined;
}
function documentedExitPrefix(output: string): { code: number; stdout: string } | undefined {
  const prefix = "Exit code: ";
  if (!output.startsWith(prefix)) return;
  const newline = output.indexOf("\n");
  if (newline < prefix.length) return;
  let token = output.slice(prefix.length, newline);
  if (token.endsWith("\r")) token = token.slice(0, -1);
  const digits = token.startsWith("-") ? token.slice(1) : token;
  if (!digits) return;
  for (const char of digits) if (char < "0" || char > "9") return;
  const code = integerField({ value: Number(token) }, ["value"]);
  return code === undefined ? undefined : { code, stdout: output.slice(newline + 1) };
}

function rawResponse(input: ActivityInput): { present: boolean; value: unknown } {
  const event = nativeBody(input);
  if (event.tool_response != null) return { present: true, value: event.tool_response };
  if (input.result == null) return { present: false, value: undefined };
  // The mod passes the next(e) result separately from the native event. Its
  // `result` field is the actual tool payload when that envelope is present.
  const result = input.result.result !== undefined ? input.result.result : input.result;
  if (result == null) return { present: false, value: undefined };
  if (typeof result === "object" && !Array.isArray(result)) {
    // Capture metadata is used for phase timing; it is not tool output itself.
    const { durationMs, duration_ms, ...payload } = result as Record<string, any>;
    return { present: true, value: payload };
  }
  return { present: true, value: result };
}
function eventFailure(input: ActivityInput): boolean {
  return (
    input.stage === "PostToolUseFailure" ||
    input.result?.isError === true ||
    (typeof input.result?.deny === "string" && !!input.result.deny)
  );
}
function outcome(input: ActivityInput): ToolOutcome {
  const response = rawResponse(input).value;
  const interrupted =
    input.result?.interrupted === true ||
    (response &&
      typeof response === "object" &&
      !Array.isArray(response) &&
      (response as Record<string, any>).interrupted === true);
  // An explicit interruption signal is stronger than the transport's phase.
  if (interrupted) return "OUTCOME_INTERRUPTED";
  return eventFailure(input) ? "OUTCOME_FAILED" : "OUTCOME_COMPLETED";
}
function errorText(response: unknown): string | undefined {
  if (!response || typeof response !== "object" || Array.isArray(response)) return undefined;
  const value = (response as any).error;
  if (typeof value !== "string" || !value.length) return undefined;
  // A long provider/compiler error stays in bounded ToolPayload.output rather
  // than rejecting the entire result. Do not pretend a short prefix is a full error.
  return Buffer.byteLength(value) <= TOOL_ACTIVITY_LIMITS.maxMetadataBytes ? value : undefined;
}
function hasOnlyFields(value: unknown, fields: string[]): boolean {
  if (value == null || typeof value !== "object") return true;
  return !Array.isArray(value) && Object.keys(value).every((key) => fields.includes(key));
}

function header(input: ActivityInput): EventHeader {
  const session = text(input.sessionId || input.event.session_id);
  if ((input.source !== "claude-code" && input.source !== "codex") || !session)
    throw new Error("activity requires a supported harness and session id");
  const cwd = input.cwd || input.event.cwd;
  if (typeof cwd !== "string" || !isAbsolute(cwd))
    throw new Error("activity requires an absolute native working directory");
  const agent = text(input.event.agent_id || input.event.agentId) || "main";
  return {
    eventId: input.eventId || randomUUID(),
    occurredAt: new Date(input.occurredAt || Date.now()).toISOString(),
    trajectoryId: session,
    ...(input.event.turn_id || input.event.turnId
      ? { turnId: text(input.event.turn_id || input.event.turnId) }
      : {}),
    agent: {
      id: agent,
      platform: input.source,
      ...(input.version ? { platformVersion: input.version } : {}),
    },
    actor: { id: agent, type: "ACTOR_TYPE_AGENT" },
  };
}

export function contentPayload(value: unknown): ToolPayload {
  const json = typeof value === "string" ? "PAYLOAD_ENCODING_UTF8" : "PAYLOAD_ENCODING_JSON";
  const original = typeof value === "string" ? value : stringifyJson(value);
  const originalBytes = Buffer.from(original, "utf8");
  if (originalBytes.length <= TOOL_ACTIVITY_LIMITS.maxPayloadBytes)
    return {
      encoding: json,
      data: original,
      complete: true,
      capturedBytes: String(originalBytes.length),
      originalBytes: String(originalBytes.length),
      dataSha256: sha256(original),
      originalSha256: sha256(original),
    };

  // Do not leave half a code point at the boundary. A shorter prefix is still
  // explicitly a fragment, never a pretend canonical full JSON value.
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = TOOL_ACTIVITY_LIMITS.maxPayloadBytes;
  while (end > 0) {
    try {
      decoder.decode(originalBytes.subarray(0, end));
      break;
    } catch {
      end--;
    }
  }
  const data = originalBytes.subarray(0, end).toString("utf8");
  return {
    encoding: json,
    data,
    complete: false,
    capturedBytes: String(end),
    originalBytes: String(originalBytes.length),
    dataSha256: sha256(data),
    originalSha256: sha256(original),
  };
}

function genericAction(command: Record<string, any>, toolCallId: string, name: string): Action {
  return {
    toolCall: {
      callId: toolCallId,
      tool: name,
      arguments: contentPayload(inputBody(command)),
    },
  };
}

function actionFor(input: ActivityInput): Action {
  const event = nativeBody(input);
  const { tool, callId } = callIdentity(event);
  if (!tool || !callId) throw new Error("activity requires native tool and call identities");
  const args = inputBody(event);
  const name = tool.toLowerCase();
  if (["webfetch", "web_fetch", "fetch", "fetch_url"].includes(name)) {
    const url = firstField(args, ["url"]);
    const prompt = firstField(args, ["prompt"]);
    if (
      url &&
      Buffer.byteLength(url) <= TOOL_ACTIVITY_LIMITS.maxMetadataBytes &&
      Buffer.byteLength(prompt) <= TOOL_ACTIVITY_LIMITS.maxPayloadBytes
    )
      return {
        webFetch: {
          callId,
          url,
          ...(prompt ? { prompt } : {}),
        },
      };
    // Oversized URL/prompt data gets the same bounded generic representation.
  }
  const operations: Record<
    string,
    "FILE_OP_TYPE_READ" | "FILE_OP_TYPE_WRITE" | "FILE_OP_TYPE_EDIT" | "FILE_OP_TYPE_DELETE"
  > = {
    read: "FILE_OP_TYPE_READ",
    read_file: "FILE_OP_TYPE_READ",
    write: "FILE_OP_TYPE_WRITE",
    edit: "FILE_OP_TYPE_EDIT",
    delete: "FILE_OP_TYPE_DELETE",
    delete_file: "FILE_OP_TYPE_DELETE",
  };
  const operation = operations[name];
  if (operation) {
    const path = firstField(args, ["file_path", "path", "filePath"]);
    const content = optionalStringField(args, ["content", "new_string", "new_content"]);
    const oldContent = optionalStringField(args, ["old_string", "old_content"]);
    if (
      path &&
      Buffer.byteLength(path) <= TOOL_ACTIVITY_LIMITS.maxMetadataBytes &&
      Buffer.byteLength(content ?? "") <= TOOL_ACTIVITY_LIMITS.maxPayloadBytes &&
      Buffer.byteLength(oldContent ?? "") <= TOOL_ACTIVITY_LIMITS.maxPayloadBytes
    )
      return {
        fileOperation: {
          callId,
          operation,
          path: boundedText(path, TOOL_ACTIVITY_LIMITS.maxMetadataBytes),
          ...(content !== undefined
            ? { content: boundedText(content, TOOL_ACTIVITY_LIMITS.maxPayloadBytes) }
            : {}),
          ...(oldContent !== undefined
            ? { oldContent: boundedText(oldContent, TOOL_ACTIVITY_LIMITS.maxPayloadBytes) }
            : {}),
        },
      };
  }
  if (["bash", "exec_command", "shell", "shell_command", "write_stdin"].includes(name)) {
    const cmd = firstField(args, ["command", "cmd", "script"]);
    if (cmd) {
      const cwd = firstField(args, ["workdir", "working_dir", "cwd"]) || input.cwd || event.cwd;
      if (
        Buffer.byteLength(cmd) <= TOOL_ACTIVITY_LIMITS.maxPayloadBytes &&
        Buffer.byteLength(cwd) <= TOOL_ACTIVITY_LIMITS.maxMetadataBytes
      )
        return {
          shellCommand: {
            callId,
            command: cmd,
            workingDir: cwd,
          },
        };
    }
    // Arg arrays and other form-dependent shapes remain intact in ToolCall.
  }
  // Multi-file patches, MultiEdit and unknown/MCP tools cannot be put in a
  // one-path FileOperation without losing information, so they stay generic.
  return genericAction(event, callId, tool);
}

export function activityAction(input: ActivityInput): WorkspaceActionEvent {
  return { ...header(input), action: actionFor(input) };
}

function actionCallId(action: Action): string {
  if (action.toolCall) return action.toolCall.callId;
  if (action.shellCommand) return action.shellCommand.callId;
  if (action.webFetch) return action.webFetch.callId;
  return action.fileOperation.callId;
}

function responseError(input: ActivityInput): string | undefined {
  const e = nativeBody(input);
  return errorText(e.tool_response) || errorText(input.result);
}

function genericObservation(
  action: WorkspaceActionEvent,
  input: ActivityInput,
): { toolOutput: GenericToolOutput } {
  const id = actionCallId(action.action);
  const response = rawResponse(input);
  const result = outcome(input);
  return {
    toolOutput: {
      callId: id,
      success: result === "OUTCOME_COMPLETED",
      ...(response.present ? { output: contentPayload(response.value) } : {}),
      ...(responseError(input) ? { error: responseError(input) } : {}),
      outcome: result,
      ...duration(action.occurredAt, input.occurredAt),
    },
  };
}

function duration(startedAt: string, endedAt?: string): { durationMs: string } | {} {
  if (!endedAt) return {};
  const value = new Date(endedAt).getTime() - new Date(startedAt).getTime();
  if (!Number.isFinite(value)) throw new Error("invalid activity timestamps");
  return { durationMs: String(Math.max(0, Math.trunc(value))) };
}

function optionalText(value: unknown): value is string | undefined {
  return (
    value === undefined ||
    (typeof value === "string" && Buffer.byteLength(value) <= TOOL_ACTIVITY_LIMITS.maxPayloadBytes)
  );
}

function specializedObservation(
  action: Action,
  startedAt: string,
  input: ActivityInput,
): Observation | undefined {
  if (!action.shellCommand && !action.webFetch && !action.fileOperation) return undefined;
  const response = rawResponse(input);
  const value = response.value as any;
  const result = outcome(input);
  const base = {
    callId: actionCallId(action),
    outcome: result,
    ...duration(startedAt, input.occurredAt),
  };
  if (action.shellCommand) {
    // ShellCommandOutput has no generic error field. Prefer a typed ToolOutput
    // that faithfully represents the provider error instead of dropping it.
    if (responseError(input)) return undefined;
    let stdout: unknown, stderr: unknown, exitCode: number | undefined;
    if (typeof value === "string") {
      stdout = value;
      const match = documentedExitPrefix(value);
      if (match) {
        exitCode = match.code;
        stdout = match.stdout;
      }
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      stdout = value.stdout;
      stderr = value.stderr;
      exitCode = integerField(value, ["exit_code", "exitCode", "code"]);
    }
    if (
      (response.present &&
        !hasOnlyFields(value, [
          "stdout",
          "stderr",
          "exit_code",
          "exitCode",
          "code",
          "interrupted",
          "isImage",
          "noOutputExpected",
        ])) ||
      ![stdout, stderr].every(optionalText)
    )
      return undefined;
    return {
      shellCommandOutput: {
        ...base,
        ...(exitCode !== undefined ? { exitCode } : {}),
        ...(stdout !== undefined ? { stdout: stdout as string } : {}),
        ...(stderr !== undefined ? { stderr: stderr as string } : {}),
      },
    };
  }
  if (action.webFetch) {
    const code = integerField(value, ["code", "status", "status_code"]);
    const result =
      typeof value === "string" ? value : firstField(value, ["text", "content", "result", "body"]);
    if (result && Buffer.byteLength(result) <= TOOL_ACTIVITY_LIMITS.maxPayloadBytes)
      return {
        webFetchOutput: {
          ...base,
          url: action.webFetch.url,
          ...(code !== undefined ? { code } : {}),
          result,
        },
      };
    return undefined;
  }
  if (response.present && !hasOnlyFields(value, ["type", "file"])) return undefined;
  let content: unknown;
  let path = action.fileOperation.path;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    value.file &&
    typeof value.file === "object"
  ) {
    if (
      !hasOnlyFields(value.file, [
        "filePath",
        "path",
        "content",
        "numLines",
        "startLine",
        "totalLines",
      ])
    )
      return undefined;
    // Claude Code's Read tool returns {type:"text", file:{filePath,content,...}}.
    const reportedPath = firstField(value.file, ["filePath", "path"]);
    if (reportedPath && Buffer.byteLength(reportedPath) <= TOOL_ACTIVITY_LIMITS.maxMetadataBytes)
      path = reportedPath;
    content = optionalStringField(value.file, ["content"]);
  } else if (typeof value === "string") content = value;
  else content = optionalStringField(value, ["content", "output", "stdout", "text"]);
  if (
    (content !== undefined && typeof content !== "string") ||
    (response.present && content === undefined && !responseError(input) && !errorText(value))
  )
    return undefined;
  if (
    typeof content === "string" &&
    Buffer.byteLength(content) > TOOL_ACTIVITY_LIMITS.maxPayloadBytes
  )
    return undefined;
  return {
    fileOperationResult: {
      ...base,
      success: result === "OUTCOME_COMPLETED",
      path,
      ...(content !== undefined ? { content } : {}),
      ...(responseError(input) ? { error: responseError(input) } : {}),
    },
  };
}

export function activityObservation(
  before: WorkspaceActivityEvent & { action: Action },
  input: ActivityInput,
): WorkspaceObservationEvent {
  if (!before.action) throw new Error("activity observation requires a preceding action");
  // One explicit end timestamp is used by the header and duration calculation.
  // Without it, a default header time would leave durationMs absent, and a replay
  // could change the event body independently of the underlying native result.
  const timed: ActivityInput = {
    ...input,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  };
  const observation: Observation = {
    invocation: before.action,
    ...(specializedObservation(before.action, before.occurredAt, timed) ??
      genericObservation(before, timed)),
  };
  // Preserve a supplied after-hook identity; validation will reject a conflicting
  // identity rather than silently rebinding this result to another call.
  const callId = callIdentity(nativeBody(input)).callId || actionCallId(before.action);
  if (observation.toolOutput) observation.toolOutput.callId = callId;
  else if (observation.shellCommandOutput) observation.shellCommandOutput.callId = callId;
  else if (observation.webFetchOutput) observation.webFetchOutput.callId = callId;
  else if (observation.fileOperationResult) observation.fileOperationResult.callId = callId;
  return {
    ...header(input),
    causality: { causationId: before.eventId },
    observation,
  };
}

export function validateActivityEvent(event: any): string[] {
  const errors: string[] = [];
  if (!event || typeof event !== "object") return ["event must be an object"];
  if (typeof event.eventId !== "string" || !event.eventId) errors.push("event_id is required");
  if (typeof event.occurredAt !== "string" || !Number.isFinite(Date.parse(event.occurredAt)))
    errors.push("occurred_at must be a valid timestamp");
  const variants = [event.action, event.observation, event.control].filter((v) => v != null).length;
  if (variants !== 1) errors.push("exactly one event variant is required");
  if (event.control) errors.push("control events are not accepted by the MVP recorder");
  if (event.trajectoryId && event.trajectoryId.length > TOOL_ACTIVITY_LIMITS.maxIdentifierBytes)
    errors.push("trajectory_id exceeds the identifier limit");
  const id = event.action ? actionCallId(event.action) : observationCallId(event.observation);
  if (!id) errors.push("call_id or attempt_id is required");
  if (id && Buffer.byteLength(id) > TOOL_ACTIVITY_LIMITS.maxIdentifierBytes)
    errors.push("call_id exceeds the identifier limit");
  if (event.observation?.invocation) {
    const invoked = actionCallId(event.observation.invocation);
    if (id && invoked !== id) errors.push("observation call_id does not match invocation call_id");
  }
  return errors;
}

function observationCallId(observation: any): string {
  const variants = ["toolOutput", "shellCommandOutput", "webFetchOutput", "fileOperationResult"];
  for (const variant of variants)
    if (observation?.[variant]) return observation[variant].callId || "";
  return "";
}
