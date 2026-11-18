/**
 * Trail.ts：一条请求按消息号收成按插件走的步骤；别的会话的行、web-api/status 不混进来；出错标红；不带对话内容；
 * 回话追溯按消息号或涉及的会话挑到这句回话为止，取满了还没到就算截了。
 * 跑法：bun test ./src7/plugins/journal
 */
import { describe, expect, test } from 'bun:test';
import { LINES, SESSION as S } from './tests/Lines.ts';
import { getNode, getTrail, pickReply } from './Trail.ts';


describe('Trail', () => {
  test('文件归到泳道图的道', () => {
    expect(getNode('src7/plugins/wechat/index.ts:1')).toBe('wechat-kefu');
    expect(getNode('src7/plugins/memory/index.ts:1')).toBe('memory');
    expect(getNode('src7/Tools.ts:129')).toBe('tools');
    expect(getNode('src7/Sessions.ts:348')).toBe('sessions');
  });

  test('按先后收成步骤，不混别的会话和定时事件', () => {
    const trail = getTrail(7, LINES);
    expect(trail.session).toBe(S);
    expect(trail.bot).toBe('助手');
    expect(trail.channel).toBe('http');
    expect(trail.state).toBe('done');
    expect(trail.steps.map((step) => step.node)).toEqual(['web-api', 'bots', 'sessions', 'tools', 'sessions', 'web-api']);
    const names = trail.steps.flatMap((step) => step.rows.map((row) => row.name));
    expect(names).not.toContain('web-api/status');
    expect(names.filter((name) => name === 'Session.loop')).toHaveLength(1);
    expect(trail.ms).toBe(2033);
    expect(trail.steps[2]?.title).toContain('调模型（等了 2.0 秒）');
  });

  test('关键变量的键换成英文，说明表里是原来的中文名', () => {
    const trail = getTrail(7, LINES);
    const facts = trail.steps.flatMap((step) => step.rows.map((row) => row.facts));
    expect(facts).toContainEqual({ role: 'toolResult', tool: 'time', failed: true });
    expect(facts.flatMap((item) => Object.keys(item)).filter((key) => /\p{Script=Han}/u.test(key))).toEqual([]);
    expect(trail.notes).toMatchObject({ role: '角色', tool: '工具', failed: '出错', name: '这一行是哪个函数或事件' });
  });

  test('出错标红；每步不带对话内容，用户原话只在 preview；事件行配人话', () => {
    const trail = getTrail(7, LINES);
    expect(trail.error).toBe(true);
    expect(trail.steps[4]?.error).toBe(true);
    expect(JSON.stringify(trail.steps)).not.toContain('私人内容');
    expect(trail.preview).toBe('私人内容');
    expect(trail.steps[2]?.rows[0]?.listeners).toEqual(['bot-front-desk']);

    //M 事件行的人话（原来 switch 那段改成 if 后照旧）。
    const texts = trail.steps.flatMap((step) => step.rows.map((row) => row.text));
    expect(texts).toContain('收件表记下这条消息');
    expect(texts).toContain('模型要用工具：time');
    expect(texts).toContain('工具 time 给了结果');
    expect(texts).toContain('会话做完了');
  });
});


describe('pickReply', () => {
  test('留这条消息的、涉及会话的行，到这句回话为止', () => {
    const to = 2020;
    const chosen = pickReply(7, [S], to, LINES, 500);
    const ids = chosen.lines.map((line) => line.id);
    expect(ids).toEqual([1, 2, 5, 6, 8, 9, 10, 11, 12]);
    expect(chosen.cut).toBe(false);
  });

  test('取满了、最后一行还没到这句回话：算截了；到了就不算', () => {
    const head = LINES.slice(0, 4);
    expect(pickReply(7, [S], 2033, head, 4).cut).toBe(true);
    expect(pickReply(7, [S], 3, head, 4).cut).toBe(false);
    expect(pickReply(7, [S], 2033, head, 5).cut).toBe(false);
  });
});
