---
name: dsh-control
description: 把一件活交给 Windows 上的 DSH（另一个 AI 执行端）去做：在 Windows 上跑命令、编译、测试、改文件。用 exec 跑本技能的 scripts/dsh.mjs，交任务书、等结果、喊停。
---

# dsh-control：把活交给 DSH

DSH 是 Windows 上的另一个 AI 执行端，有自己的工作区、模型和子代理。要在 Windows 上跑命令、编译、测试，或者整块的活想让别的模型做，就用这个技能。

读这份说明不会跑任何东西。要交活，自己用 **exec** 显式跑 `scripts/dsh.mjs`。

## 跑之前

- 工作目录就是你的工作区（exec 默认的目录），**不要 cd 到别处**。脚本只认 `settings.json` 里登记过的工作区，别的目录回 `workspace_mismatch`。
- `settings.json` 和本文件在同一个目录；没有它回 `configuration_missing`，告诉用户照 `settings.example.json` 写一份。
- 运行时用 `node`（22.19 以上）；没有 node 就用 `bun`，写法一样。
- 下面的 `<技能目录>` 是技能清单里这份 SKILL.md 所在的目录。

## 步骤

1. **定任务号**：一件活一个号，字母、数字、`.` `_` `-`，比如 `build-0717`。同一个号接着用同一场 DSH 会话；换模型、换档就换个号。
2. **定模型**：
   ```
   node "<技能目录>/scripts/dsh.mjs" models
   ```
   回 DSH 能用的模型（`供应商/模型 ID`）和各自的档位，`second` 是次高档。用户或任务指定了模型就用指定的；DSH 没有就如实说，**不换别的模型，尤其不换付费的**。
3. **写任务书**：写进工作区里的一个文件（比如 `.dispatch/<任务号>/task.md`）。写清：在哪个目录、做什么、可以改哪些文件、怎么算做完、要交回什么。要开子代理就写明每个子代理负责什么、用什么模型和档。
4. **交出去**：
   ```
   node "<技能目录>/scripts/dsh.mjs" send --task <任务号> --text-file <任务书> --model <供应商/模型> [--effort <档>] [--wait-ms 600000]
   ```
   - `--effort` 不写取这个模型的次高档；
   - `--wait-ms` 不写照 `settings.json` 的 `waitMs`；写了 exec 的 `timeout`（秒）要比它多一两分钟，比如等 600000 毫秒就写 `timeout: 720`；
   - 接着同一件补话：同一个任务号再 send 一份新的任务书，不用再写 `--model`；正在跑时要插话加 `--steer`。
5. **看结果**：
   ```
   node "<技能目录>/scripts/dsh.mjs" status --task <任务号> [--wait-ms 600000]
   ```
6. **喊停**（前台要暂停时）：
   ```
   node "<技能目录>/scripts/dsh.mjs" cancel --task <任务号>
   ```

## 输出

每次打一份 JSON，先看 `state`：

| state | 意思 | 接着做什么 |
| --- | --- | --- |
| `accepted` | DSH 收下了（不代表子代理已经开了） | 过会儿 `status` |
| `running` | 等到时候了还在做 | 再 `status --wait-ms …`，**不要重发** |
| `needs_input` | DSH 在等人回答问题或等审批，`waiting` 里是问题 | 不代答；把问题交给前台问用户 |
| `completed` | 做完了 | 看 `summary`、`subagents`、`artifacts`、`verification`、`remaining`；全文在 `replyFile` |
| `failed` | 没做成，或者参数、配置不对 | 看 `error`、`summary` |
| `capability_missing` | DSH 没有这个模型或档位，或它说开不了子代理 | 如实交回，不换模型 |
| `unknown` | 说不清交没交上、建没建成 | 看 `error.message`；**原样重发同一份任务书**会沿用原来的 requestId，DSH 不会派两次 |
| `stopped` | 停下了 | 已经做了的不回滚 |
| `pause_unconfirmed` | 喊了停，但确认不了停妥 | 过会儿 `status` 再看 |

- `actualModel`、`actualThinking` 是 DSH 记的实际用的；`subagents` 是 DSH 自己报的，报不出来是 `unknown`。交回时照实写，不拿要求的值冒充实际的。
- 记录在工作区的 `.dispatch/<任务号>/`：`dsh.json`（会话号、requestId）、每次发的正文、每轮的回复全文。

## 不做的

- 不往 settings.json 没登记的工作区派活。
- 不读、不打印 DSH 的地址和令牌：它们在 DSH 客户端自己的 `.env` 里，脚本只调客户端。
- DSH 说开不了子代理、没有指定的模型，就交 `capability_missing`，不拿多个普通会话冒充子代理。
