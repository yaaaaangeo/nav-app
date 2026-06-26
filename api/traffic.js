export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const ITS_KEY = process.env.ITS_KEY;
  const { minX, maxX, minY, maxY } = req.query;

  try {
    const baseUrl = 'https://openapi.its.go.kr:9443/trafficInfo';
    const qs = [
      `apiKey=${encodeURIComponent(ITS_KEY)}`,
      `type=all`,
      `getType=json`,
      `minX=${encodeURIComponent(minX)}`,
      `maxX=${encodeURIComponent(maxX)}`,
      `minY=${encodeURIComponent(minY)}`,
      `maxY=${encodeURIComponent(maxY)}`,
    ].join('&');

    const url = `${baseUrl}?${qs}`;
    const r = await fetch(url, { 
      headers: { 'Accept': 'application/json' }
    });

    if (!r.ok) throw new Error(`ITS HTTP ${r.status}`);

    const json = await r.json();

    if (json?.header?.resultCode !== 0) {
      throw new Error(json?.header?.resultMsg || 'ITS 오류');
    }

    const rows = json?.body?.items || [];
    const list = Array.isArray(rows) ? rows : [rows];
    const traffic = list.map(item => ({
      roadName:   item.roadName || '',
      linkId:     item.linkId || '',
      speed:      Number(item.speed) || 0,
      travelTime: Number(item.travelTime) || 0,
      roadType:   item.roadDrcType || 'urban',
    }));

    return res.json({
      ok: true,
      source: 'ITS',
      traffic,
      events: [],
      updatedAt: new Date().toISOString(),
      note: '교통정보 출처: 국가교통정보센터 ITS',
    });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
