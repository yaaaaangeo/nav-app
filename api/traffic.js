export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(204).end();

  const ITS_KEY = process.env.ITS_KEY;
  const { minX, maxX, minY, maxY } = req.query;

  try {
    const params = new URLSearchParams({
      apiKey: ITS_KEY,
      type: 'all',
      getType: 'json',
      minX, maxX, minY, maxY,
    });
    const url = `https://openapi.its.go.kr:9443/trafficInfo?${params}`;
    const r = await fetch(url);
    const json = await r.json();

    if (json?.header?.resultCode !== 0) {
      throw new Error(json?.header?.resultMsg || '알 수 없는 오류');
    }

    const rows = json?.body?.items || [];
    const list = Array.isArray(rows) ? rows : [rows];
    const traffic = list.map(r => ({
      roadName:   r.roadName || '',
      linkId:     r.linkId || '',
      speed:      Number(r.speed) || 0,
      travelTime: Number(r.travelTime) || 0,
      roadType:   r.roadDrcType || 'urban',
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
