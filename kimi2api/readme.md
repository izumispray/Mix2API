# Kimi API Proxy
data: {
  "id": "chatcmpl-123",
  "object": "chat.completion.chunk",
  "created": 1677652288,
  "model": "k2",
  "choices": [{
    "index": 0,
    "delta": {
      "content": "你好"
    },
    "finish_reason": null
  }]
}
```

以 `data: [DONE]` 结束。

## 错误处理

常见错误响应：

```json
{
  "error": {
    "message": "错误描述",
    "type": "error_type"
  }
}
```

常见错误码：
- `401` - 认证失败或无可用 token
- `404` - 模型未找到或路由不存在
- `500` - 服务器内部错误

## 部署说明

### 本地开发

```bash
deno run --allow-net --allow-env kimi-proxy.ts
```

### 生产部署

建议使用 PM2 或 systemd 管理进程：

```bash
# 使用 PM2
pm2 start --interpreter="deno" --name="kimi-proxy" -- run --allow-net --allow-env kimi-proxy.ts

# 使用 systemd
sudo nano /etc/systemd/system/kimi-proxy.service
```

### Docker 部署

```dockerfile
FROM denoland/deno:alpine

WORKDIR /app
COPY kimi-proxy.ts .

EXPOSE 8000

CMD ["run", "--allow-net", "--allow-env", "kimi-proxy.ts"]
```

## 故障排除

### 常见问题

1. **无可用 tokens 错误**
   - 检查 `KIMI_TOKENS` 环境变量是否设置正确
   - 确认 tokens 有效且未过期
```
