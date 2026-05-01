/**
 * iLink HTTP API — 5 endpoints that cover all WeChat Bot messaging.
 */
import crypto from "node:crypto";
import type {
  GetUpdatesReq,
  GetUpdatesResp,
  SendMessageReq,
  SendTypingReq,
  GetConfigResp,
} from "./types.js";

const CHANNEL_VERSION = "weixin-claude-bot/0.1.0";
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;

export type ApiOptions = {
  baseUrl: string;
  token: string;
};

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token: string, body: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    AuthorizationType: "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(body, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };
}

async function post<T>(
  opts: ApiOptions,
  endpoint: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  const url = new URL(endpoint, opts.baseUrl.endsWith("/") ? opts.baseUrl : opts.baseUrl + "/");
  const body = JSON.stringify({ ...payload, base_info: { channel_version: CHANNEL_VERSION } });
  const headers = buildHeaders(opts.token, body);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url.toString(), {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${text}`);
    return JSON.parse(text) as T;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      // Long-poll timeout is expected
      throw err;
    }
    throw err;
  }
}

/** Long-poll for new messages. Returns empty on client-side timeout. */
export async function getUpdates(
  opts: ApiOptions,
  params: GetUpdatesReq,
): Promise<GetUpdatesResp> {
  try {
    return await post<GetUpdatesResp>(
      opts,
      "ilink/bot/getupdates",
      { get_updates_buf: params.get_updates_buf ?? "" },
      DEFAULT_LONG_POLL_TIMEOUT_MS,
    );
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ret: 0, msgs: [], get_updates_buf: params.get_updates_buf };
    }
    throw err;
  }
}

/** Send a message back to a user. */
export async function sendMessage(opts: ApiOptions, body: SendMessageReq): Promise<void> {
  await post(opts, "ilink/bot/sendmessage", body as unknown as Record<string, unknown>, DEFAULT_API_TIMEOUT_MS);
}

/** Send typing indicator. */
export async function sendTyping(opts: ApiOptions, body: SendTypingReq): Promise<void> {
  await post(opts, "ilink/bot/sendtyping", body as unknown as Record<string, unknown>, DEFAULT_API_TIMEOUT_MS);
}

/** Fetch bot config (typing_ticket). */
export async function getConfig(
  opts: ApiOptions,
  ilinkUserId: string,
  contextToken?: string,
): Promise<GetConfigResp> {
  return post<GetConfigResp>(
    opts,
    "ilink/bot/getconfig",
    { ilink_user_id: ilinkUserId, context_token: contextToken },
    DEFAULT_API_TIMEOUT_MS,
  );
}
