// main.ts - chatgptfree.ai API 服务 (Deno Deploy)
// 环境变量: API_KEY, COOKIE, AJAX_NONCE, SESSION_ID, POST_ID, DEBUG

// ==================== 配置区域 (修改此处) ====================

// API认证密钥（可选，留空则无需认证）
const API_KEY = Deno.env.get("API_KEY") || null;

// chatgptfree.ai 网站认证（必需）
const COOKIE = Deno.env.get("COOKIE") || "";
const AJAX_NONCE = Deno.env.get("AJAX_NONCE") || "";
const SESSION_ID = Deno.env.get("SESSION_ID") || "";
const POST_ID = Deno.env.get("POST_ID") || "";

// 调试模式（默认开启）
const DEBUG = Deno.env.get("DEBUG") !== "false";

// 模型映射
const MODEL_IDS: Record<string, string> = {
  "gpt-4o-mini": "25865",
  "gpt-5-nano": "25871",
  "gemini-2.5-pro": "25874",
  "deepseek-v3": "25873",
  "claude-3.5-sonnet": "25875",
  "grok-3": "25872",
  "meta-llama-3": "25870",
  "qwen3-max": "25869",
};

// ==================== 核心代码  ====================

const sessions = new Map<string, { responseId: string | null; convUuid: string }>();
const models = Object.keys(MODEL_IDS);

function log(...args: any[]) {
  if (DEBUG) console.log(...args);
}

async function auth(req: Request) {
  if (!API_KEY) return;
  const auth = req.headers.get("Authorization");
  if (!auth) throw new Error("认证失败：缺少认证头");
  const [scheme, token] = auth.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || token !== API_KEY) {
    throw new Error("认证失败：无效的API密钥");
  }
}

