/**
 * 工具 image_generate：用 engine.image_model 配的“供应商/模型 ID”调 OpenAI 那种 POST <base_url>/images/generations，
 * 拿到第一张图（b64_json 或 url 都认），存成 bots/<机器人>/workspace/<名字>_<20 位时间戳>.png，交回 @绝对路径和大小。
 * 慢工具：骨架给的停止信号和 5 分钟超时合在一起交给 fetch，点了停止马上断开。把图发给用户归渠道（认回话里的 @路径）。
 * 照 0.4 src/capabilities/tools/Tools.ts:636-654、1664-1728。设计：docs/src7插件设计/image-gen.md。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import { safeName, stampId } from '../../utils/Names.ts';


/** 插件名。 */
export const name = 'image-gen';

/** 用到的服务：resources 拿配置；tools 登记工具；bots 找工作区。 */
export const inject = ['resources', 'tools', 'bots'];


/** 校验后的生图模型。 */
interface ImageModel {
  /** 原样的“供应商/模型 ID”，跟踪用。 */
  name: string;
  /** <baseUrl>/images/generations。 */
  url: string;
  /** 密钥；空串时发 no-key。 */
  apiKey: string;
  /** 斜杠后面整段。 */
  model: string;
}


/** 一次最多等多久（照 0.4）。 */
const TIMEOUT_MS = 5 * 60_000;


/**
 * 读 engine.image_model：没写交回 undefined（调的时候说没配）；写错了抛错，插件不开工。
 * @param engine ctx.resources.raw.engine。
 * @param providers 骨架校验过的供应商。
 */
function readModel(engine: unknown, providers: Record<string, { baseUrl: string; apiKey: string }>): ImageModel | undefined {
  const value = (engine as Record<string, unknown> | undefined)?.['image_model'];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !value.includes('/')) throw new Error('engine.image_model 要写成“供应商/模型 ID”');
  const provider = value.slice(0, value.indexOf('/'));
  const written = providers[provider];
  if (written === undefined) throw new Error(`engine.image_model 里的供应商 ${provider} 在 providers 里找不到`);
  return { name: value, url: `${written.baseUrl}/images/generations`, apiKey: written.apiKey === '' ? 'no-key' : written.apiKey, model: value.slice(provider.length + 1) };
}

/** 大小（照 0.4 formatSize）。 */
function size(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}


/** 生图工具。 */
class ImageGen {
  /**
   * 登记 image_generate（没配模型也登记，调的时候说没配，模型能转告用户）。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param model 校验后的生图模型；没配是 undefined。
   */
  constructor(private readonly ctx: cordis.Context, private readonly model: ImageModel | undefined) {
    //M tools.register：登记给 work 会话；骨架调 run(参数, 会话, 停止信号)。
    ctx.tools.register({
      definition: {
        name: 'image_generate',
        description: '生图：照提示词生一张图，存进工作区，返回 @路径（要发给用户就在 reply 里写上这个 @路径）。人物要前后一致就在提示词里把外貌写死。'
          + '生一张要半分钟上下。没配 engine.image_model 时用不了。',
        parameters: piAi.Type.Object({
          prompt: piAi.Type.String({ description: '要画什么' }),
          size: piAi.Type.Optional(piAi.Type.String({ description: '尺寸：1024x1024（默认）、1024x1536（竖）、1536x1024（横）' })),
          background: piAi.Type.Optional(piAi.Type.Union([piAi.Type.Literal('auto'), piAi.Type.Literal('transparent'), piAi.Type.Literal('opaque')], { description: '背景，默认 auto' })),
          name: piAi.Type.Optional(piAi.Type.String({ description: '文件名，不带扩展名；不写用提示词前 20 字' })),
        }),
      },
      kinds: ['work'],
      run: (args, session, signal) => this.generate(args, session, signal),
    });
  }

  /** 调接口、取第一张、存文件。 */
  private async generate(args: Record<string, unknown>, session: Session, signal: AbortSignal): Promise<string> {
    const model = this.model;
    if (model === undefined) throw new Error('没配生图模型 engine.image_model（写成“供应商/模型 ID”，到设置的“引擎”里填），生不了图');
    const workspace = this.ctx.bots.get(session.row.bot)?.workspace;
    if (workspace === undefined) throw new Error(`没有这个机器人：${session.row.bot}`);
    const prompt = String(args['prompt']);
    const body = {
      model: model.model, prompt, n: 1, size: (args['size'] as string | undefined) ?? '1024x1024',
      background: (args['background'] as string | undefined) ?? 'auto', output_format: 'png',
    };
    //T 跟踪：发请求前。
    this.ctx.emit('trace', 'ImageGen.generate', '发生图请求', 'fetch(images/generations)', { 模型: model.name, 尺寸: body.size, 背景: body.background, 提示词: prompt.slice(0, 40) });

    //G 停止信号和 5 分钟超时合成一个：哪个先到都断开 fetch（被停下时 fetch 抛 AbortError，骨架把它记成工具出错）。
    const limit = (): AbortSignal => AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]);
    const response = await fetch(model.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${model.apiKey}`, 'x-api-key': model.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: limit(),
    });
    if (!response.ok) {
      const text = (await response.text()).slice(0, 300).replaceAll(model.apiKey, '***');
      throw new Error(`生图失败（HTTP ${String(response.status)}）：${text}`);
    }
    const first = ((await response.json()) as { data?: { b64_json?: string; url?: string }[] }).data?.[0];
    let bytes: Buffer;
    if (typeof first?.b64_json === 'string' && first.b64_json !== '') {
      bytes = Buffer.from(first.b64_json, 'base64');
    } else if (typeof first?.url === 'string' && first.url !== '') {
      const image = await fetch(first.url, { signal: limit() });
      if (!image.ok) throw new Error(`生图接口给了地址，但下载失败（HTTP ${String(image.status)}）`);
      bytes = Buffer.from(await image.arrayBuffer());
    } else {
      throw new Error('生图接口回了，但里面没有图');
    }
    const named = typeof args['name'] === 'string' && args['name'] !== '' ? args['name'] : prompt.slice(0, 20);
    const file = path.join(workspace, `${safeName(named)}_${stampId()}.png`);
    fs.writeFileSync(file, bytes);
    //T 跟踪：存好。
    this.ctx.emit('trace', 'ImageGen.generate', '存好了', 'fs.writeFileSync', { 文件: file, 大小: size(bytes.length) });
    return `已生成：@${file}（${size(bytes.length)}）。要发给用户就在 reply 里写上这个 @路径。`;
  }
}


/**
 * 挂上生图工具。
 * apply 是 Cordis 插件的入口：inject 里的服务都就绪后调一次。engine.image_model 在这里读一次、校验一次（改了要重启）。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context): void {
  new ImageGen(ctx, readModel(ctx.resources.raw['engine'], ctx.resources.config.providers));
}
