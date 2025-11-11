// --- 类型定义 ---
interface ModelCard {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
}

interface ModelList {
  object: "list";
  data: ModelCard[];
}

interface Message {
  role: string;
  content: string;
}

interface ChatCompletionRequest {
  model: string;
  messages: Message[];
  stream?: boolean;
}

interface ChatCompletionResponseChoice {
  index: number;
  message: Message;
  finish_reason?: string;
}

interface ChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: ChatCompletionResponseChoice[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface DeltaMessage {
  role?: string;
  content?: string;
}

interface ChatCompletionStreamResponseChoice {
  index: number;
  delta: DeltaMessage;
  finish_reason?: string;
}

interface ChatCompletionStreamResponse {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: ChatCompletionStreamResponseChoice[];
}

// --- 日志系统 ---
const DEBUG = Deno.env.get("DEBUG") !== "false"; // 默认 true

function log(...args: any[]) {
  if (DEBUG) {
    console.log(`[${new Date().toISOString()} DEBUG]`, ...args);
  }
}

function error(...args: any[]) {
  console.error(`[${new Date().toISOString()} ERROR]`, ...args);
}

// --- 配置和初始化 ---
const KIMI_TOKENS_STR = Deno.env.get("KIMI_TOKENS") || "ey1,ey2,your-token";
const KIMI_TOKENS = KIMI_TOKENS_STR.split(",").map(t => t.trim()).filter(t => t);

const DEFAULT_AUTHKEYS_STR = Deno.env.get("DEFAULT_AUTHKEYS") || "sk-default,sk-false";
const DEFAULT_AUTHKEYS = DEFAULT_AUTHKEYS_STR.split(",").map(t => t.trim()).filter(t => t);

log("系统初始化:");
log("- DEFAULT_AUTHKEYS:", DEFAULT_AUTHKEYS);
log("- KIMI_TOKENS 数量:", KIMI_TOKENS.length);
log("- Debug 模式:", DEBUG);

if (KIMI_TOKENS.length === 0) {
  log("警告: KIMI_TOKENS 环境变量未设置或为空");
}

// Token池管理器
class TokenPool {
  private tokens: string[] = [];
  private index = 0;
  private lock = new AsyncLock();

  constructor(tokens: string[], private name: string = "unnamed") {
    this.tokens = tokens;
    log(`创建TokenPool: ${name}, tokens数量: ${tokens.length}`);
  }

  async getNextToken(): Promise<string | null> {
    if (this.tokens.length === 0) {
      log(`TokenPool ${this.name} 为空`);
      return null;
    }

    await this.lock.acquire();
    try {
      const token = this.tokens[this.index];
      this.index = (this.index + 1) % this.tokens.length;
      log(`从TokenPool ${this.name} 获取token (索引: ${this.index})`);
      return token;
    } finally {
      this.lock.release();
    }
  }

  isEmpty(): boolean {
    return this.tokens.length === 0;
  }
}

// 创建默认token池
const defaultTokenPool = new TokenPool(KIMI_TOKENS, "default");

// 会话存储
const conversationStorage = new Map<string, string>();
const conversationLock = new AsyncLock();

// --- Kimi 模型映射 ---
const KIMI_MODEL_MAPPING: Record<string, { model: string; use_search: boolean }> = {
  k2: { model: "k2", use_search: true },
  "k1.5": { model: "k1.5", use_search: true },
};

// --- 异步锁实现 ---
class AsyncLock {
  private queue: (() => void)[] = [];
  private locked = false;

  async acquire() {
    if (!this.locked) {
      this.locked = true;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.locked = true;
  }

  release() {
    this.locked = false;
    const next = this.queue.shift();
    if (next) next();
  }
}

// --- 核心辅助函数 ---

/**
 * 根据Authorization头决定使用哪个TokenPool
 */
function getTokenPool(authHeader: string | null): TokenPool {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    log("无有效Authorization头，使用默认TokenPool");
    return defaultTokenPool;
  }

  const bearerToken = authHeader.slice(7).trim(); // 移除 "Bearer "
  const requestTokens = bearerToken.split(",").map(t => t.trim()).filter(t => t);
  
  log(`请求提供的tokens: [${requestTokens.map(t => t.substring(0, 10) + "...").join(", ")}]`);

  // 检查是否匹配默认auth key
  const isDefaultAuth = requestTokens.some(token => DEFAULT_AUTHKEYS.includes(token));
  
  if (isDefaultAuth) {
    log("匹配到DEFAULT_AUTHKEYS，使用环境变量中的KIMI_TOKENS");
    return defaultTokenPool;
  } else {
    log("使用用户提供的自定义tokens");
    return new TokenPool(requestTokens, "user-provided");
  }
}

async function createKimiChatSession(token: string): Promise<string> {
  log(`创建Kimi会话，Token: ${token.substring(0, 15)}...`);
  
  const url = "https://www.kimi.com/api/chat";
  const headers = getCommonHeaders(token);
  const payload = {
    name: "未命名会话",
    born_from: "home",
    kimiplus_id: "kimi",
    is_example: false,
    source: "web",
    tags: [],
  };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      error(`创建会话失败: ${response.status} ${response.statusText}, 响应: ${errorText}`);
      throw new Error(`创建对话失败: ${response.status}`);
    }

    const data = await response.json();
    const chatId = data.id;
    
    if (!chatId) {
      error(`创建会话失败，响应无ID: ${JSON.stringify(data)}`);
      throw new Error("创建对话失败，响应无ID");
    }

    log(`成功创建会话: ${chatId}`);
    return chatId;
  } catch (err) {
    error("创建Kimi会话异常:", err);
    throw new Error("Failed to create Kimi chat session.");
  }
}

function getCommonHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
    "Content-Type": "application/json",
  };
}

// --- 流式请求处理 ---
async function* streamGenerator(
  kimiChatId: string,
  request: ChatCompletionRequest,
  kimiToken: string,
): AsyncGenerator<string> {
  log(`开始流式生成 - 模型: ${request.model}, 会话: ${kimiChatId}`);
  
  const modelConfig = KIMI_MODEL_MAPPING[request.model];
  if (!modelConfig) {
    throw new Error(`模型 '${request.model}' 未找到`);
  }

  const userMessage = [...request.messages].reverse().find((msg) => msg.role === "user");
  if (!userMessage) {
    throw new Error("未找到用户消息");
  }

  const kimiPayload = {
    model: modelConfig.model,
    use_search: modelConfig.use_search,
    messages: [{ role: "user", content: userMessage.content }],
    kimiplus_id: "kimi",
    extend: { sidebar: true },
    refs: [],
    history: [],
    scene_labels: [],
    use_semantic_memory: false,
    use_deep_research: false,
  };

  const completionUrl = `https://www.kimi.com/api/chat/${kimiChatId}/completion/stream`;
  const headers = getCommonHeaders(kimiToken);

  let buffer = "";
  const decoder = new TextDecoder();

  try {
    log(`发送请求到: ${completionUrl}`);
    const response = await fetch(completionUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(kimiPayload),
    });

    if (!response.ok) {
      const errorText = await response.text();
      error(`Kimi API响应错误: ${response.status}, 详情: ${errorText}`);
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    if (!response.body) {
      error("Kimi API响应体为空");
      throw new Error("Response body is null");
    }

    log("开始接收流式响应...");
    const reader = response.body.getReader();
    let chunkCount = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        log(`流式响应结束，共接收 ${chunkCount} 个chunk`);
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      while (buffer.includes("\n\n")) {
        const [message, rest] = buffer.split("\n\n", 2);
        buffer = rest;

        let dataStr = "";
        for (const line of message.split("\n")) {
          if (line.startsWith("data:")) {
            dataStr = line.slice(5).trim();
          }
        }

        if (!dataStr) continue;
        
        if (dataStr === "[DONE]") {
          log("收到[DONE]标记，流结束");
          const finalChunk: ChatCompletionStreamResponse = {
            id: kimiChatId,
            model: request.model,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
          };
          yield `data: ${JSON.stringify(finalChunk)}\n\n`;
          yield `data: [DONE]\n\n`;
          return;
        }

        try {
          const dataJson = JSON.parse(dataStr);
          if (dataJson.event === "cmpl") {
            const content = dataJson.text || "";
            if (content) {
              chunkCount++;
              const chunk: ChatCompletionStreamResponse = {
                id: kimiChatId,
                model: request.model,
                object: "chat.completion.chunk",
                created: Math.floor(Date.now() / 1000),
                choices: [
                  {
                    index: 0,
                    delta: { content },
                  },
                ],
              };
              yield `data: ${JSON.stringify(chunk)}\n\n`;
            }
          }
        } catch (e) {
          log(`解析chunk失败: ${dataStr}, 错误: ${e.message}`);
          continue;
        }
      }
    }
  } catch (err) {
    error("流式生成器异常:", err);
    const errorData = {
      error: {
        message: "流式代理发生内部错误",
        type: "proxy_error",
      },
    };
    yield `data: ${JSON.stringify(errorData)}\n\n`;
    yield `data: [DONE]\n\n`;
  }
}