class Provider {
  headers(stream: boolean): Record<string, string> {
    const h: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      "Referer": "https://chatgptfree.ai/",
      "Origin": "https://chatgptfree.ai",
      "Cookie": COOKIE,
    };
    if (stream) h["Accept"] = "text/event-stream";
    return h;
  }

  async getCacheKey(data: any, botId: string): Promise<string> {
    const msg = data.messages?.slice().reverse().find((m: any) => m.role === "user")?.content || "";
    if (!msg) throw new Error("缺少用户消息");

    const form = new FormData();
    form.append("action", "aipkit_cache_sse_message");
    form.append("message", msg);
    form.append("_ajax_nonce", AJAX_NONCE);
    form.append("bot_id", botId);
    form.append("user_client_message_id", `aipkit-client-msg-${botId}-${Date.now()}-${crypto.randomUUID().slice(0, 5)}`);

    const res = await fetch("https://chatgptfree.ai/wp-admin/admin-ajax.php", {
      method: "POST",
      headers: this.headers(false),
      body: form,
    });

    if (!res.ok) throw new Error(`获取cache_key失败: ${res.status}`);
    const json = await res.json();
    if (json.success && json.data?.cache_key) return json.data.cache_key;
    throw new Error("cache_key无效");
  }

  async *stream(cacheKey: string, botId: string, convUuid: string, prevId: string | null, webSearch: boolean) {
    const params = new URLSearchParams({
      action: "aipkit_frontend_chat_stream",
      cache_key: cacheKey,
      bot_id: botId,
      session_id: SESSION_ID,
      conversation_uuid: convUuid,
      post_id: POST_ID,
      _ts: Date.now().toString(),
      _ajax_nonce: AJAX_NONCE,
    });
    if (prevId) params.append("previous_openai_response_id", prevId);
    if (webSearch) params.append("frontend_web_search_active", "true");

    const res = await fetch(`https://chatgptfree.ai/wp-admin/admin-ajax.php?${params}`, {
      headers: this.headers(true),
    });

    if (!res.ok) throw new Error(`流式请求失败: ${res.status}`);
    
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        
        if (buf.endsWith("\n\n")) {
          for (const event of buf.trim().split("\n\n")) {
            if (!event) continue;
            let type = "message";
            const data: string[] = [];
            for (const line of event.split("\n")) {
              if (line.startsWith("event:")) type = line.slice(6).trim();
              else if (line.startsWith("data:")) data.push(line.slice(5).trim());
            }
            const str = data.join("");
            if (type === "openai_response_id" && str) {
              try { yield { type: "id", data: JSON.parse(str).id }; } catch {}
            } else if (str && str !== "[DONE]") {
              try {
                const content = JSON.parse(str).delta;
                if (typeof content === "string") yield { type: "content", data: content };
              } catch {}
            }
          }
          buf = "";
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async chat(data: any): Promise<Response> {
    let temp = false;
    let convId = data.conversation_id;

    try {
      if (!convId) {
        temp = true;
        convId = crypto.randomUUID();
        sessions.set(convId, { responseId: null, convUuid: crypto.randomUUID() });
        log(`创建临时会话: ${convId}`);
      } else if (!sessions.has(convId)) {
        throw new Error(`无效会话ID: ${convId}`);
      }

      const session = sessions.get(convId)!;
      const model = data.model!;
      if (!MODEL_IDS[model]) throw new Error(`不支持模型: ${model}`);
      const botId = MODEL_IDS[model];

      log(`会话: ${convId}, 模型: ${model}`);
      const cacheKey = await this.getCacheKey(data, botId);
      const stream = data.stream || false;
      const gen = this.stream(cacheKey, botId, session.convUuid, session.responseId, data.web_search || false);
      const chatId = `chatcmpl-${crypto.randomUUID().replace(/-/g, "")}`;
      const created = Math.floor(Date.now() / 1000);

      if (stream) {
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        (async () => {
          let content = "";
          let newId: string | null = null;
          try {
            await writer.write(encoder.encode(`data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`));
            for await (const chunk of gen) {
              if (chunk.type === "content") {
                content += chunk.data;
                await writer.write(encoder.encode(`data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: { content: chunk.data }, finish_reason: null }] })}\n\n`));
              } else if (chunk.type === "id") {
                newId = chunk.data;
              }
            }
            if (newId && !temp) sessions.set(convId!, { ...session, responseId: newId });
            await writer.write(encoder.encode(`data: ${JSON.stringify({ id: chatId, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
          } finally {
            writer.close();
          }
        })();

        return new Response(readable, { headers: { "Content-Type": "text/event-stream" } });
      } else {
        let content = "";
        let newId: string | null = null;
        for await (const chunk of gen) {
          if (chunk.type === "content") content += chunk.data;
          else if (chunk.type === "id") newId = chunk.data;
        }
        if (newId && !temp) sessions.set(convId!, { ...session, responseId: newId });
        return new Response(JSON.stringify({ id: chatId, object: "chat.completion", created, model, choices: [{ index: 0, message: { role: "assistant", content: content.trim() }, finish_reason: "stop" }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } }), { headers: { "Content-Type": "application/json" } });
      }
    } catch (e: any) {
      log(`聊天错误: ${e.message}`);
      throw new Error(`聊天失败: ${e.message}`);
    } finally {
      if (temp && convId) {
        sessions.delete(convId);
        log(`清理临时会话: ${convId}`);
      }
    }
  }
}

const provider = new Provider();

Deno.serve(async (req) => {
  const { pathname, method } = new URL(req.url);
  try {
    if (pathname === "/" && method === "GET") return new Response(JSON.stringify({ message: "FreeAIchat API" }), { headers: { "Content-Type": "application/json" } });
    if (pathname === "/v1/conversations" && method === "POST") {
      await auth(req);
      const id = crypto.randomUUID();
      sessions.set(id, { responseId: null, convUuid: crypto.randomUUID() });
      log(`创建会话: ${id}`);
      return new Response(JSON.stringify({ conversation_id: id }), { headers: { "Content-Type": "application/json" } });
    }
    if (pathname === "/v1/chat/completions" && method === "POST") {
      await auth(req);
      return await provider.chat(await req.json());
    }
    if (pathname === "/v1/models" && method === "GET") {
      await auth(req);
      const created = Math.floor(Date.now() / 1000);
      return new Response(JSON.stringify({ object: "list", data: models.map(id => ({ id, object: "model", created, owned_by: "system" })) }), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("Not Found", { status: 404 });
  } catch (e: any) {
    log(`错误: ${e.message}`);
    const status = e.message.includes("认证") ? 401 : e.message.includes("不支持") || e.message.includes("无效") ? 400 : 500;
    return new Response(JSON.stringify({ error: e.message }), { status });
  }
});
