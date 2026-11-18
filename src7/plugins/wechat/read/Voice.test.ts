/** 微信语音用合成样本验证 SILK 到 WAV 的实际解码。 */
import { expect, test } from 'bun:test';
import * as silk from 'silk-wasm';
import * as voiceModule from './Voice.ts';

test('把合成 SILK 解码成单声道 24 kHz WAV', async () => {
  const sampleRate = 24_000;
  const pcm = new Int16Array(sampleRate);
  for (let i = 0; i < pcm.length; i += 1) {
    pcm[i] = Math.round(8_000 * Math.sin(2 * Math.PI * 440 * i / sampleRate));
  }
  const sample = await silk.encode(pcm, sampleRate);
  const stripped = sample.data.subarray(1);
  const wav = await voiceModule.decodeVoice(stripped, 2);
  expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
  expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
  expect(wav.readUInt16LE(22)).toBe(1);
  expect(wav.readUInt32LE(24)).toBe(sampleRate);
  expect(wav.readUInt32LE(40)).toBe(pcm.byteLength);
  expect(wav.subarray(44).some((value) => value !== 0)).toBe(true);
  await expect(voiceModule.decodeVoice(sample.data, 3)).rejects.toThrow('音频时长与聊天记录不符');
});
