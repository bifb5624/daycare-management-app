import { describe, it, expect } from 'vitest';
import {
  encodeInviteToken,
  decodeInviteToken,
  normalizeInviteCode,
  resolveIndividualExerciseValue,
  monitoringStatusFromRate,
  exercisePrimaryNumber,
} from './logic.js';

describe('invite token', () => {
  it('encode→decode で元のオブジェクトに戻る (日本語含む)', () => {
    const obj = { c: 'FAM-1234-5678', p: 5, s: 'store_a', e: 'a@b.jp', r: '長男', x: '2026-07-01' };
    const t = encodeInviteToken(obj);
    expect(typeof t).toBe('string');
    expect(t).not.toMatch(/[+/=]/); // URLセーフ
    expect(decodeInviteToken(t)).toEqual(obj);
  });
  it('不正トークンは null', () => {
    expect(decodeInviteToken('')).toBeNull();
    expect(decodeInviteToken('!!!notbase64')).toBeNull();
  });
});

describe('normalizeInviteCode', () => {
  it('小文字・記号混じりを FAM-XXXX-XXXX 形に整形', () => {
    expect(normalizeInviteCode('fam12345678')).toBe('FAM-1234-5678');
    expect(normalizeInviteCode('FAM-1234-5678')).toBe('FAM-1234-5678');
    expect(normalizeInviteCode('ab')).toBe('AB');
  });
});

describe('resolveIndividualExerciseValue (個別運動 ○→基準値)', () => {
  const inds = [{ itemId: 'walk', defaultValue: '15分' }, { itemId: 'bar', defaultValue: '10/20' }];
  it('通常運動(オブジェクトでない)は undefined', () => {
    expect(resolveIndividualExerciseValue('15分', inds)).toBeUndefined();
    expect(resolveIndividualExerciseValue('○', inds)).toBeUndefined();
  });
  it('○ は基準値に変換', () => {
    expect(resolveIndividualExerciseValue({ itemId: 'walk', value: '○' }, inds)).toBe('15分');
    expect(resolveIndividualExerciseValue({ itemId: 'bar', value: '◯' }, inds)).toBe('10/20');
  });
  it('基準値が無ければ null', () => {
    expect(resolveIndividualExerciseValue({ itemId: 'none', value: '○' }, inds)).toBeNull();
  });
  it('数値はそのまま', () => {
    expect(resolveIndividualExerciseValue({ itemId: 'walk', value: '20分' }, inds)).toBe('20分');
  });
  it('×・ー・空 は null', () => {
    expect(resolveIndividualExerciseValue({ itemId: 'walk', value: '×' }, inds)).toBeNull();
    expect(resolveIndividualExerciseValue({ itemId: 'walk', value: 'ー' }, inds)).toBeNull();
    expect(resolveIndividualExerciseValue({ itemId: 'walk', value: '' }, inds)).toBeNull();
  });
  it('circleモード(連絡帳): 実施なら○、×・空は非表示', () => {
    expect(resolveIndividualExerciseValue({ itemId: 'walk', value: '20分' }, inds, 'circle')).toBe('○');
    expect(resolveIndividualExerciseValue({ itemId: 'walk', value: '○' }, inds, 'circle')).toBe('○');
    expect(resolveIndividualExerciseValue({ itemId: 'walk', value: '×' }, inds, 'circle')).toBeNull();
  });
});

describe('monitoringStatusFromRate', () => {
  it('未通所→実施できなかった', () => { expect(monitoringStatusFromRate(0, null)).toBe('実施できなかった'); });
  it('100%→実施できた', () => { expect(monitoringStatusFromRate(5, 100)).toBe('実施できた'); });
  it('67%→概ね実施できた', () => { expect(monitoringStatusFromRate(2, 67)).toBe('概ね実施できた'); });
  it('30%→一部実施できなかった', () => { expect(monitoringStatusFromRate(1, 30)).toBe('一部実施できなかった'); });
});

describe('exercisePrimaryNumber', () => {
  it('分数・単位つきから主数値を抽出', () => {
    expect(exercisePrimaryNumber('10/20')).toBe(10);
    expect(exercisePrimaryNumber('15分')).toBe(15);
    expect(exercisePrimaryNumber('3往復')).toBe(3);
    expect(exercisePrimaryNumber('36.5')).toBe(36.5);
  });
  it('○・ー・空 は null', () => {
    expect(exercisePrimaryNumber('○')).toBeNull();
    expect(exercisePrimaryNumber('ー')).toBeNull();
    expect(exercisePrimaryNumber('')).toBeNull();
    expect(exercisePrimaryNumber(null)).toBeNull();
  });
});
