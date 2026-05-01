/*
 * WeChat Agent - HTTP API for WeChat messaging.
 *
 * Runs as a background process. Provides HTTP endpoints that Claude Code
 * can call via curl to check and reply to WeChat messages.
 *
 * Usage:
 *   node wechat-agent.js
 *   curl http://localhost:3456/inbox
 *   curl http://localhost:3456/send -X POST -d "{"to":"user_id","text":"hello"}"
 */

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

var PORT = 3456;
var STATE_DIR = path.join(os.homedir(), ".weixin-claude-bot");
var CHANNEL_VERSION = "wechat-agent/0.1.0";

function randomWechatUin() {
  var uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

function buildHeaders(token, body) {
  return {
    "Content-Type": "application/json",
    "Authorization": "Bearer " + token,
    "AuthorizationType": "ilink_bot_token",
    "Content-Length": String(Buffer.byteLength(body, "utf-8")),
    "X-WECHAT-UIN": randomWechatUin(),
  };
}

async function iLinkPost(baseUrl, token, endpoint, payload) {
  var url = new URL(endpoint, baseUrl.endsWith("/") ? baseUrl : baseUrl + "/");
  var body = JSON.stringify(Object.assign({}, payload, {
    base_info: { channel_version: CHANNEL_VERSION },
  }));
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, 35000);
  try {
    var res = await fetch(url.toString(), {
      method: "POST",
      headers: buildHeaders(token, body),
      body: body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    var text = await res.text();
    if (!res.ok) throw new Error(endpoint + " " + res.status + ": " + text);
    return JSON.parse(text);
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

function loadCredentials() {
  var p = path.join(STATE_DIR, "credentials.json");
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (e) {
    return null;
  }
}

function loadSyncBuf() {
  var p = path.join(STATE_DIR, "sync-buf.txt");
  try {
    return fs.readFileSync(p, "utf-8");
  } catch (e) {
    return "";
  }
}

function saveSyncBuf(buf) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(STATE_DIR, "sync-buf.txt"), buf);
}

var messageQueue = [];
var pendingImages = []; // images uploaded via /upload-image
var syncBuf = "";
// Dedup: track message hashes within a 60s window to avoid duplicates from iLink
var recentMessageHashes = new Map();

async function pollMessages(baseUrl, token) {
  try {
    var resp = await iLinkPost(baseUrl, token, "ilink/bot/getupdates", {
      get_updates_buf: syncBuf,
    });
    if (resp.get_updates_buf) {
      syncBuf = resp.get_updates_buf;
      saveSyncBuf(syncBuf);
    }
    var msgs = resp.msgs || [];
    var now = Date.now();
    // Clean old dedup entries (> 60s)
    for (var h of recentMessageHashes) {
      if (now - h[1] > 60000) recentMessageHashes.delete(h[0]);
    }
    for (var i = 0; i < msgs.length; i++) {
      var msg = msgs[i];
      if (msg.message_type === 1) {
        var text = extractText(msg);

        // Check for image message (type 2) - use encryptQueryParam, not url
        var img = extractImage(msg);
        if (!text && img && img.encryptQueryParam) {
          text = "[图片]";
        }

        if (text && msg.from_user_id) {
          // Dedup by from_user + text within 60s window
          var hash = msg.from_user_id + ":" + text;
          if (!recentMessageHashes.has(hash)) {
            recentMessageHashes.set(hash, now);
            var entry = { from: msg.from_user_id, text: text, time: now };
            if (img && img.url) { entry.imageUrl = img.url; }
            // Store image info so autoreply can download via /download-image
            if (img && img.encryptQueryParam) {
              entry.imageKey = img.encryptQueryParam;
            }
            messageQueue.push(entry);
          } else {
            console.log("[agent] Dedup skipped: " + hash.substring(0, 60));
          }
        }
      }
    }
    if (msgs.length > 0) {
      console.log("[agent] Polled " + msgs.length + " messages, queue: " + messageQueue.length);
    }
  } catch (err) {
    if (err.name !== "AbortError") {
      console.error("[agent] Poll error: " + err.message);
    }
  }
}

function extractText(msg) {
  var items = msg.item_list || [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (item.type === 1 && item.text_item && item.text_item.text) {
      return item.text_item.text;
    }
    if (item.type === 4 && item.voice_item && item.voice_item.text) {
      return item.voice_item.text;
    }
  }
  return "";
}

/** Extract image info from a message */
function extractImage(msg) {
  var items = msg.item_list || [];
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (item.type === 2) {
      if (item.image_item) {
        var info = {
          url: "",
          md5: item.image_item.md5 || "",
          aeskey: item.image_item.aeskey || "",
          encryptQueryParam: (item.image_item.media && item.image_item.media.encrypt_query_param) || "",
        };
        return info;
      }
    }
  }
  return null;
}

function createServer(baseUrl, token) {
  var server = http.createServer(function (req, res) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    var url = new URL(req.url, "http://localhost:" + PORT);

    if (url.pathname === "/inbox" && req.method === "GET") {
      var msgs = messageQueue.splice(0, messageQueue.length);
      // Include pending uploaded images
      if (pendingImages.length > 0) {
        var img = pendingImages.shift();
        msgs.push({ from: "upload", text: "[pending-image:" + img.path + "]", time: Date.now() });
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ messages: msgs, count: msgs.length }));
      return;
    }

    if (url.pathname === "/inbox/peek" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ messages: messageQueue, count: messageQueue.length }));
      return;
    }

    if (url.pathname === "/upload-image" && req.method === "POST") {
      var chunks = [];
      req.on("data", function (c) { chunks.push(c); });
      req.on("end", function () {
        try {
          var buf = Buffer.concat(chunks);
          // Extract boundary if multipart
          var ct = req.headers["content-type"] || "";
          var boundary = "";
          var m = ct.match(/boundary=(.+)/);
          if (m) boundary = m[1];

          var imageData = null;
          var fileName = "upload_" + Date.now() + ".jpg";

          if (boundary) {
            // multipart/form-data: parse the first image part
            var parts = buf.toString("binary").split("--" + boundary);
            for (var p of parts) {
              if (p.indexOf("Content-Type: image/") >= 0 || p.indexOf("Content-Type: application/octet-stream") >= 0) {
                var lines = p.split("\r\n\r\n");
                if (lines.length >= 2) {
                  var dataStr = lines.slice(1).join("\r\n\r\n");
                  var dataBuf = Buffer.from(dataStr, "binary");
                  // Strip trailing boundary markers
                  var endIdx = dataBuf.length;
                  for (var j = dataBuf.length - 1; j >= 0; j--) {
                    if (dataBuf[j] !== 45 && dataBuf[j] !== 13 && dataBuf[j] !== 10) { // -, \r, \n
                      endIdx = j + 1;
                      break;
                    }
                  }
                  imageData = dataBuf.slice(0, endIdx);
                }
                break;
              }
            }
          } else {
            // raw binary
            imageData = buf;
          }

          if (imageData && imageData.length > 0) {
            var imgDir = path.join(STATE_DIR, "uploads");
            fs.mkdirSync(imgDir, { recursive: true });
            var fpath = path.join(imgDir, fileName);
            fs.writeFileSync(fpath, imageData);
            pendingImages.push({ path: fpath, time: Date.now(), text: "" });
            console.log("[agent] Uploaded image: " + fileName + " (" + imageData.length + " bytes)");
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ success: true, file: fileName }));
          } else {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "No image data found" }));
          }
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }

    if (url.pathname === "/upload" && req.method === "GET") {
      // Simple HTML upload form
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end('<html><body><h2>Upload Image for Analysis</h2>'
        + '<form action="/upload-image" method="post" enctype="multipart/form-data">'
        + '<input type="file" name="image" accept="image/*" required><br><br>'
        + '<input type="submit" value="Upload">'
        + '</form></body></html>');
      return;
    }

    if (url.pathname === "/send" && req.method === "POST") {
      var body = "";
      req.on("data", function (chunk) { body += chunk; });
      req.on("end", async function () {
        try {
          var data = JSON.parse(body);
          var toUserId = data.to || data.user_id || data.userId;
          var text = data.text || data.message || data.content;
          if (!toUserId || !text) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing to or text" }));
            return;
          }
          await iLinkPost(baseUrl, token, "ilink/bot/sendmessage", {
            msg: {
              to_user_id: toUserId,
              from_user_id: "",
              client_id: "agent-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex"),
              message_type: 2,
              message_state: 2,
              context_token: data.context_token || "",
              item_list: [{ type: 1, text_item: { text: text } }],
            },
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (url.pathname === "/status" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "running",
        queueLength: messageQueue.length,
      }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  return server;
}

async function main() {
  var creds = loadCredentials();
  if (!creds) {
    console.error("[agent] No credentials found");
    process.exit(1);
  }

  syncBuf = loadSyncBuf();
  console.log("[agent] Starting for account: " + creds.accountId);

  var server = createServer(creds.baseUrl, creds.botToken);

  // Poll every 10 seconds
  setInterval(function () {
    pollMessages(creds.baseUrl, creds.botToken).catch(function (err) {
      console.error("[agent] Poll error: " + err.message);
    });
  }, 10000);

  // Initial poll
  setTimeout(function () {
    pollMessages(creds.baseUrl, creds.botToken).catch(function () {});
  }, 1000);

  server.listen(PORT, function () {
    console.log("[agent] HTTP server on http://localhost:" + PORT);
    console.log("[agent] Endpoints:");
    console.log("[agent]   GET  /inbox       - get and clear new messages");
    console.log("[agent]   GET  /inbox/peek  - peek without clearing");
    console.log("[agent]   POST /send        - send a WeChat reply");
    console.log("[agent]   GET  /upload       - image upload form (browser)");
    console.log("[agent]   POST /upload-image - upload image file");
    console.log("[agent]   GET  /status      - health check");
    console.log("[agent] Ready.");
  });
}

main().catch(function (err) {
  console.error("[agent] Fatal: " + err.message);
  process.exit(1);
});