async function processChatRequest(
  request: ChatCompletionRequest,
  kimiChatId: string,
  kimiToken: string,
): Promise<Response> {
  log(`处理聊天请求 - 模型: ${request.model}, 流式: ${request.stream}`);
  
  if (!KIMI_MODEL_MAPPING[request.model]) {
    return new Response(JSON.stringify({ error: `模型 '${request.model}' 未找到` }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (request.stream) {
    log("创建流式响应");
    const body = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of streamGenerator(kimiChatId, request, kimiToken)) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        } catch (err) {
          error("流处理错误:", err);
          controller.error(err);
        }
      },
    });

    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } else {
    log("创建非流式响应");
    let fullContent = "";
    let chunkCount = 0;
    
    try {
      for await (const chunk of streamGenerator(kimiChatId, request, kimiToken)) {
        if (chunk.trim() === "data: [DONE]") break;
        if (chunk.startsWith("data:")) {
          const dataStr = chunk.slice(5).trim();
          if (!dataStr) continue;
          try {
            const dataJson = JSON.parse(dataStr);
            if (dataJson.error) {
              throw new Error(dataJson.error.message);
            }
            const content = dataJson.choices?.[0]?.delta?.content;
            if (content) {
              fullContent += content;
              chunkCount++;
            }
          } catch (e) {
            log(`解析chunk失败: ${e.message}`);
            continue;
          }
        }
      }
      log(`非流式响应完成，共处理 ${chunkCount} 个chunk`);
    } catch (err) {
      error("非流式处理错误:", err);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }

    const response: ChatCompletionResponse = {
      id: kimiChatId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: request.model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: fullContent },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };

    return new Response(JSON.stringify(response), {
      headers: { "Content-Type": "application/json" },
    });
  }
}

// --- API 端点 ---
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;
  
  log(`=== 新请求: ${req.method} ${path} ===`);

  // CORS 预检
  if (req.method === "OPTIONS") {
    log("处理CORS预检请求");
    return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "*",
      },
    });
  }

  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  };

  try {
    // 获取Token池
    const authHeader = req.headers.get("Authorization");
    log(`Authorization头: ${authHeader ? authHeader.substring(0, 20) + "..." : "无"}`);
    
    const tokenPool = getTokenPool(authHeader);
    if (tokenPool.isEmpty()) {
      error("没有可用的tokens");
      return new Response(JSON.stringify({ error: "没有可用的tokens" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (path === "/v1/models" && req.method === "GET") {
      log("处理 /v1/models 请求");
      const models: ModelList = {
        object: "list",
        data: Object.keys(KIMI_MODEL_MAPPING).map((id) => ({
          id,
          object: "model",
          created: Math.floor(Date.now() / 1000),
          owned_by: "kimi.ai",
        })),
      };
      return Response.json(models, { headers: corsHeaders });
    }

    if (path === "/v1/chat/completions" && req.method === "POST") {
      log("处理 /v1/chat/completions 请求");
      const body = await req.json();
      const request: ChatCompletionRequest = body;
      
      log(`请求内容 - 模型: ${request.model}, 流式: ${request.stream}, 消息数: ${request.messages.length}`);

      const kimiToken = await tokenPool.getNextToken();
      if (!kimiToken) {
        error("无法获取有效token");
        return new Response(JSON.stringify({ error: "无法获取有效token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      
      log(`使用token: ${kimiToken.substring(0, 15)}...`);
      const kimiChatId = await createKimiChatSession(kimiToken);
      const result = await processChatRequest(request, kimiChatId, kimiToken);

      // 合并 CORS 头
      Object.entries(corsHeaders).forEach(([key, value]) => {
        result.headers.set(key, value);
      });
      return result;
    }

    if (path.startsWith("/v1/chat/completions/") && req.method === "POST") {
      const conversationId = path.split("/")[3];
      log(`处理有状态请求，会话ID: ${conversationId}`);
      
      const body = await req.json();
      const request: ChatCompletionRequest = body;

      const kimiToken = await tokenPool.getNextToken();
      if (!kimiToken) {
        error("无法获取有效token");
        return new Response(JSON.stringify({ error: "无法获取有效token" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      await conversationLock.acquire();
      let kimiChatId: string;
      try {
        if (!conversationStorage.has(conversationId)) {
          log(`创建新会话存储: ${conversationId}`);
          kimiChatId = await createKimiChatSession(kimiToken);
          conversationStorage.set(conversationId, kimiChatId);
        } else {
          kimiChatId = conversationStorage.get(conversationId)!;
          log(`使用已有会话: ${conversationId} -> ${kimiChatId}`);
        }
      } finally {
        conversationLock.release();
      }

      const result = await processChatRequest(request, kimiChatId, kimiToken);

      // 合并 CORS 头
      Object.entries(corsHeaders).forEach(([key, value]) => {
        result.headers.set(key, value);
      });
      return result;
    }

    log(`未找到路由: ${path}`);
    return new Response(JSON.stringify({ error: "Not Found" }), {
      status: 404,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (err) {
    error("请求处理错误:", err);
    return new Response(
      JSON.stringify({
        error: {
          message: err.message || "Internal server error",
          type: "internal_error",
        },
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }
}

// --- 启动服务器 ---
console.log("=== Kimi API Proxy 启动 ===");
console.log(`环境: ${DEBUG ? "Debug" : "Production"}`);
console.log(`默认AuthKeys: ${DEFAULT_AUTHKEYS.join(", ")}`);
console.log(`可用Token数: ${KIMI_TOKENS.length}`);
console.log("============================");
Deno.serve(handleRequest);
