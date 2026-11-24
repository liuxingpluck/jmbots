# AOBB 多开舱看网页（`ztools/aobb-shot`）

纯原生 `bun` + `fetch` 直调本机 **AOBB · 多开舱 HTTP API**（默认 `http://127.0.0.1:30098/api/v1/ai/*`），零旧版 AOBB v1 源码、`tsx` 或历史清单文件依赖。

## 行为与边界

- **连接地址**：优先级 `--base-url` > 环境变量 `AOBB_DOCK_URL` > 默认 `http://127.0.0.1:30098`（仅允许本机回环 HTTP origin）。
- **实例选用**：
  - 默认自动选用多开舱中第一个**已在运行**的浏览器配置；
  - 可用 `--profile <id或名称>` 指定配置（含空格或特殊字符时可用 `b64=<Base64url>`）；
  - 若目标配置未运行或无任何运行中实例，直接清晰报错退出，**绝不擅自启动未授权的外部账号浏览器**。
- **单标签复用**：调用 `/api/v1/ai/instances/:id/navigate`（`reuseOwnTab: true`），只操作该实例的 AI 专属单标签页，绝不劫持用户手动打开的标签页。
- **路径与安全**：目标 URL 须为带端口的 HTTP 回环地址；输出须落在 `docs/开发进度/` 或 `F:/aidata/cache/aobb-shot/` 下的 `.png`（独占写入不覆盖已有文件）。
- **遮罩与文字**：默认开启敏感内容遮罩，`--mask off` 可关闭；`--text` 另存同名可见文字 `.txt`（最多 20 万字）。
- **宽度约束**：`--width <240..3840>` 通过临时页面宽度样式约束排版并在截图后恢复。
- **输出格式**：无论成功或失败，始终输出一行 JSON（`ok`、`out`、`title`、`status`、`profileId`、`pageId`、`ms`、`error` 等）。

## 截桌面全页

```sh
bun ztools/aobb-shot/Aobb_Shot.ts \
  --url http://127.0.0.1:30086/decision-map/ \
  --out docs/开发进度/决策图_桌面.png
```

## 指定多开舱地址与配置

```sh
bun ztools/aobb-shot/Aobb_Shot.ts \
  --base-url http://127.0.0.1:30098 \
  --profile 常用155 \
  --url http://127.0.0.1:30086/decision-map/ \
  --out docs/开发进度/决策图_指定配置.png
```

## 截手机宽度

```sh
bun ztools/aobb-shot/Aobb_Shot.ts \
  --url "http://127.0.0.1:30086/decision-map/?view=mobile&preview=1" \
  --out docs/开发进度/决策图_手机.png \
  --width 390
```

## 点待定项后截图并保存文字

`--click` 接受 CSS 选择器或单个 `data-*` 属性选择器（例如 `button[data-look=mind]`、`[data-msg-id='292']`）。

```sh
bun ztools/aobb-shot/Aobb_Shot.ts \
  --url http://127.0.0.1:30086/decision-map/ \
  --out docs/开发进度/决策图_待定项.png \
  --click .decision-pending --wait-ms 500 --text
```

## 顺序执行滚动、输入和选择

每次截图最多十个动作，按参数顺序执行：

- `--scroll <page 或单个 data 属性选择器> <像素或 bottom>`
- `--type <选择器> <文字>` / `--type-enter <选择器> <文字>`
- `--select <选择器> <选项文字>`（支持 antd Select 与 Segmented）
- `--timing` 在结果 `timings` 中按动作顺序记录每次操作完成后的双 `requestAnimationFrame` 耗时（毫秒）

输入和选项名称含空格、引号或特殊字符时，先用 UTF-8 Base64url 编码并加前缀 `b64=`（`b64=` 表示清空输入）。含百分号编码的 URL 用 `--url-b64` 传递。

```sh
bun ztools/aobb-shot/Aobb_Shot.ts \
  --url http://127.0.0.1:30086/wechat-kefu/ \
  --out F:/aidata/cache/aobb-shot/kefu.png \
  --click "[data-session-index='0']" \
  --type "[data-testid=wechat-kefu-search]" 测试 \
  --scroll "[data-testid=wechat-kefu-sessions]" bottom \
  --timing
```
