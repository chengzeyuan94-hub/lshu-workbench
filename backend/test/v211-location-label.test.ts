import { describe, expect, it } from 'vitest';
import {
  createLocationLabelResolver,
  parseLocationLabel,
} from '../src/services/locationLabelService';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('电脑位置城市级解析', () => {
  it('只提取城市和行政区，不使用街道或完整地址', () => {
    expect(parseLocationLabel({
      display_name: '不应展示的完整地址',
      address: {
        city: '广州市',
        city_district: '天河区',
        road: '不应展示的街道',
        house_number: '100',
      },
    })).toBe('广州市');
    expect(parseLocationLabel({ address: { town: '昆山市', state: '江苏省' } })).toBe('昆山市');
    expect(parseLocationLabel({ display_name: '只有完整地址' })).toBeNull();
  });

  it('请求只发送两位小数坐标、城市级 zoom，并缓存同一位置', async () => {
    const calls: Array<{ url: string; userAgent: string | null }> = [];
    const resolver = createLocationLabelResolver({
      now: () => 1_000,
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({ url: String(input), userAgent: headers.get('user-agent') });
        return jsonResponse({ address: { city: '广州市', city_district: '天河区' } });
      },
    });
    const first = await resolver({ latitude: 23.129876, longitude: 113.264385 });
    const second = await resolver({ latitude: 23.129876, longitude: 113.264385 });
    expect(first).toBe('广州市');
    expect(second).toBe(first);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('lat=23.13');
    expect(calls[0].url).toContain('lon=113.26');
    expect(calls[0].url).toContain('zoom=7');
    expect(calls[0].url).not.toContain('23.129876');
    expect(calls[0].userAgent).toContain('LShuWorkbench');
  });

  it('服务关闭、上游失败或不安全地址时安全回退且不猜上海', async () => {
    const disabled = createLocationLabelResolver({ isEnabled: () => false });
    expect(await disabled({ latitude: 0, longitude: 0 })).toBe('电脑当前位置');

    const unsafeEndpoint = createLocationLabelResolver({ endpoint: 'http://example.com/reverse' });
    expect(await unsafeEndpoint({ latitude: 0, longitude: 0 })).toBe('电脑当前位置');

    const failed = createLocationLabelResolver({
      fetchImpl: async () => jsonResponse({ error: 'no result' }),
    });
    expect(await failed({ latitude: 1, longitude: 1 })).toBe('电脑当前位置');
  });
});
