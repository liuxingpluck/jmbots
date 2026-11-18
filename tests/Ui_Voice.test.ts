/** 聊天页语音按钮、字幕样式和 AudioWorklet 帧格式的离线测试。 */

import { expect, test } from 'bun:test';
import * as antd from 'antd';
import * as react from 'react';
import * as domServer from 'react-dom/server';
import * as i18n from '../web/src/I18n.ts';
import * as view from '../web/src/Chat/VoiceBar.tsx';
import * as pcm from '../web/src/Chat/VoicePcm.ts';
import * as playbackModule from '../web/src/Chat/VoicePlayback.ts';

function render(active: boolean): string {
  const child = react.createElement(view.VoiceBarView, {
    phase: active && 'listening' || 'idle',
    partial: active && '还在说' || '',
    finals: [{ seq: 1, text: '第一句' }],
    tasks: [
      { taskId: 'task-one', text: '查一下天气', merged: false },
      { taskId: 'task-two', text: '再看周末', merged: true },
    ],
    available: true,
    toggle: () => {},
    t: i18n.source,
  });
  const dark = { algorithm: antd.theme.darkAlgorithm };
  const wrapped = react.createElement(antd.ConfigProvider, { theme: dark }, child);
  return domServer.renderToStaticMarkup(wrapped);
}

test('聊天页语音条显示开始、停止和同页字幕', () => {
  const idle = render(false);
  expect(idle).toContain('开始听');
  expect(idle).toContain('未连接');

  const listening = render(true);
  expect(listening).toContain('停止听');
  expect(listening).toContain('正在转写');
  expect(listening).toContain('语音字幕');
  expect(listening).toContain('第一句');
  expect(listening).toContain('还在说');
  expect(listening).toContain('已开任务：查一下天气');
  expect(listening).toContain('补充：再看周末');
});

test('AudioWorklet 将 44.1 和 48 kHz 的多个输入块拼成 100 ms PCM', () => {
  for (const rate of [44_100, 48_000]) {
    const buffers: ArrayBuffer[] = [];
    class Processor {
      readonly port = {
        postMessage(buffer: ArrayBuffer) { buffers.push(buffer); },
      };
    }
    let process: ((inputs: Float32Array[][]) => boolean) | undefined;
    const register = (name: string, type: new () => { process(inputs: Float32Array[][]): boolean }) => {
      expect(name).toBe(pcm.WORKLET_NAME);
      const worker = new type();
      process = (inputs) => worker.process(inputs);
    };
    const install = new Function('AudioWorkletProcessor', 'sampleRate', 'registerProcessor', pcm.WORKLET_SOURCE);
    install(Processor, rate, register);

    for (let offset = 0; offset < rate / 10; offset += 128) {
      const size = Math.min(128, rate / 10 - offset);
      const channel = new Float32Array(size).fill(-0.5);
      process?.([[channel]]);
    }
    expect(buffers).toHaveLength(1);
    const frame = new DataView(buffers[0]!);
    expect(frame.byteLength).toBe(3200);
    expect(frame.getInt16(0, true)).toBe(-16384);
    expect(frame.getInt16(3198, true)).toBe(-16384);
  }
});

test('语音回复按原采样率排队，播放和回声尾音结束后才恢复上传', () => {
  const scheduled: number[] = [];
  const samples = new Float32Array(2);
  const source = {
    buffer: undefined as unknown,
    onended: undefined as (() => void) | undefined,
    connect() {},
    disconnect() {},
    start(at: number) { scheduled.push(at); },
  };
  const audio = {
    currentTime: 1,
    destination: {},
    createBuffer(channels: number, length: number, rate: number) {
      expect([channels, length, rate]).toEqual([1, 2, 24_000]);
      return { getChannelData: () => samples, duration: 2 / 24_000 };
    },
    createBufferSource: () => source,
  };
  const output = new playbackModule.VoicePlayback(audio as unknown as AudioContext);
  expect(output.blocksMicrophone).toBe(false);
  output.begin('spoken', 24_000);
  expect(output.blocksMicrophone).toBe(true);

  const buffer = Uint8Array.from([0, 192, 0, 64]).buffer;
  output.accept(buffer);
  expect([...samples]).toEqual([-0.5, 0.5]);
  expect(scheduled).toEqual([1.02]);
  output.end('spoken');
  expect(output.blocksMicrophone).toBe(true);
  source.onended?.();
  expect(output.blocksMicrophone).toBe(true);
  audio.currentTime = 1.3;
  expect(output.blocksMicrophone).toBe(false);
});
